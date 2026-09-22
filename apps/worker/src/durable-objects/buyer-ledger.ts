/**
 * BuyerLedgerObject (#1410, milestone 52): one SQLite backed object per buyer,
 * `idFromName('buyer:' + partner_id)`, keyed on the partner id and never the
 * slug (L15). It holds every reservation and outcome the buyer_select node
 * makes against that buyer, and answers the cap question from what it holds:
 * a slot is reserved BEFORE the buyer is called and counts until it is
 * released, so two leads racing for the last slot cannot both take it.
 *
 * Counting rule (`counted()`): reserved, accepted and unresolved entries count
 * against every cap; declined and released ones do not. `reserve`, `peek` and
 * `summary` all read that one predicate (L16).
 *
 * Time comes from `this.clock`, which defaults to the real clock and which a
 * test replaces through runInDurableObject (L524). Nothing here reads a caller
 * supplied instant, so a skewed caller cannot move a lead into another hour or
 * day. Hours are UTC epoch hours and days are Eastern, through the shared clock
 * helpers (L39).
 *
 * The alarm turns a reservation still pending after PENDING_GRACE_MS into
 * `unresolved`: it keeps counting, it is reported by `unresolved`, and only a
 * `settle` moves it on. The alarm also prunes entries older than RETENTION_MS,
 * but only ones that are both resolved and mirrored (L5); an unresolved entry
 * is never pruned.
 */
import {
  LEDGER_KINDS,
  POPULATIONS,
  easternParts,
  hourBucket,
  type LedgerKind,
  type OutReason,
  type Population,
  type SaleStatus,
} from '@bidspoke/buyer-profile'
import { jsonResponse, readJsonObject } from '../lib/do-json'
import { parseOutcome, type SaleOutcomeRecord } from './sale-outcome'
import { asInteger, asIntegerOrNull, asText, asTextOrNull } from './sql-values'

export type { SaleOutcomeRecord } from './sale-outcome'

/** A pending reservation older than this is unresolved. The buyer call itself is bounded at 20 seconds. */
export const PENDING_GRACE_MS = 120_000
/** Decided on #1407: ninety days. Applies only to resolved AND mirrored entries. */
export const RETENTION_MS = 90 * 24 * 3_600_000

export interface CapLimits {
  hourly_lead_cap: number | null
  daily_lead_cap: number | null
  hourly_spend_cap_cents: number | null
  daily_spend_cap_cents: number | null
}

/** The refusal names are the shared out reason vocabulary, so the execution view labels them (L89). */
export type CapReason = Extract<OutReason, 'hourly_lead_cap' | 'daily_lead_cap' | 'hourly_spend_cap' | 'daily_spend_cap'>

export interface EntryKey {
  lead_key: string
  population: Population
  kind: LedgerKind
}

export interface LedgerEntry extends EntryKey {
  payout_cents: number
  status: SaleStatus
  et_day: string
  hour_bucket: number
  reserved_at: number
  resolved_at: number | null
  mirrored: boolean
  execution_id: string
  outcome: SaleOutcomeRecord | null
  /**
   * How the entry left `reserved` or `unresolved` (#1412, L83): 'buyer' for an
   * answer the buyer gave, 'rehearsal' for a decide_only commit, 'settled' for a
   * person's decision through the settle route. Null while reserved.
   */
  resolution_source: ResolutionSource | null
  /** The user id of the person who settled it; null for every other source. */
  resolved_by: string | null
}

export type ResolutionSource = 'buyer' | 'rehearsal' | 'settled'

export interface Counts {
  hour_leads: number
  day_leads: number
  hour_spend_cents: number
  day_spend_cents: number
  et_day: string
  hour_bucket: number
}

export interface ReserveBody extends EntryKey {
  payout_cents: number
  execution_id: string
  limits: CapLimits
}

export type ReserveResult =
  | { reserved: true; repeat: boolean; entry: LedgerEntry; counts: Counts }
  | { reserved: false; reason: CapReason; limit: number; counts: Counts }

export interface CommitBody extends EntryKey {
  outcome: SaleOutcomeRecord
}

export interface ReleaseBody extends EntryKey {
  status: 'declined' | 'released'
}

export interface SettleBody extends EntryKey {
  status: 'accepted' | 'declined' | 'released'
  outcome?: SaleOutcomeRecord
  /** The user id of the person settling, recorded on the entry for the mirror (#1412). */
  resolved_by?: string
}

export type EntryResult = { found: true; entry: LedgerEntry } | { found: false }

export interface Summary {
  et_day: string
  by_status: Record<SaleStatus, number>
  counted_leads: number
  counted_spend_cents: number
}

export interface UnmirroredResult {
  entries: LedgerEntry[]
  oldest_age_ms: number | null
}

type Row = Record<string, SqlStorageValue>

const COUNTED_STATUSES = "('reserved', 'accepted', 'unresolved')"

export class BuyerLedgerObject implements DurableObject {
  private readonly sql: SqlStorage
  private readonly storage: DurableObjectStorage
  /** Replaced by tests through runInDurableObject; production never touches it. */
  clock: () => number = () => Date.now()

  constructor(state: DurableObjectState) {
    this.storage = state.storage
    this.sql = state.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        lead_key      TEXT    NOT NULL,
        population    TEXT    NOT NULL,
        kind          TEXT    NOT NULL,
        payout_cents  INTEGER NOT NULL,
        status        TEXT    NOT NULL,
        et_day        TEXT    NOT NULL,
        hour_bucket   INTEGER NOT NULL,
        reserved_at   INTEGER NOT NULL,
        resolved_at   INTEGER,
        mirrored      INTEGER NOT NULL DEFAULT 0,
        execution_id  TEXT    NOT NULL,
        outcome_json  TEXT,
        PRIMARY KEY (lead_key, population, kind)
      )
    `)
    this.sql.exec('CREATE INDEX IF NOT EXISTS entries_kind_status ON entries (kind, status)')
    // Two columns added after the first deploy (#1412). SQLite has no ADD COLUMN IF
    // NOT EXISTS, so the table's own column list decides, and an object created
    // before the columns existed gains them on its next wake.
    const columns = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(entries)').toArray().map((r) => r.name))
    if (!columns.has('resolution_source')) this.sql.exec('ALTER TABLE entries ADD COLUMN resolution_source TEXT')
    if (!columns.has('resolved_by')) this.sql.exec('ALTER TABLE entries ADD COLUMN resolved_by TEXT')
    this.sql.exec('CREATE INDEX IF NOT EXISTS entries_kind_day ON entries (kind, et_day)')
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/reserve': return this.handleReserve(request)
      case '/commit': return this.handleCommit(request)
      case '/release': return this.handleRelease(request)
      case '/settle': return this.handleSettle(request)
      case '/entry': return this.handleEntry(url)
      case '/peek': return this.handlePeek(url)
      case '/summary': return this.handleSummary(url)
      case '/unmirrored': return this.handleUnmirrored()
      case '/unresolved': return this.handleUnresolved()
      case '/mark-mirrored': return this.handleMarkMirrored(request)
      default: return jsonResponse({ error: 'not_found', path: url.pathname }, 404)
    }
  }

  // ── Counting ────────────────────────────────────────────────────────────────

  /** The one predicate every cap answer reads (L16). */
  private counted(kind: LedgerKind, now: number): Counts {
    const et_day = easternParts(now).date
    const hour_bucket = hourBucket(now)
    const row = this.sql
      .exec<Row>(
        `SELECT
           COALESCE(SUM(CASE WHEN hour_bucket = ? THEN 1 ELSE 0 END), 0) AS hour_leads,
           COALESCE(SUM(CASE WHEN et_day = ? THEN 1 ELSE 0 END), 0) AS day_leads,
           COALESCE(SUM(CASE WHEN hour_bucket = ? THEN payout_cents ELSE 0 END), 0) AS hour_spend,
           COALESCE(SUM(CASE WHEN et_day = ? THEN payout_cents ELSE 0 END), 0) AS day_spend
         FROM entries
         WHERE kind = ? AND status IN ${COUNTED_STATUSES}`,
        hour_bucket, et_day, hour_bucket, et_day, kind
      )
      .one()
    return {
      hour_leads: Number(row.hour_leads),
      day_leads: Number(row.day_leads),
      hour_spend_cents: Number(row.hour_spend),
      day_spend_cents: Number(row.day_spend),
      et_day,
      hour_bucket,
    }
  }

  /** Which limit refuses one more lead at `payout_cents`, checked in the order the profile lists them. */
  private refusal(counts: Counts, limits: CapLimits, payoutCents: number): { reason: CapReason; limit: number } | null {
    const checks: Array<[CapReason, number | null, number]> = [
      ['hourly_lead_cap', limits.hourly_lead_cap, counts.hour_leads + 1],
      ['daily_lead_cap', limits.daily_lead_cap, counts.day_leads + 1],
      ['hourly_spend_cap', limits.hourly_spend_cap_cents, counts.hour_spend_cents + payoutCents],
      ['daily_spend_cap', limits.daily_spend_cap_cents, counts.day_spend_cents + payoutCents],
    ]
    for (const [reason, limit, wouldBe] of checks) {
      if (limit !== null && wouldBe > limit) return { reason, limit }
    }
    return null
  }

  // ── Routes ──────────────────────────────────────────────────────────────────

  private async handleReserve(request: Request): Promise<Response> {
    const body = await readJsonObject(request)
    const key = body && parseKey(body)
    if (!body || !key) return jsonResponse({ error: 'bad_key' }, 400)
    const payout = body.payout_cents
    if (typeof payout !== 'number' || !Number.isInteger(payout) || payout < 0) return jsonResponse({ error: 'bad_payout' }, 400)
    if (typeof body.execution_id !== 'string' || body.execution_id === '') return jsonResponse({ error: 'bad_execution_id' }, 400)
    const limits = parseLimits(body.limits)
    if (!limits) return jsonResponse({ error: 'bad_limits' }, 400)

    const now = this.clock()
    const existing = this.entry(key)
    if (existing) {
      return jsonResponse<ReserveResult>({ reserved: true, repeat: true, entry: existing, counts: this.counted(key.kind, now) })
    }
    const counts = this.counted(key.kind, now)
    const refused = this.refusal(counts, limits, payout)
    if (refused) return jsonResponse<ReserveResult>({ reserved: false, ...refused, counts })

    this.sql.exec(
      `INSERT INTO entries (lead_key, population, kind, payout_cents, status, et_day, hour_bucket, reserved_at, resolved_at, mirrored, execution_id, outcome_json)
       VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, NULL, 0, ?, NULL)`,
      key.lead_key, key.population, key.kind, payout, counts.et_day, counts.hour_bucket, now, body.execution_id
    )
    await this.rearm()
    const entry = this.entry(key)
    if (!entry) return jsonResponse({ error: 'insert_not_visible' }, 500)
    return jsonResponse<ReserveResult>({ reserved: true, repeat: false, entry, counts: this.counted(key.kind, now) })
  }

  private async handleCommit(request: Request): Promise<Response> {
    const body = await readJsonObject(request)
    const key = body && parseKey(body)
    if (!body || !key) return jsonResponse({ error: 'bad_key' }, 400)
    const outcome = parseOutcome(body.outcome)
    if (!outcome) return jsonResponse({ error: 'bad_outcome' }, 400)
    return this.transition(key, ['reserved'], 'accepted', outcome, { source: sourceForKind(key.kind), resolvedBy: null })
  }

  private async handleRelease(request: Request): Promise<Response> {
    const body = await readJsonObject(request)
    const key = body && parseKey(body)
    if (!body || !key) return jsonResponse({ error: 'bad_key' }, 400)
    if (body.status !== 'declined' && body.status !== 'released') return jsonResponse({ error: 'bad_status' }, 400)
    return this.transition(key, ['reserved'], body.status, null, { source: sourceForKind(key.kind), resolvedBy: null })
  }

  private async handleSettle(request: Request): Promise<Response> {
    const body = await readJsonObject(request)
    const key = body && parseKey(body)
    if (!body || !key) return jsonResponse({ error: 'bad_key' }, 400)
    if (body.status !== 'accepted' && body.status !== 'declined' && body.status !== 'released') return jsonResponse({ error: 'bad_status' }, 400)
    const outcome = body.outcome === undefined ? null : parseOutcome(body.outcome)
    if (body.status === 'accepted' && !outcome) return jsonResponse({ error: 'accepted_needs_outcome' }, 400)
    if (body.outcome !== undefined && !outcome) return jsonResponse({ error: 'bad_outcome' }, 400)
    // A settlement is a person's decision (#1412): the route hands their user id
    // in, the entry keeps it, and the mirror carries it to buyer_sales (L83).
    if (body.resolved_by !== undefined && (typeof body.resolved_by !== 'string' || !UUID_RE.test(body.resolved_by))) {
      return jsonResponse({ error: 'bad_resolved_by' }, 400)
    }
    return this.transition(key, ['unresolved'], body.status, outcome, { source: 'settled', resolvedBy: typeof body.resolved_by === 'string' ? body.resolved_by : null })
  }

  /**
   * Move one entry from one of `from` to `to`. Refuses by name when the entry is
   * absent (404) or in another state (409, naming the state it is in), so a
   * caller cannot mistake either for success (L11).
   */
  private transition(
    key: EntryKey,
    from: SaleStatus[],
    to: SaleStatus,
    outcome: SaleOutcomeRecord | null,
    resolution: { source: ResolutionSource; resolvedBy: string | null }
  ): Response {
    const current = this.entry(key)
    if (!current) return jsonResponse({ error: 'absent' }, 404)
    if (!from.includes(current.status)) {
      return jsonResponse({ error: 'wrong_status', status: current.status, entry: current }, 409)
    }
    const now = this.clock()
    const payout = outcome ? outcome.payout_cents : current.payout_cents
    // Every state change clears `mirrored`: the mirror copy of the previous state
    // may already have been delivered, and the drain must carry the new one too,
    // or a settlement after a mirrored `unresolved` never reaches buyer_sales (#1412).
    this.sql.exec(
      `UPDATE entries SET status = ?, resolved_at = ?, outcome_json = ?, payout_cents = ?, mirrored = 0,
         resolution_source = ?, resolved_by = ?
       WHERE lead_key = ? AND population = ? AND kind = ?`,
      to, now, outcome ? JSON.stringify(outcome) : null, payout, resolution.source, resolution.resolvedBy, key.lead_key, key.population, key.kind
    )
    const entry = this.entry(key)
    return jsonResponse({ ok: true, entry })
  }

  private handleEntry(url: URL): Response {
    const key = parseKey(Object.fromEntries(url.searchParams))
    if (!key) return jsonResponse({ error: 'bad_key' }, 400)
    const entry = this.entry(key)
    return jsonResponse<EntryResult>(entry ? { found: true, entry } : { found: false })
  }

  private handlePeek(url: URL): Response {
    const kind = url.searchParams.get('kind')
    if (!isKind(kind)) return jsonResponse({ error: 'bad_kind' }, 400)
    return jsonResponse<Counts>(this.counted(kind, this.clock()))
  }

  private handleSummary(url: URL): Response {
    const kind = url.searchParams.get('kind')
    if (!isKind(kind)) return jsonResponse({ error: 'bad_kind' }, 400)
    const day = url.searchParams.get('day') ?? easternParts(this.clock()).date
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return jsonResponse({ error: 'bad_day' }, 400)
    const by_status: Record<SaleStatus, number> = { reserved: 0, accepted: 0, declined: 0, released: 0, unresolved: 0 }
    for (const row of this.sql.exec<Row>('SELECT status, COUNT(*) AS n FROM entries WHERE kind = ? AND et_day = ? GROUP BY status', kind, day)) {
      by_status[row.status as SaleStatus] = Number(row.n)
    }
    const counted = this.sql
      .exec<Row>(
        `SELECT COUNT(*) AS leads, COALESCE(SUM(payout_cents), 0) AS spend FROM entries
         WHERE kind = ? AND et_day = ? AND status IN ${COUNTED_STATUSES}`,
        kind, day
      )
      .one()
    return jsonResponse<Summary>({
      et_day: day,
      by_status,
      counted_leads: Number(counted.leads),
      counted_spend_cents: Number(counted.spend),
    })
  }

  private handleUnmirrored(): Response {
    const now = this.clock()
    const entries = this.rows("SELECT * FROM entries WHERE mirrored = 0 ORDER BY reserved_at ASC")
    const oldest = entries[0]
    return jsonResponse<UnmirroredResult>({ entries, oldest_age_ms: oldest ? now - oldest.reserved_at : null })
  }

  private handleUnresolved(): Response {
    return jsonResponse({ entries: this.rows("SELECT * FROM entries WHERE status = 'unresolved' ORDER BY reserved_at ASC") })
  }

  private async handleMarkMirrored(request: Request): Promise<Response> {
    const body = await readJsonObject(request)
    if (!body || !Array.isArray(body.keys)) return jsonResponse({ error: 'bad_keys' }, 400)
    let marked = 0
    for (const raw of body.keys) {
      const key = raw && typeof raw === 'object' ? parseKey(raw as Record<string, unknown>) : null
      if (!key) return jsonResponse({ error: 'bad_keys' }, 400)
      const cursor = this.sql.exec(
        'UPDATE entries SET mirrored = 1 WHERE lead_key = ? AND population = ? AND kind = ? AND mirrored = 0',
        key.lead_key, key.population, key.kind
      )
      marked += cursor.rowsWritten
    }
    // A newly mirrored resolved entry has a retention deadline the alarm must meet.
    await this.rearm()
    return jsonResponse({ marked })
  }

  // ── Alarm ───────────────────────────────────────────────────────────────────

  /**
   * The alarm has two jobs, so it is armed for whichever comes first: the oldest
   * pending reservation's grace deadline, or the oldest mirrored resolved entry's
   * retention deadline. Nothing to do means no alarm.
   */
  private async rearm(): Promise<void> {
    const row = this.sql
      .exec<Row>(
        `SELECT
           (SELECT MIN(reserved_at) FROM entries WHERE status = 'reserved') AS oldest_pending,
           (SELECT MIN(resolved_at) FROM entries WHERE mirrored = 1 AND resolved_at IS NOT NULL
              AND status IN ('accepted', 'declined', 'released')) AS oldest_prunable`
      )
      .one()
    const candidates: number[] = []
    if (row.oldest_pending !== null) candidates.push(Number(row.oldest_pending) + PENDING_GRACE_MS)
    if (row.oldest_prunable !== null) candidates.push(Number(row.oldest_prunable) + RETENTION_MS)
    if (candidates.length === 0) {
      await this.storage.deleteAlarm()
      return
    }
    const at = Math.min(...candidates)
    const current = await this.storage.getAlarm()
    if (current !== at) await this.storage.setAlarm(at)
  }

  async alarm(): Promise<void> {
    const now = this.clock()
    this.sql.exec(
      // mirrored is cleared with the status, as every state change does (#1412):
      // a reservation the drain already delivered must be delivered again as unresolved.
      "UPDATE entries SET status = 'unresolved', mirrored = 0 WHERE status = 'reserved' AND reserved_at + ? <= ?",
      PENDING_GRACE_MS, now
    )
    this.sql.exec(
      `DELETE FROM entries WHERE mirrored = 1 AND resolved_at IS NOT NULL AND status IN ('accepted', 'declined', 'released')
       AND resolved_at + ? <= ?`,
      RETENTION_MS, now
    )
    await this.rearm()
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  private entry(key: EntryKey): LedgerEntry | null {
    const rows = this.rows(
      'SELECT * FROM entries WHERE lead_key = ? AND population = ? AND kind = ?',
      key.lead_key, key.population, key.kind
    )
    return rows[0] ?? null
  }

  private rows(query: string, ...bindings: SqlStorageValue[]): LedgerEntry[] {
    return this.sql.exec<Row>(query, ...bindings).toArray().map(rowToEntry)
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function isKind(value: unknown): value is LedgerKind {
  return typeof value === 'string' && (LEDGER_KINDS as readonly string[]).includes(value)
}

function isPopulation(value: unknown): value is Population {
  return typeof value === 'string' && (POPULATIONS as readonly string[]).includes(value)
}

export function parseKey(body: Record<string, unknown>): EntryKey | null {
  const { lead_key, population, kind } = body
  if (typeof lead_key !== 'string' || lead_key === '') return null
  if (!isPopulation(population) || !isKind(kind)) return null
  return { lead_key, population, kind }
}

function parseLimits(value: unknown): CapLimits | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const out: Partial<CapLimits> = {}
  for (const name of ['hourly_lead_cap', 'daily_lead_cap', 'hourly_spend_cap_cents', 'daily_spend_cap_cents'] as const) {
    const n = v[name]
    if (n === null) out[name] = null
    else if (typeof n === 'number' && Number.isInteger(n) && n > 0) out[name] = n
    else return null
  }
  return out as CapLimits
}

function rowToEntry(row: Row): LedgerEntry {
  const outcomeJson = asTextOrNull(row.outcome_json, 'outcome_json')
  return {
    lead_key: asText(row.lead_key, 'lead_key'),
    population: asText(row.population, 'population') as Population,
    kind: asText(row.kind, 'kind') as LedgerKind,
    payout_cents: asInteger(row.payout_cents, 'payout_cents'),
    status: asText(row.status, 'status') as SaleStatus,
    et_day: asText(row.et_day, 'et_day'),
    hour_bucket: asInteger(row.hour_bucket, 'hour_bucket'),
    reserved_at: asInteger(row.reserved_at, 'reserved_at'),
    resolved_at: asIntegerOrNull(row.resolved_at, 'resolved_at'),
    mirrored: asInteger(row.mirrored, 'mirrored') === 1,
    execution_id: asText(row.execution_id, 'execution_id'),
    outcome: outcomeJson === null ? null : (JSON.parse(outcomeJson) as SaleOutcomeRecord),
    resolution_source: (row.resolution_source === undefined ? null : asTextOrNull(row.resolution_source, 'resolution_source')) as ResolutionSource | null,
    resolved_by: row.resolved_by === undefined ? null : asTextOrNull(row.resolved_by, 'resolved_by'),
  }
}

/** A buyer's answer resolves a live entry; a decide_only commit resolves a rehearsal one. */
function sourceForKind(kind: LedgerKind): ResolutionSource {
  return kind === 'rehearsal' ? 'rehearsal' : 'buyer'
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
