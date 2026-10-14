/**
 * The incident outbox (#2099, #818): where an alert's incident transitions are
 * written first, as one KV key per event, for the drain (incident-drain.ts) to
 * move into the database's alert_incidents table later.
 *
 * KV rather than the database because three of the signals happen exactly while
 * the database is failing (it is unreachable, short of memory, or leads are
 * being served from stored copies). A record written straight to Postgres on
 * the alert path would lose the incidents that matter most, and would add a
 * database write to a path that must work when the database does not. The same
 * reasoning as the stored copy ledger (stored-copy-ledger.ts).
 *
 * Recording never stands in the way of an alert: every write here is caught,
 * reported through the caller's `onRecordError` (or the log when it gave none),
 * and the caller carries on. A lost event degrades the record, never a page or
 * an all-clear. The drain's SQL is written so a lost event leaves a gap the
 * next event repairs (a page or an end for an incident whose opening was lost
 * still creates it), and an incident whose end was lost closes as lapsed, with
 * no end time invented for it.
 *
 * Keys sort by the time they were written (`incident-outbox:<ms>:<seq>:<id>`),
 * so the drain applies them in order; its SQL does not depend on that order
 * across isolates, which KV cannot promise.
 */
import { formatErr } from './format-error'
import { incidentSignal, isIncidentSignal, INCIDENT_END_REASONS, type IncidentEndReason, type IncidentSignal } from './incident-signals'

export const INCIDENT_OUTBOX_PREFIX = 'incident-outbox:'
const EVENT_VERSION = 1

/** Whose an incident is. Required on every recording, with no default (see incident-signals.ts). */
export type IncidentScope = { kind: 'org'; organizationId: string } | { kind: 'platform' }

/** What every recording call carries about the incident besides its signal and subject. */
export interface IncidentContext {
  scope: IncidentScope
  /** The subject as a reader knows it (a workflow name, a host), never only an id. */
  subjectLabel: string | null
  /** The window this instance judges, for a signal whose registry window is `per_call`. */
  windowMinutes?: number
  /** Told about a recording that failed, so the check can put it in its own summary. */
  onRecordError?: (message: string) => void
}

/** How an incident ended, for settleRecovery. */
export interface IncidentEnd extends IncidentContext {
  reason: IncidentEndReason
  /** The signal it was handed over to, required when the reason is handed_over. */
  successor?: IncidentSignal
}

interface EventBase {
  v: 1
  /** Unique per event, so a page applied twice (a drain run twice) counts once. */
  id: string
  signal: IncidentSignal
  subject: string
  subjectLabel: string | null
  scope: 'org' | 'platform'
  organizationId: string | null
  /** The incident's start: the recovery marker's value. */
  startedAt: string
  /** When the event happened. */
  at: string
  windowMinutes: number | null
}

export type IncidentEvent =
  | (EventBase & { type: 'opened'; previousStartedAt?: string })
  | (EventBase & { type: 'paged' })
  | (EventBase & { type: 'ended'; endedAt: string | null; reason: IncidentEndReason; successor?: IncidentSignal })

/** What a caller supplies; the rest is filled in from the context and the registry. */
export type IncidentEventInput =
  | { type: 'opened'; signal: IncidentSignal; subject: string; startedAt: string; previousStartedAt?: string }
  | { type: 'paged'; signal: IncidentSignal; subject: string; startedAt: string }
  | { type: 'ended'; signal: IncidentSignal; subject: string; startedAt: string; endedAt: string | null; reason: IncidentEndReason; successor?: IncidentSignal }

export interface OutboxKv {
  put(key: string, value: string): Promise<void>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Orders two events one isolate writes in the same millisecond. Across isolates
// nothing can, and the drain's SQL does not need it to.
let seq = 0

export function outboxKey(atMs: number, eventId: string): string {
  seq = (seq + 1) % 1_000_000
  return `${INCIDENT_OUTBOX_PREFIX}${String(Math.max(0, Math.floor(atMs))).padStart(15, '0')}:${String(seq).padStart(6, '0')}:${eventId}`
}

/** When an outbox key was written, or null when it is not one. */
export function outboxKeyTime(key: string): number | null {
  if (!key.startsWith(INCIDENT_OUTBOX_PREFIX)) return null
  const ms = Number(key.slice(INCIDENT_OUTBOX_PREFIX.length).split(':')[0])
  return Number.isFinite(ms) ? ms : null
}

/** Report a recording that failed, to the log and the caller's summary. Never throws. */
export function reportRecordError(ctx: Pick<IncidentContext, 'onRecordError'>, message: string): void {
  console.error(`[incident-record] event=incident_record_failed ${message}`)
  try {
    ctx.onRecordError?.(message)
  } catch {
    // A summary that cannot take the line must not turn a recorder fault into a check fault.
  }
}

/** Why `ctx` cannot be recorded for `signal`, or null when it can. */
function scopeProblem(signal: IncidentSignal, ctx: IncidentContext): string | null {
  const expected = incidentSignal(signal).scope
  if (ctx.scope.kind !== expected) return `${signal} is a ${expected} signal but was recorded as ${ctx.scope.kind}`
  if (ctx.scope.kind === 'org' && !UUID.test(ctx.scope.organizationId)) {
    return `${signal} was recorded for organization ${JSON.stringify(ctx.scope.organizationId)}, which is not an organization id`
  }
  return null
}

function windowFor(signal: IncidentSignal, ctx: IncidentContext): number | null {
  const w = incidentSignal(signal).windowMinutes
  if (w === 'per_call') return typeof ctx.windowMinutes === 'number' && Number.isFinite(ctx.windowMinutes) ? ctx.windowMinutes : null
  return w
}

/**
 * Write one event to the outbox. Never throws: returns false, and reports why,
 * when the event was refused (a scope that does not match the registry) or KV
 * did not take it.
 */
export async function writeIncidentEvent(
  kv: OutboxKv,
  input: IncidentEventInput,
  ctx: IncidentContext,
  atMs: number = Date.now(),
): Promise<boolean> {
  const label = `${input.type} ${input.signal} ${input.subject}`
  try {
    const problem = scopeProblem(input.signal, ctx)
    if (problem) {
      reportRecordError(ctx, `${label} not recorded: ${problem}`)
      return false
    }
    if (input.type === 'ended' && (input.reason === 'handed_over') !== (input.successor !== undefined)) {
      reportRecordError(ctx, `${label} not recorded: a hand over must name its successor, and only a hand over may`)
      return false
    }
    const id = crypto.randomUUID()
    const event: IncidentEvent = {
      ...input,
      v: EVENT_VERSION,
      id,
      subjectLabel: ctx.subjectLabel,
      scope: ctx.scope.kind,
      organizationId: ctx.scope.kind === 'org' ? ctx.scope.organizationId : null,
      at: new Date(atMs).toISOString(),
      windowMinutes: windowFor(input.signal, ctx),
    }
    await kv.put(outboxKey(atMs, id), JSON.stringify(event))
    return true
  } catch (e) {
    reportRecordError(ctx, `${label} not recorded: ${formatErr(e)}`)
    return false
  }
}

const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

/** Read one outbox value back, refusing anything the drain could not write faithfully. */
export function parseIncidentEvent(raw: string): IncidentEvent | { error: string } {
  let e: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { error: 'not an object' }
    e = parsed as Record<string, unknown>
  } catch (err) {
    return { error: `not JSON: ${formatErr(err)}` }
  }
  if (e.v !== EVENT_VERSION) return { error: `unknown version ${JSON.stringify(e.v)}` }
  if (typeof e.id !== 'string' || e.id.length === 0) return { error: 'no event id' }
  if (!isIncidentSignal(e.signal)) return { error: `unknown signal ${JSON.stringify(e.signal)}` }
  if (typeof e.subject !== 'string' || e.subject.length === 0) return { error: 'no subject' }
  if (!isStrOrNull(e.subjectLabel)) return { error: 'subject label is not text' }
  if (e.scope === 'org') {
    if (typeof e.organizationId !== 'string' || !UUID.test(e.organizationId)) return { error: 'an org event without an organization id' }
  } else if (e.scope === 'platform') {
    if (e.organizationId !== null) return { error: 'a platform event carrying an organization' }
  } else return { error: `unknown scope ${JSON.stringify(e.scope)}` }
  if (incidentSignal(e.signal).scope !== e.scope) return { error: `${e.signal} is not a ${String(e.scope)} signal` }
  if (!isIso(e.startedAt) || !isIso(e.at)) return { error: 'a time that does not parse' }
  if (!(e.windowMinutes === null || (typeof e.windowMinutes === 'number' && Number.isFinite(e.windowMinutes)))) return { error: 'window is not a number' }
  if (e.type === 'opened') {
    if (e.previousStartedAt !== undefined && !isIso(e.previousStartedAt)) return { error: 'previous start does not parse' }
  } else if (e.type === 'ended') {
    if (!(e.endedAt === null || isIso(e.endedAt))) return { error: 'end does not parse' }
    if (!(INCIDENT_END_REASONS as readonly unknown[]).includes(e.reason)) return { error: `unknown end reason ${JSON.stringify(e.reason)}` }
    if ((e.reason === 'handed_over') !== isIncidentSignal(e.successor)) return { error: 'a hand over must name its successor, and only a hand over may' }
  } else if (e.type !== 'paged') return { error: `unknown type ${JSON.stringify(e.type)}` }
  return e as unknown as IncidentEvent
}
