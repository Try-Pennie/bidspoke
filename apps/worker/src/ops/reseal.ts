/**
 * resealConnections: moves every ops connection login to the current ops kid
 * during a rotation of the ops key (#2333, phase 3 of #1689; plan: discussion
 * #2329, phase 3; runbook: docs/disaster-recovery.md, rotating the ops private
 * key, step 3).
 *
 * WHY. Each login is sealed to an ops public key named by its envelope's kid,
 * and opens only with that kid's private key. Moving CURRENT_OPS_KID moves new
 * seals to the new kid; every login already stored still names the old one, so
 * the old key cannot go until each is resealed. This opens each such login with
 * its old kid's key (opsSealKeys holds both mid rotation) and seals the SAME
 * login, at the SAME generation, to the current kid: the generation names the
 * login, which is unchanged, so nothing that keys on it moves.
 *
 * WHAT IT COVERS, in this order:
 *  1. The logins person bound connections' ConnectionTokenObjects hold in their
 *     own storage (the 2026-10-18 comment on #2333, from #2425): a rotated login
 *     waiting for its write back would otherwise reach the row under the old kid
 *     after the rows were done. Every served connection's object is asked, since
 *     nothing served says which are person bound; one holding nothing answers
 *     none. First, so a write back that lands meanwhile carries the new kid.
 *  2. The service_connections rows, the one home of each login (L83), read
 *     fresh from the bidding Worker (OPS_GATEWAY.opsConnections, ciphertext
 *     only) and written back through OPS_GATEWAY.replaceConnectionEnvelope, a
 *     compare and set on the generation and kid it read, which changes nothing
 *     when the row has moved on (replace_connection_envelope, bidding migration
 *     20261019160000).
 *
 * PREVIEWS BY DEFAULT: unless the request says apply, nothing is opened or
 * written anywhere, and the report says what would be. IDEMPOTENT: a login
 * already under the current kid is left alone, so a second run reseals nothing
 * new, and two runs at once are kept apart by the compare and set on the rows
 * and by blockConcurrencyWhile in each object. RUN AGAIN UNTIL NOTHING IS LEFT:
 * the report counts every login still under another kid or not known to be
 * current (a row that moved, a refusal, a failure, one past a per run limit),
 * and says nothing_left only when that count is zero and the list it
 * read named every ops connection.
 *
 * A CRASH between a seal and its write back writes nothing: the old envelope is
 * still the stored one, and it still opens under the old key, which is held
 * until a run reports nothing left (reseal.test.ts).
 *
 * WHO CALLS IT. OpsInternal.resealConnections (internal.ts), reached only
 * through this Worker's own SELF binding: the minute cron calls it while
 * OPS_RESEAL is set on this Worker (reseal-live.ts), and nothing else.
 * WHOSE DATA. Lane wide system work, like the tick: every organization's ops
 * connections, each opened and sealed under its own organization (the AAD binds
 * it) and written back only within it.
 *
 * WHAT LEAVES. The opened login lives only between its open and its seal, in
 * this function, and is never logged, thrown or answered; the report carries
 * counts, kids and connection ids. Nothing here writes to the console (the
 * connection-seal-open-callers guard refuses it).
 */
import { open, seal, type SealedEnvelope } from '@bidspoke/connection-seal'
import {
  OpsGatewayContractError, parseReplaceConnectionEnvelopeAnswer, parseServedOpsConnections, type ReplaceConnectionEnvelopeRequest,
  type ServedOpsConnection,
} from '../lib/ops-gateway-contract'
import type { SealKeys } from './connection-token-object'
import { parseResealLoginAnswer, type ResealLoginRequest } from './connections/token-object-contract'

/** What becomes of each service_connections row in a run. */
export const ROW_OUTCOMES = [
  'current', 'would_reseal', 'resealed', 'already_resealed', 'moved', 'not_found', 'no_key', 'open_failed', 'write_failed', 'unreadable', 'deferred',
] as const
export type RowOutcome = (typeof ROW_OUTCOMES)[number]

/** What becomes of each token object's login in a run: its state, or why it did nothing. */
export const OBJECT_OUTCOMES = [
  'none', 'current', 'would_reseal', 'resealed', 'refused', 'busy', 'no_current_kid', 'no_key', 'open_failed', 'failed',
] as const
export type ObjectOutcome = (typeof OBJECT_OUTCOMES)[number]

/** The outcomes that leave nothing to do: every other one is counted as left. */
const ROW_DONE: ReadonlySet<RowOutcome> = new Set(['current', 'resealed', 'already_resealed', 'not_found'])
const OBJECT_DONE: ReadonlySet<ObjectOutcome> = new Set(['none', 'current', 'resealed'])

/** A run's bounds: RSA-4096 opens cost a few milliseconds of CPU each. */
export interface ResealLimits {
  /** Rows resealed at most in one run; a row past it is counted as left, and the next run takes it. */
  maxRowReseals: number
  /**
   * Token object logins resealed at most in one run. Every object is still
   * asked every run: past this, an object is asked to preview, so one still
   * under an old kid answers would_reseal, is counted as left, and is resealed
   * by a later run, whatever its place in the list.
   */
  maxObjectReseals: number
}
export const RESEAL_LIMITS: ResealLimits = { maxRowReseals: 100, maxObjectReseals: 100 }

/** The most problems one report names. */
export const MAX_RESEAL_PROBLEMS = 20

export interface ResealDeps {
  /** opsSealKeys: every held kid's private key, the committed public keys, and the current kid. */
  keys: SealKeys
  /** OPS_GATEWAY.opsConnections: the served list, for parseServedOpsConnections. */
  fetchConnections(): Promise<unknown>
  /** OPS_GATEWAY.replaceConnectionEnvelope: the compare and set; an answer for parseReplaceConnectionEnvelopeAnswer. */
  replaceEnvelope(request: ReplaceConnectionEnvelopeRequest): Promise<unknown>
  /** The connection's ConnectionTokenObject.resealLogin; an answer for parseResealLoginAnswer. */
  resealObjectLogin(connectionId: string, request: ResealLoginRequest): Promise<unknown>
}

export interface ResealReport {
  ok: true
  mode: 'preview' | 'apply'
  current_kid: string
  /** The served list named every ops connection and every row in it could be read. */
  complete: boolean
  rows: Record<RowOutcome, number>
  objects: Record<ObjectOutcome, number>
  /** Logins still under another kid, or not known to be current. */
  left: number
  /** complete and nothing left: the old key can go (runbook step 4). */
  nothing_left: boolean
  /** Up to MAX_RESEAL_PROBLEMS, each a connection id and an outcome, never a value. */
  problems: string[]
}

export interface ResealRefused {
  ok: false
  /** The run's own refusals, then OpsInternal's: outside the ops lane, a request it cannot read, a binding missing. */
  refused: 'no_current_kid' | 'connections_unavailable' | 'connections_unreadable' | 'lane_refused' | 'request_invalid' | 'not_configured'
  detail: string
}

const zero = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>

/** One run. Never throws: every failure is a count, a problem or a refusal. */
export async function resealConnections(
  deps: ResealDeps, request: { apply?: boolean }, limits: ResealLimits = RESEAL_LIMITS,
): Promise<ResealReport | ResealRefused> {
  const apply = request.apply === true
  const current = deps.keys.kid
  if (current === null) return { ok: false, refused: 'no_current_kid', detail: 'no kid is current on this Worker, so nothing may be sealed' }

  let served: ReturnType<typeof parseServedOpsConnections>
  let servedRows: number
  try {
    const raw = await deps.fetchConnections()
    try {
      served = parseServedOpsConnections(raw)
      servedRows = (raw as { connections: unknown[] }).connections.length
    } catch (err) {
      // The contract's messages name a field, never a value.
      return { ok: false, refused: 'connections_unreadable', detail: err instanceof OpsGatewayContractError ? err.message : 'the connection list could not be read' }
    }
  } catch (err) {
    return { ok: false, refused: 'connections_unavailable', detail: `the bidding Worker's connection list could not be fetched (an ${err instanceof Error ? err.name : 'error'})` }
  }

  const rows = zero(ROW_OUTCOMES)
  const objects = zero(OBJECT_OUTCOMES)
  const problems: string[] = []
  const note = (what: string, outcome: string) => { if (problems.length < MAX_RESEAL_PROBLEMS) problems.push(`${what}: ${outcome}`) }
  const connections = served.list.connections

  for (const c of connections) {
    const outcome = await resealObject(deps, c, apply && objects.resealed < limits.maxObjectReseals)
    objects[outcome] += 1
    if (!OBJECT_DONE.has(outcome) && outcome !== 'would_reseal') note(`token object ${c.id}`, outcome)
  }

  let resealed = 0
  for (const c of connections) {
    let outcome: RowOutcome
    if (c.envelope.kid === current) outcome = 'current'
    else if (!Object.hasOwn(deps.keys.privateKeys, c.envelope.kid)) outcome = 'no_key'
    else if (!apply) outcome = 'would_reseal'
    else if (resealed >= limits.maxRowReseals) outcome = 'deferred'
    else {
      resealed += 1
      outcome = await resealRow(deps, c, current)
    }
    rows[outcome] += 1
    if (!ROW_DONE.has(outcome) && outcome !== 'would_reseal' && outcome !== 'deferred') note(`connection ${c.id}`, outcome)
  }
  // A served row the parse refused is a login whose kid is not known, so it is left.
  rows.unreadable = servedRows - connections.length
  if (rows.unreadable > 0) note('the served list', `${rows.unreadable} unreadable`)

  const left = Object.entries(rows).reduce((n, [k, v]) => n + (ROW_DONE.has(k as RowOutcome) ? 0 : v), 0)
    + Object.entries(objects).reduce((n, [k, v]) => n + (OBJECT_DONE.has(k as ObjectOutcome) ? 0 : v), 0)
  const complete = served.list.complete
  return { ok: true, mode: apply ? 'apply' : 'preview', current_kid: current, complete, rows, objects, left, nothing_left: complete && left === 0, problems }
}

async function resealObject(deps: ResealDeps, c: ServedOpsConnection, apply: boolean): Promise<ObjectOutcome> {
  try {
    const answer = parseResealLoginAnswer(await deps.resealObjectLogin(c.id, { organizationId: c.organization_id, connectionId: c.id, service: c.service, apply }))
    return answer.ok ? answer.state : answer.reason
  } catch {
    return 'failed'
  }
}

async function resealRow(deps: ResealDeps, c: ServedOpsConnection, current: string): Promise<RowOutcome> {
  const binding = { organization_id: c.organization_id, connection_id: c.id, service: c.service, generation: c.generation }
  let envelope: SealedEnvelope
  try {
    const plaintext = await open(deps.keys.privateKeys, c.envelope, { ...binding, kid: c.envelope.kid })
    envelope = await seal(deps.keys.publicKeys, plaintext, { ...binding, kid: current })
  } catch {
    return 'open_failed'
  }
  try {
    const answer = parseReplaceConnectionEnvelopeAnswer(await deps.replaceEnvelope({
      organization_id: c.organization_id,
      connection_id: c.id,
      expected_kid: c.envelope.kid,
      expected_generation: c.generation,
      envelope,
    }))
    switch (answer.outcome) {
      case 'replaced': return 'resealed'
      case 'already_replaced': return 'already_resealed'
      case 'moved': return 'moved'
      case 'not_found': return 'not_found'
    }
  } catch {
    // Nothing is known to have been written; the old envelope still opens under the old key.
    return 'write_failed'
  }
}
