/**
 * Volume anomaly detection — PRD Section 3.6 / 10.3
 *
 * Runs on a scheduled cron trigger (daily at 13:00 UTC = 9am EDT).
 * For each org that has Slack configured, compares yesterday's execution
 * volume to a same-day-type rolling baseline (weekend vs weekday). If volume
 * dropped below 50% or spiked above 200%, sends a Slack alert.
 *
 * Reads from the `workflow_stats_daily` rollup table (refreshed every 5
 * minutes by pg_cron) rather than `workflow_executions` directly. The live
 * table can exceed PostgREST's 1000-row default cap in a single high-volume
 * day, so an unbounded SELECT silently dropped most rows and surfaced
 * "yesterday: 0" alerts against a tiny early-window baseline.
 *
 * Day-type matching: Saturdays/Sundays are compared only against prior
 * weekend days; Mon-Fri are compared only against prior weekdays. This
 * avoids false drops when a low-traffic weekend lands next to busy weekdays.
 *
 * Thresholds:
 *   low_threshold_pct  — alert if yesterday < baseline * (low/100).  Default: 50
 *   high_threshold_pct — alert if yesterday > baseline * (high/100). Default: 200
 *
 * At least 3 same-day-type baseline days are required before anomalies are flagged.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getSlackConnection } from './slack'

export const DEFAULT_LOW_THRESHOLD_PCT = 50
export const DEFAULT_HIGH_THRESHOLD_PCT = 200
export const MIN_BASELINE_DAYS = 3

export interface AnomalyResult {
  org_id: string
  yesterday_count: number
  baseline_avg: number
  kind: 'drop' | 'spike'
}

// Treat a YYYY-MM-DD string as UTC noon to avoid TZ ambiguity at day boundaries.
function isWeekend(dateStr: string): boolean {
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay()
  return day === 0 || day === 6
}

/**
 * Detect volume anomalies for a set of daily counts.
 *
 * @param dailyCounts map of "YYYY-MM-DD" → execution count
 * @param yesterday   date string to treat as the measured day
 * @param lowPct      alert threshold for drops (default 50)
 * @param highPct     alert threshold for spikes (default 200)
 * @returns anomaly or null if none / insufficient data
 */
export function detectAnomaly(
  dailyCounts: Record<string, number>,
  yesterday: string,
  lowPct = DEFAULT_LOW_THRESHOLD_PCT,
  highPct = DEFAULT_HIGH_THRESHOLD_PCT
): { yesterdayCount: number; baselineAvg: number; kind: 'drop' | 'spike' } | null {
  const yesterdayCount = dailyCounts[yesterday] ?? 0
  const yesterdayIsWeekend = isWeekend(yesterday)

  // Baseline = same-day-type days STRICTLY BEFORE the measured day, sorted
  // ascending. `day < yesterday` excludes both yesterday and today: the rollup
  // refreshes every 5 minutes and the check runs at 13:00 UTC, so today's
  // partial (~13h) count would otherwise be averaged in as a full baseline day,
  // deflating the baseline and flipping the alert (drops under-fire, spikes
  // over-fire).
  const baselineDays = Object.entries(dailyCounts)
    .filter(([day]) => day < yesterday && isWeekend(day) === yesterdayIsWeekend)
    .sort(([a], [b]) => a.localeCompare(b))

  if (baselineDays.length < MIN_BASELINE_DAYS) return null  // not enough same-day-type data

  // Use the most recent matching days (7 weekdays ≈ 1.5 work-weeks; 7 weekend days ≈ 3.5 weekends)
  const priorDays = baselineDays.slice(-7)
  const baselineAvg = priorDays.reduce((sum, [, n]) => sum + n, 0) / priorDays.length

  // Don't alert if baseline is 0 (workflow just created or no traffic expected)
  if (baselineAvg === 0) return null

  if (yesterdayCount < baselineAvg * (lowPct / 100)) {
    return { yesterdayCount, baselineAvg: Math.round(baselineAvg), kind: 'drop' }
  }
  if (yesterdayCount > baselineAvg * (highPct / 100)) {
    return { yesterdayCount, baselineAvg: Math.round(baselineAvg), kind: 'spike' }
  }
  return null
}

/**
 * Run the full volume anomaly check across all orgs with Slack configured.
 * Called from the Worker scheduled handler.
 */
export async function runVolumeAnomalyCheck(
  supabase: SupabaseClient
): Promise<void> {
  // 1. Find orgs with Slack connections
  const { data: slackConnections } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')

  const orgIds = (slackConnections ?? []).map((c) => c.organization_id as string)
  if (orgIds.length === 0) return

  // 2. Get workflow IDs for those orgs
  const { data: workflows } = await supabase
    .from('workflows')
    .select('id, organization_id')
    .in('organization_id', orgIds)
    .eq('is_active', true)
    .is('deleted_at', null)

  const wfToOrg: Record<string, string> = {}
  const orgWorkflowIds: Record<string, string[]> = {}
  for (const wf of workflows ?? []) {
    const wfId = wf.id as string
    const orgId = wf.organization_id as string
    wfToOrg[wfId] = orgId
    if (!orgWorkflowIds[orgId]) orgWorkflowIds[orgId] = []
    orgWorkflowIds[orgId].push(wfId)
  }

  const allWorkflowIds = Object.keys(wfToOrg)
  if (allWorkflowIds.length === 0) return

  // 3. Read 22 days of pre-aggregated daily counts — covers ~3 weekends so
  //    weekend baselines have enough samples. The rollup buckets by
  //    (workflow_id, status, outcome, day, is_test); we sum run_count across
  //    status/outcome to get per-workflow per-day totals.
  const lookbackStartDate = new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const { data: rollup } = await supabase
    .from('workflow_stats_daily')
    .select('workflow_id, day, run_count')
    .in('workflow_id', allWorkflowIds)
    .gte('day', lookbackStartDate)
    .eq('is_test', false)

  // 4. Group by org + day
  const orgDailyCounts: Record<string, Record<string, number>> = {}
  for (const row of rollup ?? []) {
    const orgId = wfToOrg[row.workflow_id as string]
    const day = row.day as string
    if (!orgId || !day) continue
    if (!orgDailyCounts[orgId]) orgDailyCounts[orgId] = {}
    // BIGINT may arrive as string from PostgREST — coerce defensively
    orgDailyCounts[orgId][day] = (orgDailyCounts[orgId][day] ?? 0) + Number(row.run_count)
  }

  // 5. Detect anomalies per org and alert
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  for (const orgId of orgIds) {
    const dailyCounts = orgDailyCounts[orgId] ?? {}
    const anomaly = detectAnomaly(dailyCounts, yesterday)
    if (!anomaly) continue

    const connection = await getSlackConnection(supabase, orgId)
    if (!connection) continue
    if (!connection.volume_alerts_enabled) continue  // org opted out via Integrations page

    const dayType = isWeekend(yesterday) ? 'weekend' : 'weekday'
    await sendVolumeAlert(connection, anomaly.kind, anomaly.yesterdayCount, anomaly.baselineAvg, dayType)
  }
}

async function sendVolumeAlert(
  connection: { bot_token: string; default_channel: string },
  kind: 'drop' | 'spike',
  yesterdayCount: number,
  baselineAvg: number,
  dayType: 'weekend' | 'weekday'
): Promise<void> {
  const isDrop = kind === 'drop'
  const pct = baselineAvg > 0 ? Math.round((yesterdayCount / baselineAvg) * 100) : 0

  const header = isDrop ? 'Execution Volume Drop Detected' : 'Execution Volume Spike Detected'
  const baselineLabel = `${dayType} baseline`
  const description = isDrop
    ? `Yesterday's execution count (${yesterdayCount}) was *${pct}% of the ${baselineLabel}* (avg ${baselineAvg}). This may indicate an upstream source outage.`
    : `Yesterday's execution count (${yesterdayCount}) was *${pct}% of the ${baselineLabel}* (avg ${baselineAvg}). This may indicate unexpected traffic.`

  const baselineFieldLabel = dayType === 'weekend' ? 'Weekend baseline' : 'Weekday baseline'
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: description } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Yesterday:* ${yesterdayCount} executions` },
        { type: 'mrkdwn', text: `*${baselineFieldLabel}:* ${baselineAvg} executions/day` },
      ],
    },
  ]

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.bot_token}` },
    body: JSON.stringify({ channel: connection.default_channel, blocks, text: header, unfurl_links: false }),
  })
  if (!res.ok) console.error(`[volume-anomaly] Slack HTTP error ${res.status}`)
}
