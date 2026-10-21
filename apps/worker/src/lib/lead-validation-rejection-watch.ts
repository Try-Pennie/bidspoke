/**
 * The per reason rejection rate watch for a lead validation swap (#2592, part
 * of #934).
 *
 * WHY. Phase 5 of #934 replaces each bidding workflow's hand written
 * `validate_bidding_and_state` code step with the lead validation node, one
 * workflow at a time, keeping the step's namespace. Three proofs run before the
 * paste, but a difference none of them reached (a lead shape no fixture held,
 * a Constants value read differently) shows up in production as a reason's
 * share of the leads moving. This check is what notices, and its page is the
 * rollback trigger written on the swap's issue.
 *
 * WHAT IT JUDGES. Every hour, each watched workflow's finished live runs in the
 * WINDOW_MINUTES ending SETTLE_MS ago, against the same workflow's runs over the
 * BASELINE_DAYS before that window. A run is counted by where it ENDED
 * (workflow_executions.final_node_namespace) and the reason its answer gave
 * (response_body.reason), which is the same field for the script and the node:
 * the money gate's A/B mode found the two answers identical (#2623), so the
 * baseline week of script runs and the hours of node runs are read the same way.
 * The buckets are each reason on the shared list (LEAD_REJECTION_REASONS), a
 * reason not on it, a run that failed at the step, and all rejections together.
 * The denominator is every finished live run of the workflow: about 4 in 20,835
 * of GigFi's runs did not reach the step in the week measured.
 *
 * THE RULE, set from GigFi's real traffic (2026-10-14 13:00 to 2026-10-21 21:00
 * UTC, 20,835 runs, its whole workflow_executions retention). GigFi gets leads
 * only from about 13:00 to 23:00 UTC, 200 to 500 an hour. Over every two hour
 * window of that week (68 windows of 416 to 983 runs):
 *  - ineligible state ran 8.1% to 14.4% of a window against 11.4% for the week
 *    (0.71 to 1.26 times), loan amount exceeds maximum 11.8% to 26.0% against
 *    15.9% (0.74 to 1.64 times), all rejections 21.5% to 39.7% against 27.3%;
 *  - every other reason was 0, apart from 2 invalid name in the week.
 * So a reason holding at least COMMON_SHARE of the week pages when its share
 * falls to DROP_RATIO of the week's (a check letting through what it used to
 * reject) or rises to RISE_RATIO times (a check rejecting too much): neither
 * was reached by any window. A reason the week barely saw pages when it reaches
 * RARE_MIN_COUNT leads and RARE_MIN_POINTS above its share, which no window came
 * near (the most was 2). A window of fewer than MIN_RUNS is not judged (the
 * first hour of each day and every night), and a baseline of fewer than
 * BASELINE_MIN_RUNS (about a day) is unmeasured. Re-measure after a few weeks of
 * node runs (L172).
 *
 * WHAT IT CANNOT SEE. A reason with no real cases (bidding not active, military
 * status ineligible and unqualified on GigFi) can only rise: a check that stops
 * rejecting it is invisible here and was proved by the grid instead. A small
 * shift inside the measured spread is not a page.
 *
 * Conventions shared with the other rate checks (partner-error-rate.ts): the
 * incident record through markAlerted, recordPaged and announceRecovery under
 * the registered signal, a COOLDOWN between repeat pages, an all-clear only on a
 * judged normal window at least one whole window after the last shift, and an
 * open incident kept, never stood down, through hours with no leads. Its own
 * heartbeat (cron-heartbeat.ts) and a job_runs record, and a count it cannot
 * read throws, so a run that cannot judge is a failed run of the job rather
 * than a quiet workflow.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { LEAD_REJECTION_REASONS } from '@bidspoke/workflow-definition'
import { orgIdsToTell, slackOrgIds } from './alert-fanout'
import { announceRecovery, markAlerted, markSpikeSeen, recordPaged, refreshAlerted, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { readActiveWorkflows, type ActiveWorkflowRow } from './active-workflows'
import { withJobRun, type JobRunEnding } from './job-run-record'
import { getSlackConnection, sendLeadValidationRejectionAlert, sendRecoveryAlert } from './slack'
import { formatErr } from './format-error'

/** The incident record's signal. */
export const LEAD_VALIDATION_REJECTION_SIGNAL = 'lead-validation-rejection-rate'
/** The heartbeat and job_runs name. */
export const LEAD_VALIDATION_REJECTION_JOB = 'lead-validation-rejection-watch'
/** The words the all-clear names the alert by, which the incident record's label repeats (L118). */
export const LEAD_VALIDATION_REJECTION_RECOVERY_WORDS = 'lead validation rejections'

export const WINDOW_MINUTES = 120
export const BASELINE_DAYS = 7
/** The judged window ends this long before the run: a run is written once it finishes, in seconds. */
export const SETTLE_MS = 2 * 60 * 1000
/** Between repeat pages for a shift that stands. The check runs hourly. */
export const COOLDOWN_TTL_SECONDS = 3 * 60 * 60

export interface RejectionRule {
  minRuns: number
  baselineMinRuns: number
  /** A reason at or above this share of the baseline is judged by ratio; below it, by the rare floor. */
  commonShare: number
  dropRatio: number
  riseRatio: number
  rareMinCount: number
  rareMinPoints: number
}

export const REJECTION_RULE: RejectionRule = {
  minRuns: 300,
  baselineMinRuns: 3_000,
  commonShare: 0.02,
  dropRatio: 0.5,
  riseRatio: 2,
  rareMinCount: 10,
  rareMinPoints: 0.03,
}

export interface RejectionWatch {
  workflowId: string
  /** The validation step, which keeps its namespace across the swap. */
  namespace: string
  reasons: readonly string[]
}

export const REJECTION_WATCHES: readonly RejectionWatch[] = [
  { workflowId: '6624acd0-bf61-4d21-85fc-4371ca7ed77d', namespace: 'validate_bidding_and_state', reasons: LEAD_REJECTION_REASONS },
]

/** One window's runs: every finished live run, those that ended at the step, those that failed there, and the rejections by reason. */
export interface RejectionCounts {
  runs: number
  atStep: number
  failed: number
  byReason: Record<string, number>
}

export const OTHER_REASON_BUCKET = 'a reason not on the list'
export const FAILED_BUCKET = 'the step failed'
export const ALL_REJECTIONS_BUCKET = 'all rejections'

export interface BucketCount {
  bucket: string
  count: number
}

/**
 * The buckets a window is judged in: each listed reason, a reason not on the
 * list, a failed step, and all rejections. Refuses counts that cannot add up,
 * so a misread is never judged as a shift (L90).
 */
export function rejectionBuckets(c: RejectionCounts): BucketCount[] {
  const reasons = Object.entries(c.byReason)
  const listed = reasons.reduce((a, [, n]) => a + n, 0)
  const other = c.atStep - c.failed - listed
  if (c.atStep > c.runs || c.failed > c.atStep || other < 0 || reasons.some(([, n]) => n < 0)) {
    throw new Error(`rejection counts do not add up: ${c.runs} runs, ${c.atStep} at the step, ${c.failed} failed, ${listed} with a listed reason`)
  }
  return [
    ...reasons.map(([bucket, count]) => ({ bucket, count })),
    { bucket: OTHER_REASON_BUCKET, count: other },
    { bucket: FAILED_BUCKET, count: c.failed },
    { bucket: ALL_REJECTIONS_BUCKET, count: listed + other },
  ]
}

export interface RejectionShift {
  bucket: string
  direction: 'rose' | 'fell'
  count: number
  share: number
  baselineCount: number
  baselineShare: number
}

export type RejectionVerdict =
  | { state: 'unjudged'; runs: number }
  | { state: 'unmeasured'; runs: number; baselineRuns: number; reason: string }
  | { state: 'normal'; runs: number; baselineRuns: number }
  | { state: 'shifted'; runs: number; baselineRuns: number; shifts: RejectionShift[] }

/** Pure: whether a window's shares moved from the baseline's, bucket by bucket. */
export function judgeRejectionShares(current: RejectionCounts, baseline: RejectionCounts, rule: RejectionRule = REJECTION_RULE): RejectionVerdict {
  const now = rejectionBuckets(current)
  if (current.runs < rule.minRuns) return { state: 'unjudged', runs: current.runs }
  const before = new Map(rejectionBuckets(baseline).map((b) => [b.bucket, b.count]))
  if (baseline.runs < rule.baselineMinRuns) {
    return { state: 'unmeasured', runs: current.runs, baselineRuns: baseline.runs, reason: `the week before holds ${baseline.runs} runs, under the ${rule.baselineMinRuns} it needs` }
  }
  const shifts: RejectionShift[] = []
  for (const { bucket, count } of now) {
    const baselineCount = before.get(bucket) ?? 0
    const share = count / current.runs
    const baselineShare = baselineCount / baseline.runs
    const base = { bucket, count, share, baselineCount, baselineShare }
    if (baselineShare >= rule.commonShare) {
      if (share <= baselineShare * rule.dropRatio) shifts.push({ ...base, direction: 'fell' })
      else if (share >= baselineShare * rule.riseRatio) shifts.push({ ...base, direction: 'rose' })
    } else if (count >= rule.rareMinCount && share - baselineShare >= rule.rareMinPoints) {
      shifts.push({ ...base, direction: 'rose' })
    }
  }
  return shifts.length
    ? { state: 'shifted', runs: current.runs, baselineRuns: baseline.runs, shifts }
    : { state: 'normal', runs: current.runs, baselineRuns: baseline.runs }
}

// ── Reads ───────────────────────────────────────────────────────────────────

type CountQuery = PromiseLike<{ count: number | null; error: unknown }>

async function headCount(query: CountQuery, label: string): Promise<number> {
  const { count, error } = await query
  if (error) throw new Error(`${LEAD_VALIDATION_REJECTION_JOB} ${label}: ${formatErr(error)}`)
  if (typeof count !== 'number') throw new Error(`${LEAD_VALIDATION_REJECTION_JOB} ${label}: no count returned`)
  return count
}

/**
 * Head counts, never rows (the 1,000 row cap), over workflow_executions on its
 * (workflow_id, started_at) index. A week of GigFi's runs counted in 48 ms warm
 * on 2026-10-21. Throws when any count cannot be read.
 */
export async function readRejectionCounts(supabase: SupabaseClient, watch: RejectionWatch, from: Date, to: Date): Promise<RejectionCounts> {
  const base = () => supabase
    .from('workflow_executions')
    .select('id', { count: 'exact', head: true })
    .eq('workflow_id', watch.workflowId)
    .eq('is_test', false)
    .neq('status', 'running')
    .gte('started_at', from.toISOString())
    .lt('started_at', to.toISOString())
  const atStep = () => base().eq('final_node_namespace', watch.namespace)
  const span = `${from.toISOString()} to ${to.toISOString()}`
  const [runs, at, failed, ...byReason] = await Promise.all([
    headCount(base(), `runs ${span}`),
    headCount(atStep(), `runs ending at ${watch.namespace} ${span}`),
    headCount(atStep().eq('status', 'failed'), `failed ${watch.namespace} ${span}`),
    ...watch.reasons.map((r) => headCount(atStep().neq('status', 'failed').eq('response_body->>reason', r), `${r} ${span}`)),
  ])
  return { runs, atStep: at, failed, byReason: Object.fromEntries(watch.reasons.map((r, i) => [r, byReason[i]])) }
}

// ── The check ───────────────────────────────────────────────────────────────

export interface RejectionWatchSummary {
  judged: Array<{ workflowId: string; state: RejectionVerdict['state']; runs: number; baselineRuns?: number }>
  paged: string[]
  allClear: string[]
}

/** Every hour: judge each watched workflow's last two hours and page, hold or stand down. */
export async function runLeadValidationRejectionWatch(
  supabase: SupabaseClient,
  kv: RecoveryKv,
  appUrl: string,
  now: number = Date.now(),
  watches: readonly RejectionWatch[] = REJECTION_WATCHES,
): Promise<RejectionWatchSummary> {
  const summary: RejectionWatchSummary = { judged: [], paged: [], allClear: [] }
  const orgIds = orgIdsToTell(await slackOrgIds(supabase, LEAD_VALIDATION_REJECTION_JOB, 'measure-from-database'))
  if (orgIds.length === 0) return summary
  const workflows = await readActiveWorkflows<Pick<ActiveWorkflowRow, 'id' | 'name' | 'organization_id' | 'slack_channel'>>(
    supabase, 'id, name, organization_id, slack_channel', `${LEAD_VALIDATION_REJECTION_JOB} workflows`, orgIds,
  )
  const byId = new Map(workflows.map((w) => [w.id, w]))

  const windowEnd = new Date(now - SETTLE_MS)
  const windowStart = new Date(windowEnd.getTime() - WINDOW_MINUTES * 60 * 1000)
  const baselineStart = new Date(windowStart.getTime() - BASELINE_DAYS * 24 * 3_600_000)

  for (const watch of watches) {
    const wf = byId.get(watch.workflowId)
    if (!wf) continue
    const current = await readRejectionCounts(supabase, watch, windowStart, windowEnd)
    // A thin window is not judged, so the week is not read for it.
    const verdict = current.runs < REJECTION_RULE.minRuns
      ? judgeRejectionShares(current, current)
      : judgeRejectionShares(current, await readRejectionCounts(supabase, watch, baselineStart, windowStart))
    summary.judged.push({ workflowId: wf.id, state: verdict.state, runs: verdict.runs, ...(verdict.state === 'unjudged' ? {} : { baselineRuns: verdict.baselineRuns }) })

    const cooldownKey = `${LEAD_VALIDATION_REJECTION_SIGNAL}-cooldown:${wf.id}`
    const incident: IncidentContext = { scope: { kind: 'org', organizationId: wf.organization_id }, subjectLabel: wf.name }

    if (verdict.state === 'unjudged' || verdict.state === 'unmeasured') {
      // Neither a sighting nor a recovery: an open incident is kept through a
      // night with no leads, never stood down by it (#1803).
      await refreshAlerted(kv, LEAD_VALIDATION_REJECTION_SIGNAL, wf.id)
      continue
    }

    if (verdict.state === 'normal') {
      const cleared = await announceRecovery(
        kv,
        LEAD_VALIDATION_REJECTION_SIGNAL,
        wf.id,
        cooldownKey,
        incident,
        async (alertedAt, endedAt, firstHealthyAt) => {
          const slack = await getSlackConnection(supabase, wf.organization_id)
          if (!slack) return false
          return sendRecoveryAlert(slack, wf.slack_channel ?? slack.default_channel, {
            signal: LEAD_VALIDATION_REJECTION_RECOVERY_WORDS,
            subject: wf.name,
            alertedAt,
            endedAt,
            firstHealthyAt,
            measuredWindowMinutes: WINDOW_MINUTES,
            recoveredPhrase: 'is rejecting leads at the shares of the week before again',
            url: `${appUrl}/workflows/${wf.id}`,
          })
        },
        // A whole window past the last shift, so the all-clear is judged on
        // hours that hold none of it.
        { now, rearmMinutes: WINDOW_MINUTES },
      )
      if (cleared) summary.allClear.push(wf.id)
      continue
    }

    console.log(`[${LEAD_VALIDATION_REJECTION_JOB}] shifted workflow_id=${wf.id} runs=${verdict.runs} ${verdict.shifts.map((s) => `${s.bucket}:${s.direction}:${s.count}`).join(' ')}`)
    await markSpikeSeen(kv, LEAD_VALIDATION_REJECTION_SIGNAL, wf.id, now)
    if ((await kv.get(cooldownKey)) !== null) continue
    const slack = await getSlackConnection(supabase, wf.organization_id)
    const sent = slack !== null && await sendLeadValidationRejectionAlert(slack, wf.slack_channel ?? slack.default_channel, {
      workflow_id: wf.id,
      workflow_name: wf.name,
      namespace: watch.namespace,
      runs: verdict.runs,
      baseline_runs: verdict.baselineRuns,
      baseline_days: BASELINE_DAYS,
      shifts: verdict.shifts,
      window_minutes: WINDOW_MINUTES,
      window_end: windowEnd.toISOString(),
      app_url: appUrl,
    })
    // The marker before the cooldown (#2058): a cut between them costs at worst
    // a repeated page, never a lost all-clear.
    if (sent) {
      await markAlerted(kv, LEAD_VALIDATION_REJECTION_SIGNAL, wf.id, incident, now)
      await recordPaged(kv, LEAD_VALIDATION_REJECTION_SIGNAL, wf.id, incident, now)
      await kv.put(cooldownKey, '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
      summary.paged.push(wf.id)
    }
  }
  return summary
}

function endingOf(s: RejectionWatchSummary): JobRunEnding {
  const judged = s.judged.filter((j) => j.state === 'normal' || j.state === 'shifted')
  return {
    // A run that judged nothing (no leads, no Slack, the workflow switched off)
    // is recorded as unmeasured, never as ok (L557).
    outcome: judged.length ? 'ok' : 'unmeasured',
    summary: { judged: s.judged, paged: s.paged, all_clear: s.allClear },
  }
}

/** The scheduled entry: the check under a job run record. */
export function runLeadValidationRejectionWatchForEnv(supabase: SupabaseClient, kv: RecoveryKv, appUrl: string): Promise<RejectionWatchSummary> {
  return withJobRun(supabase, LEAD_VALIDATION_REJECTION_JOB, () => runLeadValidationRejectionWatch(supabase, kv, appUrl), endingOf)
}
