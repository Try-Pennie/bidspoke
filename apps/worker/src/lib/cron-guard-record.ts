/**
 * Writes each cron guard event to the KV record the hourly check counts, and
 * does not drop one when the write fails (#2166).
 *
 * The guard fails open when its claim object does not answer, and that is
 * usually a platform blip that takes KV down with it: on 2026-10-14 from 21:34
 * to 21:48 UTC six fail-opens were logged and seven KV puts recording them
 * failed, so the hourly check read zero and nobody was paged. So:
 *
 *  - a failed put is retried with a short backoff (RECORD_BACKOFF_MS), well
 *    inside the waitUntil allowance, which rides out a single dropped request;
 *  - one that still fails is HELD in this isolate and written on every later
 *    scheduled invocation until the store answers (`flush`), at the event's OWN
 *    time, so a late write lands in the window it belongs to. The key carries
 *    the event's id, so writing an event that had landed after all (a put that
 *    timed out may still have landed) counts it once;
 *  - every failure is logged with its reason through formatErr, where the raw
 *    error object had left only a stack frame.
 *
 * What is held lives only as long as the isolate. That is why it is not the
 * only record: each `FAILED OPEN` log line names its event, and the tail worker
 * copies those lines into the database (apps/worker-tail, the
 * cron_guard_fail_opens table), a record written by a different path that does
 * not depend on this isolate or on KV (L561). The hourly check counts both.
 */
import { formatErr } from './format-error'
import { recordCronGuardEvent, type CronGuardKind, type RecordKv } from './cron-guard-watch'

export interface GuardEvent {
  kind: CronGuardKind
  id: string
  atMs: number
}

/** The waits before the second and third attempts: three tries in about 1.25 s. */
export const RECORD_BACKOFF_MS = [250, 1_000] as const

/**
 * How many unwritten events one isolate holds. A whole day of the minute tick
 * failing open is 1,440, so this is a full day of an outage with room to spare,
 * and a few hundred kilobytes at most. Past it the oldest is dropped, loudly.
 */
export const MAX_HELD = 2_000

export interface CronGuardRecorderDeps {
  /** The backoff's timer seam (L524). */
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  error?: (line: string) => void
  maxHeld?: number
}

export interface CronGuardRecorder {
  /** Writes the event, retrying; holds it when every attempt fails. Never throws. */
  record(kv: RecordKv, event: GuardEvent): Promise<'recorded' | 'held'>
  /** Writes what is held, oldest first, stopping at the first refusal. Never throws. */
  flush(kv: RecordKv): Promise<void>
  /** What is held now, oldest first. */
  held(): GuardEvent[]
}

const iso = (ms: number) => new Date(ms).toISOString()
const plural = (n: number) => `${n} held guard ${n === 1 ? 'event' : 'events'}`

export function createCronGuardRecorder(deps: CronGuardRecorderDeps = {}): CronGuardRecorder {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log = deps.log ?? ((l: string) => console.log(l))
  const error = deps.error ?? ((l: string) => console.error(l))
  const maxHeld = deps.maxHeld ?? MAX_HELD
  // By id, so one event held twice is held once; a Map keeps insertion order.
  const held = new Map<string, GuardEvent>()

  const write = (kv: RecordKv, e: GuardEvent) => recordCronGuardEvent(kv, e.kind, e.atMs, e.id)

  const hold = (e: GuardEvent) => {
    held.delete(e.id)
    held.set(e.id, e)
    while (held.size > maxHeld) {
      const oldest = held.values().next().value as GuardEvent
      held.delete(oldest.id)
      error(`[cron-guard] dropped held ${oldest.kind} event=${oldest.id} from ${iso(oldest.atMs)}: this isolate already holds ${maxHeld} unwritten guard events`)
    }
  }

  return {
    async record(kv, e) {
      let last: unknown
      for (let attempt = 0; attempt <= RECORD_BACKOFF_MS.length; attempt++) {
        if (attempt > 0) await sleep(RECORD_BACKOFF_MS[attempt - 1])
        try {
          await write(kv, e)
          return 'recorded'
        } catch (err) {
          last = err
        }
      }
      hold(e)
      error(
        `[cron-guard] could not record ${e.kind} event=${e.id} after ${RECORD_BACKOFF_MS.length + 1} attempts: ${formatErr(last)}.` +
          ` It is held in this isolate (${held.size} held) and written at its own time by the next tick that reaches the store`,
      )
      return 'held'
    },

    async flush(kv) {
      if (held.size === 0) return
      const pending = [...held.values()]
      const oldest = pending[0].atMs
      let written = 0
      for (const e of pending) {
        try {
          await write(kv, e)
        } catch (err) {
          error(`[cron-guard] still cannot record ${plural(held.size)}, the oldest from ${iso(oldest)}: ${formatErr(err)}`)
          break
        }
        held.delete(e.id)
        written++
      }
      if (written > 0) {
        log(`[cron-guard] recorded ${plural(written)} late, the oldest from ${iso(oldest)}, ${held.size} still held`)
      }
    },

    held: () => [...held.values()],
  }
}

/**
 * The one recorder per isolate: module scope is what outlives a single
 * invocation, so an event held by one tick is written by the next.
 */
export const isolateCronGuardRecorder: CronGuardRecorder = createCronGuardRecorder()
