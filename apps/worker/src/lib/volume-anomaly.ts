/**
 * Volume anomaly detection — PRD Section 3.6 / 10.3
 *
 * Runs on a scheduled cron trigger (daily at 09:00 UTC).
 * For each org that has Slack configured, compares yesterday's execution
 * volume to the 7-day rolling baseline. If volume dropped below 50% or
 * spiked above 200%, sends a Slack alert.
 *
 * Thresholds:
 *   low_threshold_pct  — alert if yesterday < baseline * (low/100).  Default: 50
 *   high_threshold_pct — alert if yesterday > baseline * (high/100). Default: 200
 *
 * At least 3 days of baseline data is required before anomalies are flagged.
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

  // Baseline = all days in the map except yesterday, sorted ascending
  const baselineDays = Object.entries(dailyCounts)
    .filter(([day]) => day !== yesterday)
    .sort(([a], [b]) => a.localeCompare(b))

  if (baselineDays.length < MIN_BASELINE_DAYS) return null  // not enough data

  // Use only the 7 days immediately before yesterday
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
  supabase: SupabaseClient,
  appUrl: string
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

  // 3. Query 8 days of execution records
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
  const { data: executions } = await supabase
    .from('workflow_executions')
    .select('workflow_id, started_at')
    .in('workflow_id', allWorkflowIds)
    .gte('started_at', eightDaysAgo)
    .eq('is_test', false)

  // 4. Group by org + day
  const orgDailyCounts: Record<string, Record<string, number>> = {}
  for (const exec of executions ?? []) {
    const orgId = wfToOrg[exec.workflow_id as string]
    const day = (exec.started_at as string).slice(0, 10)
    if (!orgId || !day) continue
    if (!orgDailyCounts[orgId]) orgDailyCounts[orgId] = {}
    orgDailyCounts[orgId][day] = (orgDailyCounts[orgId][day] ?? 0) + 1
  }

  // 5. Detect anomalies per org and alert
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  for (const orgId of orgIds) {
    const dailyCounts = orgDailyCounts[orgId] ?? {}
    const anomaly = detectAnomaly(dailyCounts, yesterday)
    if (!anomaly) continue

    const connection = await getSlackConnection(supabase, orgId)
    if (!connection) continue

    await sendVolumeAlert(connection, orgId, anomaly.kind, anomaly.yesterdayCount, anomaly.baselineAvg, appUrl)
  }
}

async function sendVolumeAlert(
  connection: { bot_token: string; default_channel: string },
  _orgId: string,
  kind: 'drop' | 'spike',
  yesterdayCount: number,
  baselineAvg: number,
  _appUrl: string
): Promise<void> {
  const isDrop = kind === 'drop'
  const pct = baselineAvg > 0 ? Math.round((yesterdayCount / baselineAvg) * 100) : 0

  const header = isDrop ? '📉 Execution Volume Drop Detected' : '📈 Execution Volume Spike Detected'
  const description = isDrop
    ? `Yesterday's execution count (${yesterdayCount}) was *${pct}% of the 7-day baseline* (avg ${baselineAvg}). This may indicate an upstream source outage.`
    : `Yesterday's execution count (${yesterdayCount}) was *${pct}% of the 7-day baseline* (avg ${baselineAvg}). This may indicate unexpected traffic.`

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: description } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Yesterday:* ${yesterdayCount} executions` },
        { type: 'mrkdwn', text: `*7-day baseline:* ${baselineAvg} executions/day` },
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
