/**
 * Pages when a partner ping keeps failing, now that a failure is a completed no
 * bid rather than a failed run (#2582).
 *
 * Until #2582, a LendSwift failure made the RML LendSwift run fail with HTTP 500,
 * and the failure saturation page ("Most Runs Failing", upstream-outage.ts) was
 * what told the team LendSwift was down: on 2026-10-21 it paged at 10:27 UTC, 16
 * of 27 runs. Since #2582 the ping_lendswift script ends such a lead as a no bid
 * and writes `lendswift_error` on its step output, so the run succeeds and that
 * page can no longer fire for it. This check reads the marker instead.
 *
 * WHAT IT JUDGES. Every minute, over the trailing WINDOW_MINUTES, the watched
 * step's runs that completed in the window: how many there were, and how many
 * carry the marker. It pages when there were at least MIN_PINGS of them, at least
 * MIN_ERRORS carried the marker, and the marker's share is at least ERROR_SHARE.
 *
 * HOW THE BAR WAS SET. Measured on execution_steps over the 7 days to 2026-10-21
 * (the step's whole retention), with a failed ping_lendswift step standing for
 * what is now a marked one, over a trailing 5 minute window evaluated every
 * minute, exactly as this check slides:
 *  - outside the incident: 10,045 windows, 9,890 with at least 10 pings (the
 *    5th percentile window held 12). The worst share was 5.3% (one ping in 19),
 *    the 99.9th percentile 3.2%, and no window held more than 2 failures;
 *  - the 2026-10-21 incident: windows reached 75% and 100%, 22 failures at most.
 * At 10 pings, 5 errors and 25%, no window outside the incident would have paged
 * (five times the worst normal share, and more than twice its worst count), and
 * the incident would have paged from 10:25 UTC, two minutes before Most Runs
 * Failing did. Re-measure these once a few weeks of marked steps exist (L172).
 *
 * The watches are a list so a second partner with the same marker (GigFi's
 * ping_gigfi has the same pattern) can be added beside LendSwift.
 *
 * Conventions shared with the other minute rate checks (slow-execution-rate.ts):
 * a page under the minute page claim with a 30 minute cooldown, the incident
 * record through markAlerted, recordPaged and announceRecovery, and an all-clear
 * held until a ping is answered again (#817). Its own heartbeat (cron-heartbeat.ts,
 * `partner-error-rate`), and a read it cannot make throws, so a run that cannot
 * judge counts as a failed run of the job rather than reading as a quiet partner.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { minuteAlertClaimKey, minuteAllClearClaim, orgIdsToTell, postMinutePage, slackOrgIds } from './alert-fanout'
import type { AlertClaims } from './alert-claim'
import { announceRecovery, markAlerted, markSpikeSeen, recordPaged, refreshAlerted, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { getSlackConnection, sendPartnerErrorRateAlert, sendRecoveryAlert } from './slack'
import { fetchAllPaged } from './paginate'
import { readActiveWorkflows, type ActiveWorkflowRow } from './active-workflows'

/** The incident record's signal and the heartbeat's job id. */
export const PARTNER_ERROR_RATE_SIGNAL = 'partner-error-rate'
export const PARTNER_ERROR_RATE_JOB = 'partner-error-rate'
/** The words the all-clear names the alert by, which the incident record's label repeats (L118). */
export const PARTNER_ERROR_RECOVERY_WORDS = 'partner error'

export const WINDOW_MINUTES = 5
export const MIN_PINGS = 10
export const MIN_ERRORS = 5
export const ERROR_SHARE = 0.25
export const COOLDOWN_TTL_SECONDS = 30 * 60
/**
 * How long before the window a counted step may have STARTED. A step is judged by
 * when it completed, but the read is bounded on started_at, which the table is
 * partitioned and indexed on (idx_steps_wf_ns_started). ping_lendswift waits at
 * most 60 s and its node times out at 65 s, so two minutes cannot drop one.
 */
export const STEP_START_SLACK_MS = 2 * 60 * 1000

export interface PartnerErrorWatch {
  workflowId: string
  /** The code node whose output carries the marker. */
  namespace: string
  /** The output field a failed partner call is recorded in. */
  marker: string
  /** The partner, in the page's words. */
  partner: string
}

export const PARTNER_ERROR_WATCHES: readonly PartnerErrorWatch[] = [
  { workflowId: 'e1b810da-16c0-49eb-bf12-ba1c9b67c914', namespace: 'ping_lendswift', marker: 'lendswift_error', partner: 'LendSwift' },
]

/** One completed ping in the window: the marker's kind, or null when the partner answered. */
export interface PingRow {
  kind: string | null
}

export type PartnerErrorVerdict =
  | { state: 'unjudged'; pings: number; errors: number }
  | { state: 'healthy'; pings: number; errors: number }
  | { state: 'spiking'; pings: number; errors: number; kinds: Record<string, number> }

/** Pure: whether the window's pings show the partner failing. */
export function judgePartnerErrors(rows: readonly PingRow[]): PartnerErrorVerdict {
  const pings = rows.length
  const failed = rows.filter((r) => r.kind !== null)
  const errors = failed.length
  if (pings < MIN_PINGS) return { state: 'unjudged', pings, errors }
  if (errors < MIN_ERRORS || errors / pings < ERROR_SHARE) return { state: 'healthy', pings, errors }
  const kinds: Record<string, number> = {}
  for (const r of failed) kinds[r.kind as string] = (kinds[r.kind as string] ?? 0) + 1
  return { state: 'spiking', pings, errors, kinds }
}

export interface PartnerErrorRateSummary {
  judged: Array<{ workflowId: string; state: PartnerErrorVerdict['state']; pings: number; errors: number }>
  paged: string[]
  allClear: string[]
}

/** The completed pings of one watch in the window. Throws when they cannot be read. */
async function readPings(supabase: SupabaseClient, watch: PartnerErrorWatch, windowStartMs: number): Promise<PingRow[]> {
  // The marker's kind only: the step output also carries what the partner said,
  // which this check has no use for.
  const rows = await fetchAllPaged<{ kind: unknown }>(
    (from, to) => supabase
      .from('execution_steps')
      .select(`id, kind:output->${watch.marker}->>kind`)
      .eq('workflow_id', watch.workflowId)
      .eq('step_namespace', watch.namespace)
      .gte('started_at', new Date(windowStartMs - STEP_START_SLACK_MS).toISOString())
      .gte('completed_at', new Date(windowStartMs).toISOString())
      .eq('is_test', false)
      .order('started_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
    `${PARTNER_ERROR_RATE_JOB} ${watch.namespace} query`,
  )
  // `->>` reads text, so a present marker gives its kind as a string. A marker
  // whose kind is not text still marks a failure; only its absence is an answer.
  return rows.map((r) => ({ kind: r.kind === null || r.kind === undefined ? null : typeof r.kind === 'string' ? r.kind : 'unknown' }))
}

/**
 * Every minute: judge each watched partner's pings and page, hold or stand down.
 * `claims` makes a stalled tick overlapping the next minute's post the page and
 * the all-clear once (#2062); the scheduled handler always passes it.
 */
export async function runPartnerErrorRateCheck(
  supabase: SupabaseClient,
  kv: RecoveryKv,
  appUrl: string,
  claims?: AlertClaims,
  watches: readonly PartnerErrorWatch[] = PARTNER_ERROR_WATCHES,
): Promise<PartnerErrorRateSummary> {
  const summary: PartnerErrorRateSummary = { judged: [], paged: [], allClear: [] }
  const orgIds = orgIdsToTell(await slackOrgIds(supabase, PARTNER_ERROR_RATE_JOB, 'measure-from-database'))
  if (orgIds.length === 0) return summary

  // Only a watched workflow that is live, in an organization with Slack.
  const workflows = await readActiveWorkflows<Pick<ActiveWorkflowRow, 'id' | 'name' | 'organization_id' | 'slack_channel'>>(
    supabase, 'id, name, organization_id, slack_channel', `${PARTNER_ERROR_RATE_JOB} workflows`, orgIds,
  )
  const byId = new Map(workflows.map((w) => [w.id, w]))

  const now = Date.now()
  const windowStartMs = now - WINDOW_MINUTES * 60 * 1000

  for (const watch of watches) {
    const wf = byId.get(watch.workflowId)
    if (!wf) continue
    const verdict = judgePartnerErrors(await readPings(supabase, watch, windowStartMs))
    summary.judged.push({ workflowId: wf.id, state: verdict.state, pings: verdict.pings, errors: verdict.errors })

    const cooldownKey = `${PARTNER_ERROR_RATE_SIGNAL}-cooldown:${wf.id}`
    const incident: IncidentContext = { scope: { kind: 'org', organizationId: wf.organization_id }, subjectLabel: wf.name }

    if (verdict.state === 'unjudged') {
      // Too few pings to judge: neither a sighting nor a recovery. An open
      // incident is kept, never stood down on a quiet stretch (#1803).
      await refreshAlerted(kv, PARTNER_ERROR_RATE_SIGNAL, wf.id)
      continue
    }

    if (verdict.state === 'healthy') {
      // Stood down only once the partner is seen answering again: a window with
      // no answered ping is not a recovery (#817).
      const answered = verdict.pings - verdict.errors
      const cleared = await announceRecovery(
        kv,
        PARTNER_ERROR_RATE_SIGNAL,
        wf.id,
        cooldownKey,
        incident,
        async (alertedAt, endedAt) => {
          const slack = await getSlackConnection(supabase, wf.organization_id)
          if (!slack) return false
          return sendRecoveryAlert(slack, wf.slack_channel ?? slack.default_channel, {
            signal: PARTNER_ERROR_RECOVERY_WORDS,
            subject: wf.name,
            alertedAt,
            endedAt,
            measuredWindowMinutes: WINDOW_MINUTES,
            recoveredPhrase: `is getting answers from ${watch.partner} again`,
            url: `${appUrl}/workflows/${wf.id}`,
          })
        },
        { hasEvidence: () => answered >= 1, claim: minuteAllClearClaim(claims, PARTNER_ERROR_RATE_SIGNAL, wf.id) },
      )
      if (cleared) summary.allClear.push(wf.id)
      continue
    }

    console.log(`[${PARTNER_ERROR_RATE_JOB}] ${watch.partner} failing workflow_id=${wf.id} errors=${verdict.errors}/${verdict.pings} window=${WINDOW_MINUTES}m`)
    // The incident's running end, on every failing tick, before the cooldown gate (#814).
    await markSpikeSeen(kv, PARTNER_ERROR_RATE_SIGNAL, wf.id, now)

    const outcome = await postMinutePage({
      claims,
      key: minuteAlertClaimKey('page', PARTNER_ERROR_RATE_SIGNAL, wf.id),
      inCooldown: async () => (await kv.get(cooldownKey)) !== null,
      send: async () => Boolean(await sendPartnerErrorRateAlert(supabase, wf.organization_id, wf.slack_channel ?? null, {
        workflow_id: wf.id,
        workflow_name: wf.name,
        partner: watch.partner,
        error_count: verdict.errors,
        ping_count: verdict.pings,
        kinds: verdict.kinds,
        window_minutes: WINDOW_MINUTES,
        timestamp: new Date(now).toISOString(),
      }, appUrl)),
    })
    // The marker before the cooldown (#2058): a cut between them costs at worst a
    // repeated page, never a lost all-clear.
    if (outcome === 'sent') {
      await markAlerted(kv, PARTNER_ERROR_RATE_SIGNAL, wf.id, incident, now)
      await recordPaged(kv, PARTNER_ERROR_RATE_SIGNAL, wf.id, incident, now)
      await kv.put(cooldownKey, '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
      summary.paged.push(wf.id)
    }
  }
  return summary
}
