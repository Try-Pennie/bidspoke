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
 * Two traps it is shaped around.
 *
 * An EMPTY answer and a FAILED lookup are indistinguishable if you read only the
 * count, and treating a failure as "it never ran" turns an API blip into a false
 * accusation about a workflow that is running fine (L119). They are separate
 * states here, and only a confirmed-empty answer accuses.
 *
 * And the lookup asks for SCHEDULED runs only. Counting a manual dispatch would
 * let someone running the workflow by hand mask a cron that has been dead for
 * weeks, which is the one situation this exists for.
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
  /** What stops being true while this workflow is dark (for the alert body). */
  dependents: string
}

/**
 * Every workflow in `.github/workflows` that runs on a schedule. A registry
 * rather than a single check, because every scheduled workflow has the same
 * silence and fixing only the one that prompted this would leave the next one
 * blind (L30).
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
    dependents:
      'nothing is checking whether the live worker and the live site are running the code that is on main, so a failed deploy would leave production behind with no signal',
  },
  {
    file: 'db-types-drift.yml',
    label: 'Database types drift',
    cron: '0 8 * * *',
    // Daily cadence, 26h window, matching the daily worker crons.
    staleMs: 26 * H,
    dependents:
      'nothing is checking that the generated database types still match the live schema, so a migration can drift from the types the worker compiles against',
  },
]

export type ScheduleStatus = 'healthy' | 'stale' | 'never_ran' | 'unreadable'

/**
 * The answer to "when did this workflow last run on its schedule". A failed
 * lookup is a distinct shape from an empty one so no caller can mistake the two.
 */
export type ScheduleLookup =
  | { ok: true; lastRunIso: string | null }
  | { ok: false; reason: string }

export interface ScheduleVerdict {
  status: ScheduleStatus
  ageMs: number | null
  /** Why, for the alert body. Empty for the settled states. */
  detail: string
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
    return { status: 'unreadable', ageMs: null, detail: lookup.reason }
  }
  if (lookup.lastRunIso === null) {
    return { status: 'never_ran', ageMs: null, detail: 'GitHub has no scheduled runs on record for this workflow' }
  }
  const ageMs = nowMs - Date.parse(lookup.lastRunIso)
  if (ageMs > staleMs) {
    return { status: 'stale', ageMs, detail: `last scheduled run was ${lookup.lastRunIso}` }
  }
  return { status: 'healthy', ageMs, detail: '' }
}

interface GithubEnv {
  GITHUB_TOKEN?: string
  GITHUB_CODE_REPO?: string
}

/**
 * Ask GitHub for the most recent SCHEDULED run of one workflow.
 *
 * Every way this can fail returns `ok: false` with a reason, including missing
 * configuration: an unset worker var arrives as the empty string rather than as
 * absent, so it is checked explicitly instead of being allowed to build a URL
 * that would 404 and read like a workflow nobody has ever run (L138).
 */
export async function lookupLastScheduledRun(
  env: GithubEnv,
  file: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ScheduleLookup> {
  const repo = env.GITHUB_CODE_REPO?.trim()
  if (!repo) {
    return { ok: false, reason: 'GITHUB_CODE_REPO is not set, so there is no repository to ask about' }
  }
  const token = env.GITHUB_TOKEN?.trim()
  if (!token) {
    return { ok: false, reason: 'GITHUB_TOKEN is not set, so the Actions history cannot be read' }
  }

  // event=schedule is the whole point: a manual dispatch must not count as the
  // schedule still firing.
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${file}/runs?event=schedule&per_page=1`

  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'bidspoke-worker',
      },
    })
  } catch (e) {
    return { ok: false, reason: `the request to GitHub failed: ${formatErr(e)}` }
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
  if (runs.length === 0) return { ok: true, lastRunIso: null }

  const createdAt = (runs[0] as { created_at?: unknown }).created_at
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    return { ok: false, reason: `the most recent run of ${file} carried no readable timestamp` }
  }
  return { ok: true, lastRunIso: createdAt }
}

const cooldownKey = (file: string) => `workflow-schedule:${file}:alerted`
const COOLDOWN_TTL_SECONDS = 6 * 60 * 60

export interface ScheduleCheckResult {
  file: string
  status: ScheduleStatus
  alerted: boolean
  ageMs: number | null
  detail: string
}

/**
 * Check every watched workflow and alert each Slack org, once per per-workflow
 * cooldown, for any that are dark or unreadable.
 *
 * `unreadable` alerts too. A check that cannot see is not a check that passed,
 * and leaving it quiet is how a guard becomes indistinguishable from no guard
 * (L98). The cooldown keeps a misconfiguration to four messages a day, and the
 * message names exactly what to set.
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

  const results: ScheduleCheckResult[] = []
  for (const workflow of WATCHED_WORKFLOWS) {
    const lookup = await lookupLastScheduledRun(env, workflow.file, fetchImpl)
    const verdict = evaluateSchedule(lookup, nowMs, workflow.staleMs)

    if (verdict.status === 'healthy') {
      results.push({ file: workflow.file, status: 'healthy', alerted: false, ageMs: verdict.ageMs, detail: '' })
      continue
    }
    const problem = verdict.status

    if (await kv.get(cooldownKey(workflow.file))) {
      results.push({
        file: workflow.file,
        status: problem,
        alerted: false,
        ageMs: verdict.ageMs,
        detail: verdict.detail,
      })
      continue
    }

    let alerted = false
    for (const orgId of orgIds) {
      if (
        await sendWorkflowScheduleAlert(supabase, orgId, workflow, {
          status: problem,
          ageMs: verdict.ageMs,
          detail: verdict.detail,
        })
      )
        alerted = true
    }
    if (alerted) await kv.put(cooldownKey(workflow.file), '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
    results.push({
      file: workflow.file,
      status: problem,
      alerted,
      ageMs: verdict.ageMs,
      detail: verdict.detail,
    })
  }
  return results
}
