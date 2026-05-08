/**
 * Real-time volume cliff detection — fires within ~5 min of an upstream traffic stop.
 *
 * Companion to `volume-anomaly.ts`, which runs daily and compares whole-day totals.
 * The daily check is structurally blind to intraday cliffs (a 1-2hr stop on an
 * otherwise normal day still leaves the day's total ≥80% of baseline). This check
 * runs every minute and compares the last 5 minutes' rate to a rolling 60-minute
 * baseline, so a cliff at 21:38 UTC is alertable by ~21:43 UTC.
 *
 * Detection:
 *   baseline_per_min = median executions/min in the [-60min, -5min] window
 *   skip if baseline_per_min < MIN_BASELINE_PER_MIN (low-volume workflows)
 *   fire  if last_5min_count < (baseline_per_min * 5) * (ALERT_THRESHOLD_PCT / 100)
 *
 * Cooldown: 30 min per workflow via KV (prevents repeat alerts during a sustained outage).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSlackConnection } from './slack'

export const COOLDOWN_TTL_SECONDS = 30 * 60
export const ALERT_THRESHOLD_PCT = 25
export const MIN_BASELINE_PER_MIN = 10
export const BASELINE_WINDOW_MINUTES = 55  // [-60, -5)
export const RECENT_WINDOW_MINUTES = 5     // [-5, 0)

export interface CliffDetection {
  workflow_id: string
  workflow_name: string
  organization_id: string
  recent_count: number
  baseline_per_min: number
}

/**
 * Pure detection logic — given per-minute counts for the last 60 minutes,
 * decide whether the trailing 5 minutes are a cliff against the prior 55.
 */
export function detectCliff(
  perMinuteCounts: number[],  // length 60: index 0 = oldest minute, 59 = most recent
  lowPct = ALERT_THRESHOLD_PCT,
  minBaseline = MIN_BASELINE_PER_MIN
): { recentCount: number; baselinePerMin: number } | null {
  if (perMinuteCounts.length !== 60) return null

  const baseline = perMinuteCounts.slice(0, BASELINE_WINDOW_MINUTES)
  const recent = perMinuteCounts.slice(BASELINE_WINDOW_MINUTES)

  const sorted = [...baseline].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (median < minBaseline) return null

  const recentCount = recent.reduce((sum, n) => sum + n, 0)
  const expected = median * RECENT_WINDOW_MINUTES
  const threshold = expected * (lowPct / 100)
  if (recentCount >= threshold) return null

  return { recentCount, baselinePerMin: median }
}

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

/**
 * Run the volume cliff check across all active workflows in orgs that have Slack connected.
 * Called from the Worker scheduled handler on the minute cron.
 */
export async function runVolumeCliffCheck(
  supabase: SupabaseClient,
  kv: KvLike,
  appUrl: string
): Promise<void> {
  const { data: slackOrgs } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')

  const slackOrgIds = (slackOrgs ?? []).map((c) => c.organization_id as string)
  if (slackOrgIds.length === 0) return

  const { data: workflows } = await supabase
    .from('workflows')
    .select('id, name, organization_id')
    .in('organization_id', slackOrgIds)
    .eq('is_active', true)
    .is('deleted_at', null)

  if (!workflows?.length) return

  const now = Date.now()
  const sixtyMinAgo = new Date(now - 60 * 60 * 1000).toISOString()
  const workflowIds = workflows.map((w) => w.id as string)

  const { data: executions } = await supabase
    .from('workflow_executions')
    .select('workflow_id, started_at')
    .in('workflow_id', workflowIds)
    .gte('started_at', sixtyMinAgo)
    .eq('is_test', false)

  // Bucket per workflow into 60 minute-bins
  const sixtyMinAgoMs = now - 60 * 60 * 1000
  const perWorkflow = new Map<string, number[]>()
  for (const id of workflowIds) perWorkflow.set(id, new Array(60).fill(0))

  for (const exec of executions ?? []) {
    const startedAt = new Date(exec.started_at as string).getTime()
    const minuteIdx = Math.floor((startedAt - sixtyMinAgoMs) / 60000)
    if (minuteIdx < 0 || minuteIdx >= 60) continue
    const bucket = perWorkflow.get(exec.workflow_id as string)
    if (bucket) bucket[minuteIdx] += 1
  }

  for (const wf of workflows) {
    const wfId = wf.id as string
    const bucket = perWorkflow.get(wfId)
    if (!bucket) continue

    const cliff = detectCliff(bucket)
    if (!cliff) continue

    const cooldownKey = `volume-cliff-cooldown:${wfId}`
    if (await kv.get(cooldownKey)) continue

    const slack = await getSlackConnection(supabase, wf.organization_id as string)
    if (!slack || !slack.volume_alerts_enabled) continue

    await sendCliffAlert(slack, {
      workflow_id: wfId,
      workflow_name: wf.name as string,
      organization_id: wf.organization_id as string,
      recent_count: cliff.recentCount,
      baseline_per_min: cliff.baselinePerMin,
    }, appUrl)

    await kv.put(cooldownKey, '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
  }
}

async function sendCliffAlert(
  slack: { bot_token: string; default_channel: string },
  cliff: CliffDetection,
  appUrl: string
): Promise<void> {
  const expected = cliff.baseline_per_min * RECENT_WINDOW_MINUTES
  const ratePct = expected > 0 ? Math.round((cliff.recent_count / expected) * 100) : 0
  const workflowUrl = `${appUrl}/workflows/${cliff.workflow_id}`

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Workflow Volume Cliff', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${cliff.workflow_name}* received *${cliff.recent_count} executions in the last 5 minutes* — only *${ratePct}% of expected* based on the prior hour's rate of ~${cliff.baseline_per_min}/min.\n\nThis usually means an upstream source stopped sending. <${workflowUrl}|Open workflow →>`,
      },
    },
  ]

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${slack.bot_token}` },
    body: JSON.stringify({
      channel: slack.default_channel,
      blocks,
      text: `Workflow volume cliff: ${cliff.workflow_name}`,
      unfurl_links: false,
    }),
  })
  if (!res.ok) console.error(`[volume-cliff] Slack HTTP error ${res.status}`)
}
