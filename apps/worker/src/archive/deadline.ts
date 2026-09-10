/**
 * Stopping work before the platform stops it for you (#1048, #1053).
 *
 * Every archive job runs inside a ceiling it does not control: a cron
 * invocation has fifteen minutes, a fetch handler has considerably less, and a
 * Snowflake statement can wake a suspended warehouse and wait on it. Whichever
 * runs out first, the result is the same and it is the worst one available: the
 * isolate is terminated, so no `finally` runs, no record is closed, no alert is
 * sent, and what is left behind is indistinguishable from a run that had
 * nothing to do (L98).
 *
 * A job that stops ITSELF leaves a record saying so. That is the whole point of
 * a deadline here: not to make the work faster, but to convert a silent kill
 * into a reported stop.
 *
 * THE TIMER IS INJECTED, from the first line rather than retrofitted, so a test
 * asserting what happens at the deadline is instant instead of waiting out a
 * real one (L524).
 */

export interface DeadlineDeps {
  /** Resolves after `ms`. Injected so the expiry case costs a test nothing. */
  sleep?: (ms: number) => Promise<void>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type DeadlineResult<T> =
  | { timedOut: false; value: T }
  /** The work is still running. It is abandoned, not cancelled: see below. */
  | { timedOut: true }

/**
 * Runs `work`, giving up on waiting for it after `ms`.
 *
 * IT ABANDONS, IT DOES NOT CANCEL, and the distinction is worth stating because
 * it decides where this is safe to use. There is no way to stop a promise that
 * is already in flight, so the work carries on until the isolate ends. That is
 * fine for a READ whose result is simply discarded, and it is NOT fine for
 * something whose partial effects matter: use it to bound a lookup, never to
 * bound a write that must either happen or not.
 */
export async function withDeadline<T>(
  ms: number,
  work: () => Promise<T>,
  deps: DeadlineDeps = {},
): Promise<DeadlineResult<T>> {
  const sleep = deps.sleep ?? defaultSleep
  return Promise.race([
    work().then((value) => ({ timedOut: false as const, value })),
    sleep(ms).then(() => ({ timedOut: true as const })),
  ])
}

/**
 * How long one archive run may take, and how many hours it may commit to,
 * given WHERE it is running.
 *
 * The cron figures are the ones the archive has always used. The request
 * figures are the point of this type: `POST /api/admin/re-archive` calls the
 * same run from a fetch handler, which has far less room than a cron, and it
 * inherited a budget whose own comment says it is sized "inside the platform's
 * cron limit".
 *
 * Measured 2026-08-24 on 2026-08-18: the request archived hour 00:00 fine, then
 * was killed at 218 seconds with Cloudflare 1102, exceeded resource limits,
 * partway through the second hour. The scheduled run did two comparable hours in
 * 390 seconds the same night without dying. So the request context committed to
 * work it could never finish, and always ended in a platform kill rather than a
 * clean stop.
 *
 * An hour of real data costs 202 to 257 seconds end to end, measured from the
 * watermark's own timestamps on the 2026-08-22 recovery run. One hour is
 * therefore the most a request can honestly promise, and the wall budget is set
 * below the observed kill so the run stops itself first and says why.
 */
export interface RunBudget {
  wallMs: number
  maxHours: number
}

export const CRON_RUN_BUDGET: RunBudget = { wallMs: 10 * 60 * 1000, maxHours: 2 }

export const REQUEST_RUN_BUDGET: RunBudget = {
  // Under the 218 second kill, with room for one hour at its measured cost.
  wallMs: 150 * 1000,
  maxHours: 1,
}
