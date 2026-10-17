/**
 * One row per cron delivery of the bidding Worker (#2284).
 *
 * The cron guard (apps/worker/src/lib/cron-once.ts) decides, for every scheduled
 * invocation, whether it runs the tick's jobs, and logs that decision once as
 * `[cron-once] delivery {"delivery","outcome","cron","scheduled"}`. This copies
 * each into cron_tick_deliveries with how the invocation ended (trace.outcome),
 * so the hourly check (cron-guard-watch.ts) can see a tick that two deliveries
 * both ran: a fail-open whose tick a second delivery also ran, or a takeover of
 * a run that was still alive. A skip count cannot show either, because a second
 * delivery that ran leaves no skip, and a Workers Logs search misses lines.
 *
 * A scheduled invocation with no delivery line (killed while it asked, or a line
 * whose shape changed) is still recorded, as `no_decision`, so the record holds
 * every delivery Cloudflare made, whatever the guard managed to say.
 */
import { OPS_WORKER_SCRIPT } from './scripts'
import { createRowCopier, type RowCopier, type RowCopierDeps } from './row-copier'
import { DELIVERY_HELD_CAP } from './copier-caps'

export { DELIVERY_HELD_CAP }

/** What the guard decided for one delivery; `no_decision` when it said nothing. */
export type DeliveryOutcome = 'ran' | 'took_over' | 'failed_open' | 'skipped' | 'no_decision'

const DECIDED: ReadonlySet<string> = new Set(['ran', 'took_over', 'failed_open', 'skipped'])

export interface DeliveryRow {
  delivery_id: string
  occurred_at: string
  cron: string
  scheduled_at: string
  outcome: DeliveryOutcome
  /** How Cloudflare says the invocation ended: ok, canceled, exception, exceededCpu, ... */
  invocation_outcome: string | null
}

/** Kept in step with DELIVERY_LINE_PREFIX in cron-once.ts; the worker's test feeds its real line here. */
const DELIVERY_PREFIX = '[cron-once] delivery '

/** The table's id limit, so one row it would refuse cannot hold the whole batch back. */
const MAX_ID = 200

function messageText(message: unknown): string | null {
  if (typeof message === 'string') return message
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0]
  return null
}

const isoOrNull = (ms: unknown): string | null =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null

function parseLine(text: string): { delivery: string; outcome: DeliveryOutcome; cron: string; scheduledAt: string } | null {
  if (!text.startsWith(DELIVERY_PREFIX)) return null
  let body: unknown
  try {
    body = JSON.parse(text.slice(DELIVERY_PREFIX.length))
  } catch {
    return null
  }
  const b = body as { delivery?: unknown; outcome?: unknown; cron?: unknown; scheduled?: unknown }
  if (typeof b.delivery !== 'string' || b.delivery.length < 1 || b.delivery.length > MAX_ID) return null
  if (typeof b.outcome !== 'string' || !DECIDED.has(b.outcome)) return null
  if (typeof b.cron !== 'string' || typeof b.scheduled !== 'string' || !Number.isFinite(Date.parse(b.scheduled))) return null
  return { delivery: b.delivery, outcome: b.outcome as DeliveryOutcome, cron: b.cron, scheduledAt: new Date(Date.parse(b.scheduled)).toISOString() }
}

/** The deliveries one trace records: its decision lines, or one `no_decision` row for a scheduled trace with none. */
export function deliveriesIn(trace: TraceItem): DeliveryRow[] {
  if (trace.scriptName === OPS_WORKER_SCRIPT) return []
  const event = trace.event as { cron?: unknown; scheduledTime?: unknown } | null
  const cron = typeof event?.cron === 'string' ? event.cron : null
  const scheduledAt = isoOrNull(event?.scheduledTime)
  // Only scheduled invocations are deliveries.
  if (cron === null || scheduledAt === null) return []
  const invocation = typeof trace.outcome === 'string' ? trace.outcome : null
  const rows: DeliveryRow[] = []
  for (const log of trace.logs ?? []) {
    const text = messageText(log.message)
    const parsed = text ? parseLine(text) : null
    if (!parsed) continue
    const at = isoOrNull(log.timestamp) ?? isoOrNull(trace.eventTimestamp) ?? scheduledAt
    rows.push({ delivery_id: parsed.delivery, occurred_at: at, cron: parsed.cron, scheduled_at: parsed.scheduledAt, outcome: parsed.outcome, invocation_outcome: invocation })
  }
  if (rows.length > 0) return rows
  const started = isoOrNull(trace.eventTimestamp) ?? scheduledAt
  return [{
    delivery_id: `trace:${Date.parse(scheduledAt)}:${Date.parse(started)}:${cron}`.slice(0, MAX_ID),
    occurred_at: started,
    cron,
    scheduled_at: scheduledAt,
    outcome: 'no_decision',
    invocation_outcome: invocation,
  }]
}

export type DeliveryCopier = RowCopier<DeliveryRow>

export function createDeliveryCopier(deps: RowCopierDeps = {}): DeliveryCopier {
  return createRowCopier<'delivery_id', DeliveryRow>(
    { table: 'cron_tick_deliveries', key: 'delivery_id', one: 'cron tick delivery', many: 'cron tick deliveries', label: 'delivery', maxHeld: DELIVERY_HELD_CAP },
    deps,
  )
}

/** The one copier per isolate, so a row held by one invocation is written by the next. */
export const isolateDeliveryCopier: DeliveryCopier = createDeliveryCopier()
