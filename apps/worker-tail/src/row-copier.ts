/**
 * Copies rows the tail worker derives from the bidding Worker's log lines into
 * one table of the bidding database (#2166, #2284), and never loses one quietly.
 *
 * The write is an upsert that ignores a row already there, so a batch written
 * twice counts each row once. A refused write is retried with a short backoff,
 * then HELD in this isolate and written with the next batch this consumer is
 * handed, which comes with every invocation of the bidding Worker, so once the
 * database answers the held rows land within seconds. Every failure says why.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** The waits before the second and third attempts. */
export const COPY_BACKOFF_MS = [250, 1_000] as const

export interface RowCopierDeps {
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  error?: (line: string) => void
  /** Overrides the record's own cap; for tests. */
  maxHeld?: number
}

export interface RowCopier<R> {
  /** Writes `rows` and anything held. Never throws: what it cannot write it holds. */
  copy(supabase: SupabaseClient, rows: R[]): Promise<void>
  held(): R[]
}

export interface RowCopierSpec<K extends string> {
  table: string
  /** The column the upsert is keyed on, and what names a row in a log line. */
  key: K
  /** What the log calls one row, and many: `cron guard fail-open`, `cron tick delivery`. */
  one: string
  many: string
  /** How a dropped row is named in its log line: `event`, `delivery`. */
  label: string
  /**
   * How many refused rows this record holds before it drops the oldest, sized
   * from its own daily volume (copier-caps.ts), so one record's volume never
   * sets another's limit.
   */
  maxHeld: number
}

const describe = (error: { message?: string; code?: string } | null): string =>
  error ? `${error.code ? `${error.code} ` : ''}${error.message ?? 'no message'}` : 'no error given'

export function createRowCopier<K extends string, R extends { occurred_at: string } & Record<K, string>>(
  spec: RowCopierSpec<K>,
  deps: RowCopierDeps = {},
): RowCopier<R> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const log = deps.log ?? ((l: string) => console.log(l))
  const error = deps.error ?? ((l: string) => console.error(l))
  const maxHeld = deps.maxHeld ?? spec.maxHeld
  const held = new Map<string, R>()
  /** Every row this isolate has dropped, so each drop line also says the running loss. */
  let droppedSoFar = 0
  const n = (count: number) => `${count} ${count === 1 ? spec.one : spec.many}`

  return {
    async copy(supabase, rows) {
      for (const r of rows) {
        held.delete(r[spec.key])
        held.set(r[spec.key], r)
      }
      // Past the cap the oldest go, and one line says how many, which, and the
      // running loss: a drop is a record lost for good, so it is never silent.
      const dropped: R[] = []
      while (held.size > maxHeld) {
        const oldest = held.values().next().value as R
        held.delete(oldest[spec.key])
        dropped.push(oldest)
      }
      if (dropped.length > 0) {
        droppedSoFar += dropped.length
        const first = dropped[0]
        const last = dropped[dropped.length - 1]
        error(
          `[worker-tail] dropped ${dropped.length} held ${dropped.length === 1 ? spec.one : spec.many}, the oldest ${spec.label}=${first[spec.key]} from ${first.occurred_at}` +
            ` to ${last.occurred_at}: ${maxHeld} already held while the database refuses them.` +
            ` ${droppedSoFar} dropped by this isolate so far`,
        )
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
            .from(spec.table)
            .upsert(batch, { onConflict: spec.key, ignoreDuplicates: true })
          if (!e) {
            for (const r of batch) held.delete(r[spec.key])
            if (batch.length > rows.length) log(`[worker-tail] copied ${n(batch.length)}, ${batch.length - rows.length} of them held from an earlier batch`)
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
        `[worker-tail] could not copy ${n(batch.length)} after ${retries + 1} attempts: ${why}.` +
          ` They are held in this isolate and written with the next batch, the oldest from ${batch[0].occurred_at}`,
      )
    },
    held: () => [...held.values()],
  }
}
