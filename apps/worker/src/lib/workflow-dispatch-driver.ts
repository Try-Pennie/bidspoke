import { formatErr } from './format-error'
import {
  DRIVER_MARKER,
  type GithubAccess,
  type ScheduleLookup,
  WATCHED_WORKFLOWS,
  lookupLastScheduledRun,
  resolveGithubAccess,
} from './workflow-schedule-watch'

/**
 * Drive this repository's scheduled workflows from the worker's own cron,
 * because GitHub's scheduler stopped delivering them (#1058).
 *
 * From 2026-08-26 around 17:00 UTC, scheduled runs for Try-Pennie/bidspoke fell
 * from about 24 a day to 3. `deploy-drift.yml` (hourly) went to gaps of 4 to 13
 * hours and `db-types-drift.yml` (daily) fired at 18:37, 19:46 and 13:28 on
 * successive days. Nothing was wrong on our side: the workflows were enabled,
 * every run that fired passed in about 15 seconds, and `created_at` equalled
 * `run_started_at` on every one, so nothing was queued waiting for a runner.
 * GitHub simply was not creating the events.
 *
 * The decisive measurement was splitting runs by trigger rather than by
 * workflow: on 2026-08-29 the repository's `push` and `pull_request` runs fired
 * normally while `schedule` runs were mostly missing. That rules out billing and
 * quota in one step, since an exhausted budget blocks every trigger rather than
 * one of them, and it is also what makes this fix work: on-demand dispatch is
 * the mechanism that demonstrably still functions.
 *
 * This is a BACKSTOP, not a replacement. The `schedule:` triggers stay in the
 * workflow files, and `decideDue` dispatches only when a workflow is actually
 * overdue, so if GitHub's delivery recovers this goes quiet on its own instead
 * of doubling every run for ever.
 */

/**
 * The branch dispatches are fired against.
 *
 * GitHub only accepts a `workflow_dispatch` for a workflow that exists on the
 * repository's default branch, and this repository's is `main` (every change
 * reaches it through a PR, see CLAUDE.md). Named rather than inlined so the
 * assumption is visible; if it is ever wrong GitHub answers 422 and the driver
 * says so rather than failing quietly.
 */
export const DISPATCH_REF = 'main'

/**
 * How often the worker cron that calls this driver actually fires.
 *
 * Stated here so the headroom guard can be written in the unit that matters. A
 * dispatch that fails is retried on the NEXT tick, so the room a workflow has
 * between `driveAfterMs` and `staleMs` is measured in ticks, not in drive
 * thresholds. Must stay in step with the cron in `wrangler.toml` that calls
 * `runWorkflowDispatchDriver`.
 */
export const DRIVE_TICK_MS = 60 * 60 * 1000

export type DueDecision =
  /** Overdue: the worker should fire it. */
  | { act: 'dispatch'; why: string }
  /** Ran recently enough. Nothing to do. */
  | { act: 'wait'; why: string }
  /** Nothing was measured, so no action can be justified. */
  | { act: 'unknown'; why: string }

/**
 * Should the worker dispatch this workflow?
 *
 * Deliberately silent on a failed or unreadable lookup. A read that did not
 * complete is not evidence a workflow is behind, and dispatching on it would
 * fire on every cycle of an outage that has nothing to do with the schedule.
 * The watch reports an unreadable lookup on its own, so the condition is not
 * lost by this declining to act on it (L11, distinct causes stay distinct).
 */
export function decideDue(lookup: ScheduleLookup, nowMs: number, driveAfterMs: number): DueDecision {
  if (!lookup.ok) {
    return { act: 'unknown', why: `the last run could not be read: ${lookup.reason}` }
  }
  if (lookup.lastRunIso === null) {
    return { act: 'dispatch', why: 'GitHub has no qualifying run on record' }
  }
  const lastMs = Date.parse(lookup.lastRunIso)
  if (Number.isNaN(lastMs)) {
    // NaN compares false against every threshold, so letting this reach the
    // comparison below would silently land on `wait`: the answer that does
    // nothing, arrived at without having measured anything (L50).
    return { act: 'unknown', why: `the last run's timestamp could not be read: ${lookup.lastRunIso}` }
  }
  const ageMs = nowMs - lastMs
  if (ageMs > driveAfterMs) {
    return { act: 'dispatch', why: `last qualifying run was ${lookup.lastRunIso}` }
  }
  return { act: 'wait', why: `last qualifying run was ${lookup.lastRunIso}` }
}

export type DispatchResult = { ok: true } | { ok: false; reason: string }

/**
 * Ask GitHub to run one workflow now.
 *
 * The `driver` input is what makes the resulting run distinguishable from a
 * person pressing Run workflow: the workflow's `run-name` stamps it into the
 * run's display title, and `isQualifyingRun` in the watch counts only runs
 * carrying it. Without the input the watch would either ignore every driven run
 * (and alert for ever about a workflow running fine) or count every manual press
 * (and go blind to a genuinely dead schedule).
 */
export async function dispatchWorkflow(
  access: Extract<GithubAccess, { ok: true }>,
  file: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchResult> {
  const url = `https://api.github.com/repos/${access.repo}/actions/workflows/${file}/dispatches`
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'bidspoke-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: DISPATCH_REF, inputs: { driver: DRIVER_MARKER } }),
    })
  } catch (e) {
    return { ok: false, reason: `the dispatch request to GitHub failed: ${formatErr(e)}` }
  }

  // 204 and nothing else. GitHub documents exactly one success status here, and
  // treating any other 2xx as success would report a run that never started
  // (L12, report what verifiably happened).
  if (response.status === 204) return { ok: true }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason:
        `GitHub refused the dispatch of ${file} with ${response.status}. The credential in GITHUB_ACTIONS_TOKEN ` +
        'needs Actions: read and write on this repository; read alone can list runs but cannot start one',
    }
  }
  if (response.status === 404) {
    return {
      ok: false,
      reason:
        `GitHub has no workflow named ${file} to dispatch (404). A private repository also answers 404 for a ` +
        'credential with no access, so this is either a renamed file or a permissions problem',
    }
  }
  if (response.status === 422) {
    return {
      ok: false,
      reason:
        `GitHub rejected the dispatch of ${file} with 422, which means it has no workflow_dispatch trigger on ` +
        `${DISPATCH_REF}, or the inputs it declares do not include 'driver'`,
    }
  }
  return { ok: false, reason: `GitHub returned ${response.status} when asked to dispatch ${file}` }
}

export type DispatchOutcome = 'dispatched' | 'not_due' | 'unknown' | 'failed' | 'unconfigured'

export interface DispatchAttempt {
  file: string
  outcome: DispatchOutcome
  /** Why, for the run log and the alert. */
  reason: string
}

/** Did this run leave anything a person needs to act on? */
export const dispatchFailed = (results: DispatchAttempt[]): DispatchAttempt[] =>
  results.filter((r) => r.outcome === 'failed' || r.outcome === 'unconfigured')

/** One line naming every workflow and what the driver did about it. */
export function formatDispatchSummary(results: DispatchAttempt[]): string {
  if (results.length === 0) return 'no workflows to drive'
  return results.map((r) => `${r.file}=${r.outcome}`).join('; ')
}

interface DriverEnv {
  GITHUB_ACTIONS_TOKEN?: string
  GITHUB_TOKEN?: string
  GITHUB_CODE_REPO?: string
}

/**
 * Drive every watched workflow that is overdue.
 *
 * Deliberately does NOT run the repository access pre-check the watch does. That
 * check exists so a per-file 404 can mean "this file is gone" rather than "we
 * can see nothing"; here a failed dispatch already names its own cause, and
 * running it would add a request per cycle to say something the first dispatch
 * failure says better.
 */
export async function runWorkflowDispatchDriver(
  env: DriverEnv,
  nowMs: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchAttempt[]> {
  const access = resolveGithubAccess(env)
  if (!access.ok) {
    // One fact about configuration, repeated per workflow so the caller's
    // summary still names everything that is not being driven.
    return WATCHED_WORKFLOWS.map((w) => ({ file: w.file, outcome: 'unconfigured' as const, reason: access.reason }))
  }

  const results: DispatchAttempt[] = []
  for (const workflow of WATCHED_WORKFLOWS) {
    // Each workflow gets its own failure boundary. Independent steps sharing one
    // handler each need one (L73): without it, one thrown lookup leaves every
    // workflow after it undriven, which looks exactly like a healthy run.
    try {
      const lookup = await lookupLastScheduledRun(access, workflow.file, fetchImpl)
      const decision = decideDue(lookup, nowMs, workflow.driveAfterMs)
      if (decision.act === 'wait') {
        results.push({ file: workflow.file, outcome: 'not_due', reason: decision.why })
        continue
      }
      if (decision.act === 'unknown') {
        results.push({ file: workflow.file, outcome: 'unknown', reason: decision.why })
        continue
      }
      const dispatched = await dispatchWorkflow(access, workflow.file, fetchImpl)
      results.push(
        dispatched.ok
          ? { file: workflow.file, outcome: 'dispatched', reason: decision.why }
          : { file: workflow.file, outcome: 'failed', reason: dispatched.reason },
      )
    } catch (e) {
      results.push({ file: workflow.file, outcome: 'failed', reason: `driving this workflow threw: ${formatErr(e)}` })
    }
  }
  return results
}
