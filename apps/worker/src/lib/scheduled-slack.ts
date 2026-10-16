/**
 * The Slack lookup's budget on the scheduled handler's client (#1303 phase 1).
 *
 * On 2026-10-08 the database stalled: reads hung rather than failing. One Slack
 * lookup then took about 136 s (three attempts at the client's 45 s deadline)
 * before any fallback could run, and a check that looks up each org per job
 * multiplied that. So the scheduled handler, which builds ONE Supabase client a
 * tick for every job, registers a ScheduledSlack against it here (a WeakMap
 * keyed on the client, the way lead-read-budget.ts marks a lead's client).
 * getSlackConnection, slackOrgIds, forEachSlackOrg and readEverySlackConnection
 * look it up:
 *
 * - on the scheduled client each live read has SCHEDULED_SLACK_READ_DEADLINE_MS,
 *   the library's own retries off and no retry of ours on a timeout; any
 *   non-answer (an error object, a permanent error, a thrown fetch, no answer
 *   in time) falls back to the encrypted last-good copy (slack-copy.ts);
 * - after the first failed read in a tick, `unreachable` is set and every later
 *   lookup and org list in that tick goes straight to the copy without asking;
 * - the copy is read and decrypted once per tick, however many lookups use it;
 * - on any other client (the request and engine paths, the signed-in app) none
 *   of this applies, and the helpers behave exactly as before. The request path
 *   never gets the copy here, so an outage cannot turn per-execution failure
 *   alerts into a Slack flood; it has its own bounded readers.
 *
 * Writes never come through here: a write that timed out may still have landed.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import type { Database } from '../types/database'
import { createSupabaseClient } from './supabase'
import { secretKeys, type SecretKeyInput } from './secret-crypto'
import { readSlackCopy, type SlackCopyRead } from './slack-copy'
import { formatErr } from './format-error'
import { createNobodyToldPager, type NobodyToldPager } from './nobody-told-page'
import { attachOutageNotice } from './outage-notice'

/**
 * How long a scheduled Slack read waits before the copy answers. Above healthy
 * read times (1 in 1,000 lead path reads under 1,056 ms, measured 2026-10-07 for
 * LEAD_READ_DEADLINE_MS), and short enough that a stalled tick still speaks
 * well inside the minute job deadline (MINUTE_JOB_DEADLINE_MS, 50 s).
 */
export const SCHEDULED_SLACK_READ_DEADLINE_MS = 3_000

export interface ScheduledSlackOptions {
  /** IDEMPOTENCY, where the last-good copy is kept. */
  kv: { get(key: string): Promise<string | null> }
  secretKeys: SecretKeyInput
  /** The live read's deadline; SCHEDULED_SLACK_READ_DEADLINE_MS unless a test asks. */
  deadlineMs?: number
  /** Waits ms, or until the signal fires; the timer seam, so no test waits for real (L524). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** The clock the copy's age is measured on. */
  now?: () => number
  /**
   * Pages Better Stack when nobody can be told (#2063, nobody-told-page.ts).
   * Absent, nothing is paged; the scheduled handler's client always has one.
   */
  pager?: NobodyToldPager
  /** Keeps a page alive past the job that raised it, without anything awaiting it. */
  waitUntil?: (p: Promise<unknown>) => void
  /**
   * Told once, on the first read this tick that failed (#2061): the scheduled
   * handler reports it to the database reachability owner, so a stalled
   * database that only a Slack lookup noticed is still reported.
   */
  onUnreachable?: (failure: ReadFailure) => void
}

/** A read that did not answer, and why. */
export interface ReadFailure {
  what: string
  how: 'error' | 'timeout' | 'threw'
  detail: string
}

/** One live read's outcome: the database answered, or did not and why. */
export type LiveRead<T> =
  | { kind: 'answered'; data: T | null }
  | { kind: 'failed'; how: 'error' | 'timeout' | 'threw' | 'skipped'; detail: string }

/** The copy as one tick sees it, with its age when the copy says when it was saved. */
export type TickCopy =
  | { kind: 'read'; copy: Extract<SlackCopyRead, { kind: 'read' }>; ageMs: number | null }
  | Exclude<SlackCopyRead, { kind: 'read' }>

/** A query builder the read can bound: library retries off, and an abort signal. */
export interface BoundableQuery<T> extends PromiseLike<{ data: T | null; error: unknown }> {
  retry(enabled: boolean): unknown
  abortSignal(signal: AbortSignal): unknown
}

export interface ScheduledSlack {
  /** Ask the database once under the deadline, or not at all once this tick has seen it fail. */
  read<T>(what: string, query: BoundableQuery<T>): Promise<LiveRead<T>>
  /**
   * One bounded read of a table whose failure is not evidence the database is
   * down (job_runs for the heartbeat check, #2061): the same deadline, and not
   * asked once this tick has seen the database fail, but its own failure never
   * marks the tick or tells the database owner, so a fault in that one table (a
   * missing table, a revoked grant) cannot page a database outage or send the
   * tick's Slack lookups to the copy.
   */
  readAside<T>(query: BoundableQuery<T>): Promise<LiveRead<T>>
  /** The copy, read and decrypted at most once this tick. */
  copy(): Promise<TickCopy>
  /** The first read that failed this tick, or null while every read has answered. */
  readonly unreachable: { what: string; how: string } | null
  /**
   * The database did not answer and no saved copy could stand in: logs the one
   * line for `reason` and pages Better Stack for `orgId` (null for every
   * organization), handed to waitUntil and never awaited, so it cannot delay
   * or fail the caller (#2063).
   */
  nobodyCanBeTold(subject: string, orgId: string | null, reason: CopyUnreachableReason, detail?: string): void
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    const handle = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(handle)
      resolve()
    }, { once: true })
  })

const registered = new WeakMap<object, ScheduledSlack>()

/**
 * Ask once under `deadlineMs`: the library's retries off, the read aborted when
 * the deadline passes, and the timer stopped when the read answers. Shared by
 * the scheduled Slack lookup and the database reachability probe (#2061), so
 * the two bound a read the same way.
 */
export async function boundedRead<T>(
  query: BoundableQuery<T>,
  deadlineMs: number,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = realSleep,
): Promise<{ kind: 'answered'; data: T | null } | { kind: 'failed'; how: ReadFailure['how']; detail: string }> {
  const stop = new AbortController()
  query.retry(false)
  query.abortSignal(stop.signal)
  // Folded into a value before the race, so a read that rejects after losing
  // it has already been handled (L749).
  const answered = Promise.resolve(query).then(
    (r) => ({ kind: 'result' as const, r }),
    (e: unknown) => ({ kind: 'threw' as const, e }),
  )
  const expired = sleep(deadlineMs, stop.signal).then(() => ({ kind: 'timeout' as const }))
  const outcome = await Promise.race([answered, expired])
  // Ends the timer when the read answered, and the read when the timer did.
  stop.abort()
  if (outcome.kind === 'timeout') return { kind: 'failed', how: 'timeout', detail: `no answer in ${deadlineMs} ms` }
  if (outcome.kind === 'threw') return { kind: 'failed', how: 'threw', detail: formatErr(outcome.e) }
  if (outcome.r.error) return { kind: 'failed', how: 'error', detail: formatErr(outcome.r.error) }
  return { kind: 'answered', data: outcome.r.data }
}

/** Mark `client` as this tick's scheduled client. Make one per tick, with the client. */
export function registerScheduledSlack(client: object, options: ScheduledSlackOptions): ScheduledSlack {
  const deadlineMs = options.deadlineMs ?? SCHEDULED_SLACK_READ_DEADLINE_MS
  const sleep = options.sleep ?? realSleep
  const now = options.now ?? Date.now
  let unreachable: { what: string; how: string } | null = null
  let copy: Promise<TickCopy> | null = null

  const fail = <T>(what: string, how: ReadFailure['how'], detail: string): LiveRead<T> => {
    if (!unreachable) {
      unreachable = { what, how }
      console.error(`[scheduled-slack] ${what} read failed (${how}: ${detail}), so every Slack lookup for the rest of this tick uses the saved copy`)
      try {
        options.onUnreachable?.({ what, how, detail })
      } catch (e) {
        // Telling the owner must never cost the lookup its answer from the copy.
        console.error(`[scheduled-slack] reporting ${what} to the database reachability owner failed: ${formatErr(e)}`)
      }
    }
    return { kind: 'failed', how, detail }
  }

  const slack: ScheduledSlack = {
    get unreachable() {
      return unreachable
    },
    nobodyCanBeTold(subject, orgId, reason, detail) {
      console.error(copyUnreachableLine(subject, reason, detail))
      if (!options.pager) return
      // The pager never rejects; the catch is so a future one that does cannot
      // surface as an unhandled rejection on the tick.
      const paged = Promise.resolve()
        .then(() => options.pager?.page(orgId, reason))
        .catch((e: unknown) => console.error(`[scheduled-slack] the Better Stack page for ${subject} failed: ${formatErr(e)}`))
      options.waitUntil?.(paged)
    },
    async readAside<T>(query: BoundableQuery<T>): Promise<LiveRead<T>> {
      if (unreachable) return { kind: 'failed', how: 'skipped', detail: `not asked: ${unreachable.what} failed earlier this tick (${unreachable.how})` }
      return boundedRead(query, deadlineMs, sleep)
    },
    async read<T>(what: string, query: BoundableQuery<T>): Promise<LiveRead<T>> {
      if (unreachable) return { kind: 'failed', how: 'skipped', detail: `not asked: ${unreachable.what} failed earlier this tick (${unreachable.how})` }
      const outcome = await boundedRead(query, deadlineMs, sleep)
      if (outcome.kind === 'failed') return fail(what, outcome.how, outcome.detail)
      return outcome
    },
    copy(): Promise<TickCopy> {
      copy ??= readSlackCopy(options.kv, options.secretKeys).then((read): TickCopy => {
        if (read.kind !== 'read') return read
        return { kind: 'read', copy: read, ageMs: read.savedAtMs === null ? null : Math.max(0, now() - read.savedAtMs) }
      })
      return copy
    },
  }
  registered.set(client, slack)
  return slack
}

/**
 * The scheduled handler's ONE client for a tick, registered: every job the tick
 * starts is handed this client, so every Slack lookup they make is bounded and
 * can fall back to the saved copy without any of them passing anything new.
 * Built inside runInScheduledTick, it also gives the tick what it reads an open
 * database outage with, so every alert the tick posts can name it (#2061,
 * outage-notice.ts).
 */
export function createScheduledSupabaseClient(
  env: Env,
  /**
   * The platform's waitUntil, required so the Better Stack page (#2063) is kept
   * alive past the job that raised it. Called directly rather than through the
   * tick's job list, so the tick never waits on a page.
   */
  waitUntil: (p: Promise<unknown>) => void,
  options: { fetch?: typeof fetch; pageFetch?: typeof fetch } & Pick<ScheduledSlackOptions, 'sleep' | 'now' | 'deadlineMs' | 'onUnreachable'> = {},
): SupabaseClient<Database> {
  const client = createSupabaseClient(env, { fetch: options.fetch })
  const pager = createNobodyToldPager({
    token: env.BETTERSTACK_OUTAGE_TOKEN,
    url: env.BETTERSTACK_OUTAGE_URL,
    kv: env.IDEMPOTENCY,
    fetch: options.pageFetch,
    now: options.now,
  })
  const slack = registerScheduledSlack(client, {
    kv: env.IDEMPOTENCY,
    secretKeys: secretKeys(env),
    sleep: options.sleep,
    now: options.now,
    deadlineMs: options.deadlineMs,
    pager,
    waitUntil,
    onUnreachable: options.onUnreachable,
  })
  attachOutageNotice({ kv: env.IDEMPOTENCY, scheduled: slack })
  return client
}

/** This tick's ScheduledSlack when `client` is the scheduled handler's, otherwise undefined. */
export function scheduledSlackFor(client: object): ScheduledSlack | undefined {
  return registered.get(client)
}

/**
 * Why the copy could not stand in for a database that did not answer: there is
 * no copy, the copy holds no connection for the organization asked about, or
 * the copy cannot be read (most likely written under a key since rotated).
 */
export type CopyUnreachableReason = 'no_copy' | 'org_not_in_copy' | 'copy_unreadable'

const UNREACHABLE_WORDS: Record<CopyUnreachableReason, string> = {
  no_copy: 'there is no saved copy',
  org_not_in_copy: 'the saved copy holds no Slack connection for this organization',
  copy_unreadable: 'the saved copy could not be read',
}

/** The one log line for each reason nobody can be told, so each reads differently. */
export function copyUnreachableLine(subject: string, reason: CopyUnreachableReason, detail?: string): string {
  return `[scheduled-slack] ${subject}: nobody can be told, the database did not answer and ${UNREACHABLE_WORDS[reason]}${detail ? ` (${detail})` : ''}`
}

/** How a stored answer names its copy's age in a log line. */
export function describeCopyAge(ageMs: number | null): string {
  if (ageMs === null) return 'age unknown'
  const minutes = Math.floor(ageMs / 60_000)
  return `saved ${minutes} minute${minutes === 1 ? '' : 's'} ago`
}
