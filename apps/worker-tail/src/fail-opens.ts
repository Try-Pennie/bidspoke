/**
 * The second record of every cron guard fail-open (#2166).
 *
 * The bidding Worker's cron guard (apps/worker/src/lib/cron-once.ts) runs a
 * tick unguarded when its claim object does not answer, and logs
 * `[cron-once] FAILED OPEN event=<id> ...`. It also records the event in KV for
 * the hourly check, but that write fails in the same platform blip that makes
 * the guard fail open: on 2026-10-14, 9 lines were logged and 3 counted.
 *
 * The log lines survived. Cloudflare hands them to this consumer once the
 * invocation has finished, so this copy is written by a different worker, at a
 * later moment, into a different store (cron_guard_fail_opens in the bidding
 * database), and does not depend on the failing isolate or on KV (L561). The
 * hourly check counts the union of the two records by event id.
 *
 * The copy is an upsert that ignores a row already there, retried and held
 * until the database takes it (row-copier.ts).
 */
import { OPS_WORKER_SCRIPT } from './scripts'
import { COPY_BACKOFF_MS, createRowCopier, type RowCopier, type RowCopierDeps } from './row-copier'
import { FAIL_OPEN_HELD_CAP } from './copier-caps'

export interface FailOpenRow {
  event_id: string
  occurred_at: string
  cron: string | null
  line: string
}

/**
 * The guard's line, `event=` first; kept in step with cron-once.ts's failOpen.
 * The id is held to the shape the table accepts (1 to 100 characters), because
 * one row the table refuses would hold the whole batch back.
 */
const FAIL_OPEN_LINE = /^\[cron-once\] FAILED OPEN event=([A-Za-z0-9-]{1,100}) /

/** A line is kept whole up to this, which every real one fits inside. */
const MAX_LINE = 1_000

function messageText(message: unknown): string | null {
  if (typeof message === 'string') return message
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0]
  return null
}

/** The fail-opens a trace logged. Every outcome counts: a run that then crashed still ran unguarded. */
export function failOpensIn(trace: TraceItem): FailOpenRow[] {
  if (trace.scriptName === OPS_WORKER_SCRIPT) return []
  const event = trace.event as { cron?: unknown } | null
  const cron = typeof event?.cron === 'string' ? event.cron : null
  const rows: FailOpenRow[] = []
  for (const log of trace.logs ?? []) {
    const text = messageText(log.message)
    const id = text ? FAIL_OPEN_LINE.exec(text)?.[1] : undefined
    if (!text || !id) continue
    const at = Number.isFinite(log.timestamp) ? log.timestamp : trace.eventTimestamp
    if (typeof at !== 'number' || !Number.isFinite(at)) continue
    rows.push({ event_id: id, occurred_at: new Date(at).toISOString(), cron, line: text.slice(0, MAX_LINE) })
  }
  return rows
}

export { COPY_BACKOFF_MS, FAIL_OPEN_HELD_CAP }

export type FailOpenCopierDeps = RowCopierDeps
export type FailOpenCopier = RowCopier<FailOpenRow>

export function createFailOpenCopier(deps: FailOpenCopierDeps = {}): FailOpenCopier {
  return createRowCopier<'event_id', FailOpenRow>(
    { table: 'cron_guard_fail_opens', key: 'event_id', one: 'cron guard fail-open', many: 'cron guard fail-opens', label: 'event', maxHeld: FAIL_OPEN_HELD_CAP },
    deps,
  )
}

/** The one copier per isolate, so a row held by one invocation is written by the next. */
export const isolateFailOpenCopier: FailOpenCopier = createFailOpenCopier()
