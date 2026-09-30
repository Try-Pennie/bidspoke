/**
 * LeadSaleObject (#1410, milestone 52): one SQLite backed object per lead,
 * `idFromName('sale:' + kind + ':' + population + ':' + lead_key)`, so a
 * rehearsal claim lives in its own namespace and can never block a live sale.
 *
 * It is the claim that stops one lead being sold twice (L157, L151). States:
 *   free                        nobody holds the lead
 *   in_flight (partner, execution, since, deadline)   an attempt is underway
 *   sold (partner, outcome)     the whole normalised outcome, so a replay hands
 *                               back the same result code it wrote the first time
 *   in_doubt (partner)          an attempt held the lead past its deadline and
 *                               never said what happened; the ledger decides
 *
 * Every state carries a GENERATION that moves on every transition, and every
 * mutation is a compare and set on the generation the caller read. A mutation
 * whose generation has moved is refused with the current state, and the caller
 * re-reads. The generation check comes before the state check, so a stale
 * caller is told the world moved rather than which rule it broke.
 *
 * Time comes from `this.clock`, real in production and replaced by tests.
 */
import { jsonResponse, readJsonObject } from '../lib/do-json'
import { parseOutcome, type SaleOutcomeRecord } from './sale-outcome'
import { asInteger, asIntegerOrNull, asText, asTextOrNull } from './sql-values'

export type SaleState =
  | { state: 'free'; generation: number }
  /** `deadline_ms` from `since` is when a rival claim finds it in doubt (#1552: a person's release reads it). */
  | { state: 'in_flight'; partner_id: string; execution_id: string; since: number; deadline_ms: number; generation: number }
  | { state: 'sold'; partner_id: string; outcome: SaleOutcomeRecord; generation: number }
  | { state: 'in_doubt'; partner_id: string; generation: number }

export interface ClaimBody {
  partner_id: string
  execution_id: string
  /** How long the holder may stay in flight before the claim is in doubt. */
  deadline_ms: number
}

export type ClaimResult =
  | { state: 'claimed'; generation: number }
  | { state: 'sold'; partner_id: string; outcome: SaleOutcomeRecord; generation: number }
  /**
   * `expired_in_flight` is present, and true, only on the answer to the claim
   * that found the holder past its deadline and moved it to in_doubt (#1643).
   * A claim that finds it already in doubt did not cause the expiry and carries
   * nothing, so each expiry is counted by exactly one claimer.
   */
  | { state: 'in_doubt'; partner_id: string; generation: number; expired_in_flight?: true }
  | { state: 'in_flight'; holder_execution_id: string; since: number; generation: number }

type Row = Record<string, SqlStorageValue>

interface Stored {
  state: SaleState['state']
  partner_id: string | null
  execution_id: string | null
  since: number | null
  deadline_ms: number | null
  generation: number
  outcome: SaleOutcomeRecord | null
}

const FREE: Stored = { state: 'free', partner_id: null, execution_id: null, since: null, deadline_ms: null, generation: 0, outcome: null }

export class LeadSaleObject implements DurableObject {
  private readonly sql: SqlStorage
  /** Replaced by tests through runInDurableObject; production never touches it. */
  clock: () => number = () => Date.now()

  constructor(state: DurableObjectState) {
    this.sql = state.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS claim (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        state         TEXT    NOT NULL,
        partner_id    TEXT,
        execution_id  TEXT,
        since         INTEGER,
        deadline_ms   INTEGER,
        generation    INTEGER NOT NULL,
        outcome_json  TEXT
      )
    `)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/claim': return this.handleClaim(request)
      case '/sold': return this.handleMutation(request, 'sold')
      case '/free': return this.handleMutation(request, 'free')
      case '/heal': return this.handleMutation(request, 'heal')
      case '/read': return jsonResponse<SaleState>(publicState(this.load()))
      default: return jsonResponse({ error: 'not_found', path: url.pathname }, 404)
    }
  }

  private async handleClaim(request: Request): Promise<Response> {
    const body = await readJsonObject(request)
    if (!body) return jsonResponse({ error: 'bad_body' }, 400)
    const { partner_id, execution_id, deadline_ms } = body
    if (typeof partner_id !== 'string' || partner_id === '') return jsonResponse({ error: 'bad_partner_id' }, 400)
    if (typeof execution_id !== 'string' || execution_id === '') return jsonResponse({ error: 'bad_execution_id' }, 400)
    if (typeof deadline_ms !== 'number' || !Number.isInteger(deadline_ms) || deadline_ms <= 0) return jsonResponse({ error: 'bad_deadline' }, 400)

    const now = this.clock()
    const current = this.load()
    switch (current.state) {
      case 'free': {
        const next: Stored = { state: 'in_flight', partner_id, execution_id, since: now, deadline_ms, generation: current.generation + 1, outcome: null }
        this.save(next)
        return jsonResponse<ClaimResult>({ state: 'claimed', generation: next.generation })
      }
      case 'in_flight': {
        if (current.execution_id === execution_id) {
          return jsonResponse<ClaimResult>({ state: 'claimed', generation: current.generation })
        }
        const since = current.since ?? now
        if (since + (current.deadline_ms ?? 0) <= now) {
          const next: Stored = { ...current, state: 'in_doubt', execution_id: null, since: null, deadline_ms: null, generation: current.generation + 1 }
          this.save(next)
          return jsonResponse<ClaimResult>({ state: 'in_doubt', partner_id: String(current.partner_id), generation: next.generation, expired_in_flight: true })
        }
        return jsonResponse<ClaimResult>({ state: 'in_flight', holder_execution_id: String(current.execution_id), since, generation: current.generation })
      }
      case 'sold':
        return jsonResponse<ClaimResult>({ state: 'sold', partner_id: String(current.partner_id), outcome: current.outcome as SaleOutcomeRecord, generation: current.generation })
      case 'in_doubt':
        return jsonResponse<ClaimResult>({ state: 'in_doubt', partner_id: String(current.partner_id), generation: current.generation })
    }
  }

  /**
   * sold: in_flight to sold with the outcome.  free: in_flight or in_doubt to
   * free.  heal: in_doubt to sold with the outcome the ledger recorded, or with
   * the buyer's lead id a person confirmed (#1552).
   *
   * heal also takes an in_flight claim whose deadline has passed (#1552). Such a
   * claim is in doubt in all but name: only a rival claim renames it, and a
   * click whose send had no readable answer may never see another click, so a
   * person marking it sent would otherwise be refused by a label. One inside its
   * deadline is still refused, because its send may yet answer.
   */
  private async handleMutation(request: Request, op: 'sold' | 'free' | 'heal'): Promise<Response> {
    const body = await readJsonObject(request)
    if (!body) return jsonResponse({ error: 'bad_body' }, 400)
    const { generation } = body
    if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) return jsonResponse({ error: 'bad_generation' }, 400)
    const outcome = op === 'free' ? null : parseOutcome(body.outcome)
    if (op !== 'free' && !outcome) return jsonResponse({ error: 'bad_outcome' }, 400)

    const current = this.load()
    if (current.generation !== generation) {
      return jsonResponse({ error: 'generation_moved', current: publicState(current) }, 409)
    }
    const allowed: Record<typeof op, SaleState['state'][]> = {
      sold: ['in_flight'],
      free: ['in_flight', 'in_doubt'],
      heal: ['in_doubt'],
    }
    const lapsedInFlight = op === 'heal' && current.state === 'in_flight' && (current.since ?? 0) + (current.deadline_ms ?? 0) <= this.clock()
    if (!allowed[op].includes(current.state) && !lapsedInFlight) {
      return jsonResponse({ error: 'wrong_state', current: publicState(current) }, 409)
    }
    const next: Stored = op === 'free'
      ? { ...FREE, generation: current.generation + 1 }
      : { state: 'sold', partner_id: current.partner_id, execution_id: null, since: null, deadline_ms: null, generation: current.generation + 1, outcome }
    this.save(next)
    return jsonResponse({ ok: true, generation: next.generation })
  }

  private load(): Stored {
    const rows = this.sql.exec<Row>('SELECT * FROM claim WHERE id = 1').toArray()
    const row = rows[0]
    if (!row) return FREE
    const outcomeJson = asTextOrNull(row.outcome_json, 'outcome_json')
    return {
      state: asText(row.state, 'state') as SaleState['state'],
      partner_id: asTextOrNull(row.partner_id, 'partner_id'),
      execution_id: asTextOrNull(row.execution_id, 'execution_id'),
      since: asIntegerOrNull(row.since, 'since'),
      deadline_ms: asIntegerOrNull(row.deadline_ms, 'deadline_ms'),
      generation: asInteger(row.generation, 'generation'),
      outcome: outcomeJson === null ? null : (JSON.parse(outcomeJson) as SaleOutcomeRecord),
    }
  }

  private save(next: Stored): void {
    this.sql.exec(
      `INSERT INTO claim (id, state, partner_id, execution_id, since, deadline_ms, generation, outcome_json)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         state = excluded.state, partner_id = excluded.partner_id, execution_id = excluded.execution_id,
         since = excluded.since, deadline_ms = excluded.deadline_ms, generation = excluded.generation,
         outcome_json = excluded.outcome_json`,
      next.state, next.partner_id, next.execution_id, next.since, next.deadline_ms, next.generation,
      next.outcome ? JSON.stringify(next.outcome) : null
    )
  }
}

function publicState(s: Stored): SaleState {
  switch (s.state) {
    case 'free': return { state: 'free', generation: s.generation }
    case 'in_flight': return { state: 'in_flight', partner_id: String(s.partner_id), execution_id: String(s.execution_id), since: Number(s.since), deadline_ms: Number(s.deadline_ms), generation: s.generation }
    case 'sold': return { state: 'sold', partner_id: String(s.partner_id), outcome: s.outcome as SaleOutcomeRecord, generation: s.generation }
    case 'in_doubt': return { state: 'in_doubt', partner_id: String(s.partner_id), generation: s.generation }
  }
}
