/**
 * Dead-man's-switch for the repo's SCHEDULED GITHUB WORKFLOWS (#805).
 *
 * `cron-heartbeat.ts` watches this worker's own crons. Nothing watched the ones
 * running in GitHub Actions, and those are silent in exactly the same way: Deploy
 * Drift runs hourly and speaks only when it finds a problem, so a disabled
 * workflow, a broken cron, an expired token, or GitHub suspending schedules on a
 * quiet repo would all silence it permanently with nothing to notice. Finding
 * nothing must not read as everything being in order (LESSONS L98), and this is
 * the guard on whether the live bidding engine is running the code on main
 * (#327), so its silence is the most expensive silence in the repo.
 *
 * It reads GITHUB'S OWN RECORD of runs rather than asking each workflow to report
 * in. That matters: a workflow that has been deleted or disabled writes no
 * heartbeat and also files no run, so one predicate catches every way a schedule
 * can stop, including the ones where there is no longer any code of ours left to
 * do the reporting.
 *
 * Four traps it is shaped around.
 *
 * An EMPTY answer and a FAILED lookup are indistinguishable if you read only the
 * count, and treating a failure as "it never ran" turns an API blip into a false
 * accusation about a workflow that is running fine (L119). They are separate
 * states here, and only a confirmed-empty answer accuses.
 *
 * The lookup asks for SCHEDULED runs only. Counting a manual dispatch would let
 * someone running the workflow by hand mask a cron that has been dead for weeks,
 * which is the one situation this exists for.
 *
 * A run that FIRED and FAILED is the same silence wearing a different hat (#844).
 * The first version read `created_at` and nothing else, so a nightly job failing
 * every single night reported as healthy. The conclusions come back too, and a
 * RUN of failures is its own verdict, while a single one is left to the
 * workflow's own alerting rather than duplicated here (L36).
 *
 * And the credential is proven against THIS repository once per run, before any
 * per-workflow question is asked (#842). The first version borrowed the token
 * that exists to push definitions to the separate backup repo, which cannot see
 * this private repository at all, so GitHub answered 404 for every workflow and
 * the check spent its whole life reporting that it could not tell. That failure
 * is one fact about configuration, not news about each workflow, and separating
 * it is also what makes a per-file 404 mean something: once the repository reads
 * cleanly, a missing workflow file is a stale entry in the registry below.
 *
 * Limitation, stated rather than hidden: this runs inside the worker, so it
 * catches GitHub's schedules going dark while the worker's own hourly cron still
 * fires. The worker's crons are watched by cron-heartbeat.ts, and total worker
 * death still needs an external uptime monitor.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logReadFailure } from './scheduled-read'
import { formatErr } from './format-error'
import { sendWorkflowScheduleAlert } from './slack'

const H = 60 * 60 * 1000

export interface WatchedWorkflow {
  /** Workflow file name as GitHub knows it, e.g. `deploy-drift.yml`. */
  file: string
  /** Human name in the alert header. */
  label: string
  /** The cron expression, echoed in the fix hint. */
  cron: string
  /** Age past which the schedule is declared dark. Well above the cadence. */
  staleMs: number
  /**
   * Age past which the worker DISPATCHES this workflow itself (#1058).
   *
   * A different number from `staleMs` and always well below it: this is when we
   * act, that is when we complain. The gap between them is the room a single
   * failed dispatch has before anybody is paged, and the guard in
   * `workflow-dispatch-driver.test.ts` requires at least one whole cycle of it.
   */
  driveAfterMs: number
  /** What stops being true while this workflow is dark (for the alert body). */
  dependents: string
}

/**
 * Every workflow in `.github/workflows` that runs on a schedule. A registry
 * rather than a single check, because every scheduled workflow has the same
 * silence and fixing only the one that prompted this would leave the next one
 * blind (L30). Both directions are guarded at build time by
 * `apps/web/src/lib/__guards__/worker/watched-workflows-complete.test.ts`, since
 * a hand-written registry checks only what it lists (L96).
 *
 * The windows are deliberately loose. GitHub's scheduled runs drift badly: this
 * repo has an hourly job recorded firing at :55, :12, :05, :10 and :05 on a
 * single day, so a window barely above the cadence would page on drift alone and
 * an alert that cries wolf gets ignored (L36).
 */
export const WATCHED_WORKFLOWS: WatchedWorkflow[] = [
  {
    file: 'deploy-drift.yml',
    label: 'Deploy Drift',
    cron: '17 * * * *',
    // Hourly cadence, 4h window. Four consecutive misses before it speaks.
    staleMs: 4 * H,
    // Slightly under the hour, because the worker's own driving cron is hourly:
    // at exactly 1 * H the comparison would land on whichever side the two crons
    // happened to drift, and a threshold decided by a race skips a cycle at
    // random. 50 minutes always trips on the next tick.
    driveAfterMs: 50 * 60 * 1000,
    dependents:
      'nothing is checking whether the live worker and the live site are running the code that is on main, so a failed deploy would leave production behind with no signal',
  },
  {
    file: 'db-types-drift.yml',
    label: 'Database types drift',
    cron: '0 8 * * *',
    // Daily cadence, 26h window, matching the daily worker crons.
    staleMs: 26 * H,
    // 20h, not 24h. Driving at exactly the cadence would walk this run an hour
    // later every day (the worker's cron is hourly, so it fires on the first
    // tick PAST the threshold), and would leave only 2h before the alert. At 20h
    // it runs a little more than daily, stays anchored, and keeps a 6h margin.
    driveAfterMs: 20 * H,
    dependents:
      'nothing is checking that the generated database types still match the live schema, so a migration can drift from the types the worker compiles against',
  },
]

export type ScheduleStatus = 'healthy' | 'stale' | 'never_ran' | 'failing' | 'missing' | 'unreadable'

/**
 * The answer to "when did this workflow last run on its schedule, and how did
 * those runs end". A failed lookup is a distinct shape from an empty one so no
 * caller can mistake the two.
 *
 * `missing` marks the one failure that is not a blindness: GitHub having no such
 * workflow file, which is only reachable after the repository itself read
 * cleanly.
 */
export type ScheduleLookup =
  | { ok: true; lastRunIso: string | null; conclusions: (string | null)[] }
  | { ok: false; reason: string; missing?: boolean }

export interface ScheduleVerdict {
  status: ScheduleStatus
  ageMs: number | null
  /** Why, for the alert body. Empty for the settled states. */
  detail: string
}

/**
 * How GitHub reports a run that did not succeed. `cancelled` and `skipped` are
 * deliberately absent: somebody stopping a run by hand, or a conditional job
 * declining to do anything, is not evidence the workflow is broken, and both
 * still prove the schedule fired.
 */
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure'])

/**
 * How many consecutive failed scheduled runs before this speaks. Two, not one:
 * each watched workflow already alerts on its own failure, so this is the slower
 * backstop for a failure that PERSISTS, and firing on a single run would
 * duplicate every ordinary transient (L36).
 */
export const FAILING_STREAK = 2

/** Leading failures among the conclusive runs, newest first. */
function failureStreak(conclusions: (string | null)[]): number {
  // A `null` conclusion is a run still in flight. It is neither a pass nor a
  // failure, so it is skipped rather than allowed to break a real streak.
  const settled = conclusions.filter((c) => c !== null)
  let streak = 0
  for (const c of settled) {
    if (!FAILED_CONCLUSIONS.has(c)) break
    streak += 1
  }
  return streak
}

/** Pure freshness decision. */
export function evaluateSchedule(
  lookup: ScheduleLookup,
  nowMs: number,
  staleMs: number,
): ScheduleVerdict {
  if (!lookup.ok) {
    // Never folded into never_ran. A lookup that could not be completed is not
    // evidence a workflow stopped running, and saying so would be an accusation
    // this check cannot support (L119, L11).
    return { status: lookup.missing ? 'missing' : 'unreadable', ageMs: null, detail: lookup.reason }
  }
  if (lookup.lastRunIso === null) {
    return { status: 'never_ran', ageMs: null, detail: 'GitHub has no scheduled runs on record for this workflow' }
  }
  const lastRunMs = Date.parse(lookup.lastRunIso)
  if (Number.isNaN(lastRunMs)) {
    // A failed parse yields NaN, and NaN compares false against every threshold,
    // so letting it reach the comparison below would silently land on healthy:
    // the one answer this check must never give without having measured it (L50).
    return {
      status: 'unreadable',
      ageMs: null,
      detail: `the most recent run's timestamp could not be read: ${lookup.lastRunIso}`,
    }
  }
  const ageMs = nowMs - lastRunMs
  // Staleness is checked before failure on purpose: a workflow that failed twice
  // and then stopped firing altogether is reported as having stopped, which is
  // the bigger news and names the action to take.
  if (ageMs > staleMs) {
    return { status: 'stale', ageMs, detail: `last scheduled run was ${lookup.lastRunIso}` }
  }
  const streak = failureStreak(lookup.conclusions)
  if (streak >= FAILING_STREAK) {
    return { status: 'failing', ageMs, detail: `the last ${streak} scheduled runs failed` }
  }
  return { status: 'healthy', ageMs, detail: '' }
}

interface GithubEnv {
  /** Dedicated read-only credential for this repository's Actions history. */
  GITHUB_ACTIONS_TOKEN?: string
  /** The workflow-BACKUP repo's token. Used only as a fallback. */
  GITHUB_TOKEN?: string
  GITHUB_CODE_REPO?: string
}

export type TokenVar = 'GITHUB_ACTIONS_TOKEN' | 'GITHUB_TOKEN'

export type GithubAccess =
  | { ok: true; repo: string; token: string; tokenVar: TokenVar }
  | { ok: false; reason: string }

/**
 * Which repository and credential this check will use.
 *
 * `GITHUB_ACTIONS_TOKEN` is preferred and `GITHUB_TOKEN` is only a fallback,
 * because the two exist for different jobs: the fallback is the workflow-backup
 * repo's push credential, and making the read-only check depend on it forces one
 * token to hold both repositories (#842). The variable actually used is carried
 * forward so a failure can name the secret to fix.
 *
 * An unset worker var arrives as the empty string rather than as absent, so every
 * value is trimmed and treated as unset when empty (L138).
 */
export function resolveGithubAccess(env: GithubEnv): GithubAccess {
  const repo = env.GITHUB_CODE_REPO?.trim()
  if (!repo) {
    return { ok: false, reason: 'GITHUB_CODE_REPO is not set, so there is no repository to ask about' }
  }
  const dedicated = env.GITHUB_ACTIONS_TOKEN?.trim()
  if (dedicated) return { ok: true, repo, token: dedicated, tokenVar: 'GITHUB_ACTIONS_TOKEN' }
  const fallback = env.GITHUB_TOKEN?.trim()
  if (fallback) return { ok: true, repo, token: fallback, tokenVar: 'GITHUB_TOKEN' }
  return {
    ok: false,
    reason:
      'neither GITHUB_ACTIONS_TOKEN nor GITHUB_TOKEN is set, so the Actions history cannot be read',
  }
}

const githubHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'bidspoke-worker',
})

export type RepoAccess = { ok: true } | { ok: false; reason: string }

/**
 * Prove the credential can see this repository at all, once per run.
 *
 * Two jobs. It turns a credential problem into ONE fact about configuration
 * rather than one indistinguishable failure per watched workflow (#843), and it
 * is what makes a per-file 404 afterwards mean "this workflow file is gone"
 * rather than "we cannot see anything here".
 *
 * The wording matters for a private repository: GitHub answers 404, not 403, for
 * a repository a token has no access to, so a 404 here is a permissions problem
 * and must not read as a missing repository.
 */
export async function checkRepoAccess(
  access: Extract<GithubAccess, { ok: true }>,
  fetchImpl: typeof fetch = fetch,
): Promise<RepoAccess> {
  let response: Response
  try {
    response = await fetchImpl(`https://api.github.com/repos/${access.repo}`, {
      headers: githubHeaders(access.token),
    })
  } catch (e) {
    return { ok: false, reason: `the request to GitHub failed: ${formatErr(e)}` }
  }
  if (response.ok) return { ok: true }
  if (response.status === 401) {
    return {
      ok: false,
      reason: `GitHub rejected the credential in ${access.tokenVar} with 401, so it is expired, revoked or malformed`,
    }
  }
  if (response.status === 403 || response.status === 404) {
    return {
      ok: false,
      reason:
        `the credential in ${access.tokenVar} cannot read ${access.repo} (GitHub returned ${response.status}). ` +
        'A private repository answers 404 rather than 403 for a token with no access to it, so this is a permissions problem and not a missing repository',
    }
  }
  return { ok: false, reason: `GitHub returned ${response.status} when asked about ${access.repo}` }
}

/**
 * Ask GitHub for the most recent SCHEDULED runs of one workflow.
 *
 * More than one run is fetched so a streak of failures can be seen at all: a page
 * size of one cannot tell a blip from a workflow failing every night (#844).
 */
export const RUNS_PER_LOOKUP = 20

/**
 * The marker the worker's dispatch driver stamps into a run's display title.
 *
 * GitHub stopped delivering this repository's scheduled events reliably on
 * 2026-08-26 (scheduled runs fell from about 24 a day to 3, while push and
 * pull_request runs kept firing normally), so the worker now dispatches these
 * workflows itself. A driven run has to count as the check running, or this
 * watch would alert for ever about a workflow running every hour.
 *
 * It cannot simply count every `workflow_dispatch` run, because that is also how
 * a PERSON runs a workflow by hand, and letting one manual press read as a live
 * schedule is the exact blindness the old `event=schedule` filter existed to
 * prevent. The actor cannot tell the two apart either: the driver dispatches
 * with a token owned by the same account that would press the button. So the
 * workflows set `run-name` from a `driver` input, and only a run carrying this
 * marker counts.
 */
export const DRIVER_MARKER = 'cloudflare-cron'

/**
 * Does this run count as evidence the check is still running on a cadence?
 *
 * A real scheduled run always does. A dispatched one does only when the driver
 * stamped it, so an unmarked dispatch (a person pressing Run workflow) is
 * ignored exactly as it was before the driver existed.
 */
export function isQualifyingRun(run: unknown): boolean {
  const event = (run as { event?: unknown })?.event
  if (event === 'schedule') return true
  if (event !== 'workflow_dispatch') return false
  const title = (run as { display_title?: unknown })?.display_title
  return typeof title === 'string' && title.includes(DRIVER_MARKER)
}

export async function lookupLastScheduledRun(
  access: Extract<GithubAccess, { ok: true }>,
  file: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ScheduleLookup> {
  // Deliberately NOT filtered to `event=schedule` any more. Runs driven by the
  // worker arrive as `workflow_dispatch` and have to be counted, so the server
  // side filter is replaced by `isQualifyingRun` below, which keeps the same
  // decision (a manual press does not count) while admitting a driven run. The
  // page is larger to compensate: unqualifying runs are now fetched and then
  // discarded, and a streak still has to be visible in what survives.
  const url = `https://api.github.com/repos/${access.repo}/actions/workflows/${file}/runs?per_page=${RUNS_PER_LOOKUP}`

  let response: Response
  try {
    response = await fetchImpl(url, { headers: githubHeaders(access.token) })
  } catch (e) {
    return { ok: false, reason: `the request to GitHub failed: ${formatErr(e)}` }
  }

  if (response.status === 404) {
    // Reached only after the repository itself read cleanly, so GitHub really
    // does not have this file and the registry is naming something that is gone.
    return {
      ok: false,
      missing: true,
      reason: `GitHub has no workflow file named ${file} in this repository`,
    }
  }
  if (!response.ok) {
    return { ok: false, reason: `GitHub returned ${response.status} for ${file}` }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (e) {
    return { ok: false, reason: `GitHub's response was not JSON: ${formatErr(e)}` }
  }

  // A body of the wrong shape must not collapse to "no runs", which is an
  // accusation (L100: a match that found nothing is not a completed read).
  const runs = (body as { workflow_runs?: unknown })?.workflow_runs
  if (!Array.isArray(runs)) {
    return { ok: false, reason: `GitHub's response had no workflow_runs list for ${file}` }
  }
  // GitHub confirming there are zero runs is a real, complete answer, and has to
  // be returned before the shape check below: an empty list trivially satisfies
  // "no run named its trigger" and would otherwise be reported as unreadable.
  if (runs.length === 0) return { ok: true, lastRunIso: null, conclusions: [] }

  // A page of runs where not one names its trigger is an API shape we cannot
  // read, not a workflow that never ran. Without this, GitHub dropping the
  // `event` field would make every run unqualifying and turn a busy workflow
  // into a confident "no scheduled runs on record": an accusation resting on an
  // answer we failed to parse (L119, L11).
  if (!runs.some((run) => typeof (run as { event?: unknown })?.event === 'string')) {
    return { ok: false, reason: `none of the runs GitHub returned for ${file} said what triggered it` }
  }

  // Filtered AFTER the shape checks, so a malformed body is still a failed
  // lookup rather than an empty one. A page holding only readable, unqualifying
  // runs IS a real absence: reading the newest run anyway would count a manual
  // press as the schedule being alive.
  const qualifying = runs.filter(isQualifyingRun)
  if (qualifying.length === 0) return { ok: true, lastRunIso: null, conclusions: [] }

  const createdAt = (qualifying[0] as { created_at?: unknown }).created_at
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    return { ok: false, reason: `the most recent run of ${file} carried no readable timestamp` }
  }
  const conclusions = qualifying.map((run) => {
    const c = (run as { conclusion?: unknown }).conclusion
    return typeof c === 'string' ? c : null
  })
  return { ok: true, lastRunIso: createdAt, conclusions }
}

/**
 * The cooldown is keyed on WHAT the run currently says, not on the group.
 *
 * Aggregating into one message introduces a trap a per-workflow cooldown did not
 * have: a key covering "the group" would let the first problem's six hours of
 * silence swallow a second workflow going dark entirely, which is two
 * independent checks sharing one status field (L53). Keying on the set of
 * verdicts means new news always speaks, and only an unchanged picture stays
 * quiet.
 */
export function cooldownSignature(configFailed: boolean, results: ScheduleCheckResult[]): string {
  if (configFailed) return 'config'
  return results
    .filter((r) => r.status !== 'healthy')
    .map((r) => `${r.file}=${r.status}`)
    .sort()
    .join(',')
}

const cooldownKey = (signature: string) => `workflow-schedule:alert:${signature}`
const COOLDOWN_TTL_SECONDS = 6 * 60 * 60

export interface ScheduleCheckResult {
  file: string
  status: ScheduleStatus
  alerted: boolean
  ageMs: number | null
  detail: string
}

/**
 * One line naming every watched workflow, its verdict and its age, for the run
 * log.
 *
 * This exists because a working check is silent, and silence is exactly what this
 * check was built to distrust (L98, L106). Without a positive reading the only
 * visible result of fixing the credential in #842 is that the alerts stop, which
 * is indistinguishable from the check breaking in a new way.
 */
export function formatScheduleSummary(results: ScheduleCheckResult[]): string {
  if (results.length === 0) return 'no workflows were checked'
  return results
    .map((r) => {
      const age = r.ageMs === null ? 'age unknown' : `last ran ${Math.round(r.ageMs / H)}h ago`
      return `${r.file}=${r.status} (${age})`
    })
    .join('; ')
}

/**
 * Check every watched workflow and alert each Slack org, once per cooldown, about
 * everything that is dark, failing or unreadable.
 *
 * `unreadable` alerts too. A check that cannot see is not a check that passed,
 * and leaving it quiet is how a guard becomes indistinguishable from no guard
 * (L98).
 */
export async function runWorkflowScheduleWatch(
  supabase: SupabaseClient,
  kv: KVNamespace,
  env: GithubEnv,
  nowMs: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<ScheduleCheckResult[]> {
  const { data: conns, error: connsError } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  logReadFailure('workflow-schedule-watch', 'slack connections', connsError)
  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  // Configuration and credential first, once. Every workflow shares the answer,
  // so asking per workflow would produce N identical failures and would leave a
  // per-file 404 meaning nothing (#842, #843).
  const access = resolveGithubAccess(env)
  let configFailure: string | null = access.ok ? null : access.reason
  if (access.ok && configFailure === null) {
    try {
      const repo = await checkRepoAccess(access, fetchImpl)
      if (!repo.ok) configFailure = repo.reason
    } catch (e) {
      configFailure = `the repository check failed: ${formatErr(e)}`
    }
  }

  const results: ScheduleCheckResult[] = []
  const problems: { workflow: WatchedWorkflow; verdict: ScheduleVerdict }[] = []

  for (const workflow of WATCHED_WORKFLOWS) {
    if (configFailure !== null || !access.ok) {
      results.push({ file: workflow.file, status: 'unreadable', alerted: false, ageMs: null, detail: configFailure ?? '' })
      continue
    }
    // Each workflow's lookup gets its own failure boundary. A watchdog must not
    // share the abort-on-error behaviour of the work it watches (L71): without
    // this, one thrown lookup leaves every workflow after it unchecked, which
    // looks exactly like a healthy system (L73).
    let verdict: ScheduleVerdict
    try {
      verdict = evaluateSchedule(await lookupLastScheduledRun(access, workflow.file, fetchImpl), nowMs, workflow.staleMs)
    } catch (e) {
      verdict = { status: 'unreadable', ageMs: null, detail: `the check for this workflow failed: ${formatErr(e)}` }
    }
    results.push({
      file: workflow.file,
      status: verdict.status,
      alerted: false,
      ageMs: verdict.ageMs,
      detail: verdict.detail,
    })
    if (verdict.status !== 'healthy') problems.push({ workflow, verdict })
  }

  if (configFailure === null && problems.length === 0) return results

  const signature = cooldownSignature(configFailure !== null, results)
  let held = false
  try {
    held = (await kv.get(cooldownKey(signature))) !== null
  } catch (e) {
    // A protective control fails towards speaking (L42). An unreadable cooldown
    // is not evidence anybody has been told, and a duplicate message costs far
    // less than six hours of silence about a dark deploy check.
    console.error('[workflow-schedule] cooldown unreadable, alerting anyway:', formatErr(e))
  }
  if (held) return results

  const payload = {
    config: configFailure === null ? null : { reason: configFailure, files: WATCHED_WORKFLOWS.map((w) => w.file) },
    workflows: problems,
  }

  let alerted = false
  for (const orgId of orgIds) {
    try {
      if (await sendWorkflowScheduleAlert(supabase, orgId, payload)) alerted = true
    } catch (e) {
      // Failing to DELIVER a verdict must not destroy the verdict: the returned
      // results and the run log are the other half of this check's output.
      console.error(`[workflow-schedule] alert to ${orgId} failed:`, formatErr(e))
    }
  }
  if (alerted) {
    try {
      await kv.put(cooldownKey(signature), '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
    } catch (e) {
      console.error('[workflow-schedule] cooldown could not be armed:', formatErr(e))
    }
    for (const r of results) {
      if (r.status !== 'healthy') r.alerted = true
    }
  }
  return results
}
