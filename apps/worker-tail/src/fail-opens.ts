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
 * The copy is an upsert that ignores a row already there, so a batch written
 * twice counts each fail-open once. A refused write is retried with a short
 * backoff, then HELD in this isolate and written with the next batch this
 * consumer is handed, which comes with every invocation of the bidding Worker,
 * so once the database answers the held rows land within seconds. Every
 * failure says why.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { OPS_WORKER_SCRIPT } from './scripts'

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

/** The waits before the second and third attempts. */
export const COPY_BACKOFF_MS = [250, 1_000] as const

/** A day of the minute tick failing open is 1,440; past this the oldest is dropped, loudly. */
export const MAX_HELD = 2_000

export interface FailOpenCopierDeps {
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  error?: (line: string) => void
  maxHeld?: number
}

export interface FailOpenCopier {
  /** Writes `rows` and anything held. Never throws: what it cannot write it holds. */
  copy(supabase: SupabaseClient, rows: FailOpenRow[]): Promise<void>
  held(): FailOpenRow[]
}

const describe = (error: { message?: string; code?: string } | null): string =>
  error ? `${error.code ? `${error.code} ` : ''}${error.message ?? 'no message'}` : 'no error given'

export function createFailOpenCopier(deps: FailOpenCopierDeps = {}): FailOpenCopier {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log = deps.log ?? ((l: string) => console.log(l))
  const error = deps.error ?? ((l: string) => console.error(l))
  const maxHeld = deps.maxHeld ?? MAX_HELD
  const held = new Map<string, FailOpenRow>()

  return {
    async copy(supabase, rows) {
      for (const r of rows) {
        held.delete(r.event_id)
        held.set(r.event_id, r)
      }
      while (held.size > maxHeld) {
        const oldest = held.values().next().value as FailOpenRow
        held.delete(oldest.event_id)
        error(`[worker-tail] dropped a held cron guard fail-open event=${oldest.event_id} from ${oldest.occurred_at}: already holding ${maxHeld}`)
      }
      if (held.size === 0) return
      const batch = [...held.values()]
      // Only new rows earn the backoff. Held rows alone get one try per batch,
      // and a refusal of them alone is not logged again: batches arrive with
      // every request the bidding Worker serves, so anything more would multiply
      // a database outage by the request rate. Their first refusal was logged.
      const retries = rows.length > 0 ? COPY_BACKOFF_MS.length : 0
      let why = ''
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(COPY_BACKOFF_MS[attempt - 1])
        try {
          const { error: e } = await supabase
            .from('cron_guard_fail_opens')
            .upsert(batch, { onConflict: 'event_id', ignoreDuplicates: true })
          if (!e) {
            for (const r of batch) held.delete(r.event_id)
            if (batch.length > rows.length) log(`[worker-tail] copied ${batch.length} cron guard fail-opens, ${batch.length - rows.length} of them held from an earlier batch`)
            return
          }
          why = describe(e)
        } catch (e) {
          // This app cannot import the worker's formatErr; a thrown non-Error is
          // JSON, never "[object Object]".
          why = e instanceof Error ? e.message : JSON.stringify(e)
        }
      }
      if (rows.length === 0) return
      error(
        `[worker-tail] could not copy ${batch.length} cron guard fail-open${batch.length === 1 ? '' : 's'} after ${retries + 1} attempts: ${why}.` +
          ` They are held in this isolate and written with the next batch, the oldest from ${batch[0].occurred_at}`,
      )
    },
    held: () => [...held.values()],
  }
}

/** The one copier per isolate, so a row held by one invocation is written by the next. */
export const isolateFailOpenCopier: FailOpenCopier = createFailOpenCopier()
