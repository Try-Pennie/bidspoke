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

/**
 * The scheduled run's budget.
 *
 * WHAT WAS WRONG. `maxHours` was 2 against a 600 second wall budget, so the
 * archive gained at most ONE hour of ground per hour of real time: it could
 * hold station and never catch up (#1041). The cap was 2 for a good reason,
 * which is the rule the test below still enforces: an hour costs up to 257
 * seconds, so three of them do not fit in 600 and a cap the clock stops before
 * it can be reached is not a cap, it is a number that reads like the control
 * while the control is somewhere else (L109).
 *
 * SO THE WALL BUDGET IS WHAT MOVED, not the cap alone. The platform's cron
 * ceiling is 15 minutes and the budget was using 10 of them. The other 5 were
 * margin against OVERSHOOT: an hour runs to completion once begun, so a run
 * could start one at 590 seconds and end far past its budget. Measured over 14
 * days of run records, the three runs that archived two hours took 372, 578 and
 * 646 seconds against that 600 second budget.
 *
 * The run loop now RESERVES room for the hour it is about to start, sized from
 * the slowest hour that run has already completed (#953), so a run cannot
 * overshoot and the margin no longer has to absorb one. 13 minutes leaves 2
 * minutes to the platform's ceiling.
 *
 * WHAT AN HOUR COSTS, and why the cap and the budget each govern half the day.
 * Measured over 163 single-hour production runs in the 7 days to 2026-09-10, an
 * hour costs 48.4 ms per execution at the mean and 60.8 at the p95, and the
 * cost correlates with the hour's execution count at 0.937. So an hour is not a
 * fixed price: the quietest hour of the day holds about 1,080 executions and
 * costs 53 seconds, the busiest holds 9,716 and costs up to 414.
 *
 * That means the two limits bind at different times, which is the design
 * working rather than a compromise:
 *
 *   quiet half of the day  three hours fit easily, so the CAP is the control
 *   busy half              two fit, sometimes one, so the WALL BUDGET is
 *
 * An earlier version of this comment claimed three worst-case hours fit inside
 * the budget. They do not, and no budget could make them: three of the busiest
 * hour is about 1,772 seconds against a 900 second cron ceiling. The figure it
 * used, 257 seconds an hour, came from a single recovery run in August and the
 * business has grown past it. A number measured once is trusted more as it
 * ages, so both it and its successors are re-takeable with
 * supabase/tests/measure-archive-hour-cost.sql (L316, L354).
 *
 * The effect on catch-up, SIMULATED against the real run loop rather than
 * argued (drain.test.ts, #876): a day of backlog clears in 15 to 16 hours and
 * three days in 46, against 45 to 47 and 142 under the budget this replaced.
 *
 * That is a threefold improvement and it also CORRECTS the claim this change
 * was originally made on. The old cap was said to gain exactly one hour per
 * hour and so to be unable ever to close a gap. It could: at a quiet hour it
 * archived two while one accrued, which is ground gained, just slowly. The
 * honest case for the change is the ratio, which is large enough without
 * overstating it (L440).
 *
 * Ground is gained overnight and barely at all at peak, which is worth knowing
 * before promising a drain time for a backlog that forms in the afternoon.
 *
 * THE LIMIT TO WATCH is not the cap. It is that the busiest hour must still fit
 * in one run: the reserve refuses to start an hour it cannot finish, so an hour
 * too expensive to fit means zero hours archived, and a run that archives
 * nothing looks exactly like a run with nothing to do (L98). At the p95 rate
 * the busiest measured hour costs about 591 seconds against 780, roughly 32%
 * growth headroom, and a test in execution-archive.test.ts fails when that
 * closes.
 */
export const CRON_RUN_BUDGET: RunBudget = { wallMs: 13 * 60 * 1000, maxHours: 3 }

export const REQUEST_RUN_BUDGET: RunBudget = {
  // Under the 218 second kill, with room for one hour at its measured cost.
  wallMs: 150 * 1000,
  maxHours: 1,
}
