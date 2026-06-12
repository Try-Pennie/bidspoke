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
import { getSlackConnection, postMessage } from './slack'

export const COOLDOWN_TTL_SECONDS = 30 * 60
export const ALERT_THRESHOLD_PCT = 25
export const MIN_BASELINE_PER_MIN = 10
export const BASELINE_WINDOW_MINUTES = 55  // [-60, -5)
export const RECENT_WINDOW_MINUTES = 5     // [-5, 0)

// External URL we hit when a cliff fires, to confirm the worker is reachable from
// outside Cloudflare. A 200 here means the issue is upstream of CF (caller stopped
// sending); a failure means CF/route/DNS/TLS — investigate our side first.
//
// Default is a stable bidspoke-owned hostname (the hook.trypennie.dev route hits
// this worker and a GET returns 200). Override via the SELF_CHECK_URL env var.
export const DEFAULT_SELF_CHECK_URL = 'https://hook.trypennie.dev/'
const SELF_CHECK_TIMEOUT_MS = 5000

export interface SelfCheckResult {
  ok: boolean
  status: number | null
  latency_ms: number
  error: string | null
}

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
  appUrl: string,
  selfCheckUrl: string = DEFAULT_SELF_CHECK_URL
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
  const workflowIds = workflows.map((w) => w.id as string)

  // 60 wall-clock-minute buckets ending with the current (partial) minute at
  // index 59. windowStart is minute-aligned so the DB's date_trunc('minute', …)
  // buckets map cleanly onto array indices.
  const nowMinuteMs = Math.floor(now / 60000) * 60000
  const windowStartMs = nowMinuteMs - 59 * 60000
  const windowStart = new Date(windowStartMs).toISOString()

  // Aggregate per-minute counts in the database rather than streaming raw rows
  // into the Worker. This collapses thousands of rows to ~60 per workflow and
  // sidesteps PostgREST's 1000-row page cap, which previously forced unordered
  // OFFSET pagination that silently dropped the newest rows (the trailing-5-min
  // window) and fired false cliff alerts.
  const { data: counts, error: countsError } = await supabase.rpc('execution_counts_per_minute', {
    p_workflow_ids: workflowIds,
    p_since: windowStart,
  })
  if (countsError) {
    console.error(`[volume-cliff] execution_counts_per_minute failed: ${countsError.message}`)
    return
  }
  const rows = (counts ?? []) as { workflow_id: string; minute: string; cnt: number | string }[]
  console.log(`[volume-cliff] fetched ${rows.length} minute-buckets across ${workflows.length} workflows`)

  const perWorkflow = new Map<string, number[]>()
  for (const id of workflowIds) perWorkflow.set(id, new Array(60).fill(0))

  for (const row of rows) {
    const minuteIdx = Math.round((new Date(row.minute).getTime() - windowStartMs) / 60000)
    if (minuteIdx < 0 || minuteIdx >= 60) continue
    const bucket = perWorkflow.get(row.workflow_id)
    if (bucket) bucket[minuteIdx] = Number(row.cnt)
  }

  // Run the self-check at most once per cron tick, lazily — only if we're about
  // to fire at least one alert.
  let cachedSelfCheck: SelfCheckResult | null = null
  const getSelfCheck = async (): Promise<SelfCheckResult> => {
    if (cachedSelfCheck) return cachedSelfCheck
    cachedSelfCheck = await runSelfCheck(selfCheckUrl)
    return cachedSelfCheck
  }

  for (const wf of workflows) {
    const wfId = wf.id as string
    const bucket = perWorkflow.get(wfId)
    if (!bucket) continue

    const cliff = detectCliff(bucket)
    if (!cliff) continue

    console.log(`[volume-cliff] detected workflow=${wf.name} workflow_id=${wfId} recent=${cliff.recentCount} baseline_per_min=${cliff.baselinePerMin}`)

    const cooldownKey = `volume-cliff-cooldown:${wfId}`
    if (await kv.get(cooldownKey)) {
      console.log(`[volume-cliff] suppressed by cooldown workflow_id=${wfId}`)
      continue
    }

    const slack = await getSlackConnection(supabase, wf.organization_id as string)
    if (!slack || !slack.volume_alerts_enabled) {
      console.log(`[volume-cliff] no Slack / opted-out org=${wf.organization_id} workflow_id=${wfId}`)
      continue
    }

    const selfCheck = await getSelfCheck()

    const sent = await sendCliffAlert(slack, {
      workflow_id: wfId,
      workflow_name: wf.name as string,
      organization_id: wf.organization_id as string,
      recent_count: cliff.recentCount,
      baseline_per_min: cliff.baselinePerMin,
    }, appUrl, selfCheck)

    // Only start the cooldown once the alert actually delivered — otherwise a
    // kicked bot (Slack ok:false) would suppress retries for 30 min while the
    // outage went unannounced.
    if (sent) await kv.put(cooldownKey, '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
  }
}

async function runSelfCheck(selfCheckUrl: string): Promise<SelfCheckResult> {
  const start = Date.now()
  try {
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), SELF_CHECK_TIMEOUT_MS)
    const res = await fetch(selfCheckUrl, { method: 'GET', signal: ctrl.signal })
    clearTimeout(timeout)
    const latency = Date.now() - start
    const cfRay = res.headers.get('cf-ray')
    console.log(`[volume-cliff] self-check status=${res.status} latency=${latency}ms cf-ray=${cfRay} url=${selfCheckUrl}`)
    // Any HTTP response (including 4xx) proves the worker is reachable. Only
    // network/timeout errors below mean unreachable. 5xx is the one ambiguous
    // case — treat it as errored (worker up but failing).
    return { ok: res.status < 500, status: res.status, latency_ms: latency, error: null }
  } catch (e) {
    const latency = Date.now() - start
    const errName = e instanceof Error ? e.name : 'unknown'
    const errMsg = e instanceof Error ? e.message : String(e)
    console.error(`[volume-cliff] self-check FAILED type=${errName} message=${errMsg} latency=${latency}ms url=${selfCheckUrl}`)
    return { ok: false, status: null, latency_ms: latency, error: `${errName}: ${errMsg}` }
  }
}

// Returns the message ts on success, or null if the alert was not delivered
// (HTTP error or Slack ok:false) — the caller gates the cooldown on this.
async function sendCliffAlert(
  slack: { bot_token: string; default_channel: string },
  cliff: CliffDetection,
  appUrl: string,
  selfCheck: SelfCheckResult
): Promise<string | null> {
  const expected = cliff.baseline_per_min * RECENT_WINDOW_MINUTES
  const ratePct = expected > 0 ? Math.round((cliff.recent_count / expected) * 100) : 0
  const workflowUrl = `${appUrl}/workflows/${cliff.workflow_id}`

  const checkLine = selfCheck.error
    ? `*Self-check FAILED:* ${selfCheck.error} after ${selfCheck.latency_ms}ms. *Worker may be unreachable.* Investigate Cloudflare (DNS, route, TLS) first.`
    : selfCheck.ok
      ? `*Self-check:* HTTP ${selfCheck.status} in ${selfCheck.latency_ms}ms. Worker is reachable. The upstream caller isn't sending.`
      : `*Self-check:* HTTP ${selfCheck.status} in ${selfCheck.latency_ms}ms. Worker responded but errored. Investigate worker health.`

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Workflow Volume Cliff', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<!here> *${cliff.workflow_name}* received *${cliff.recent_count} executions in the last 5 minutes*. Only *${ratePct}% of expected* based on the prior hour's rate of ~${cliff.baseline_per_min}/min.`,
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: checkLine } },
    { type: 'section', text: { type: 'mrkdwn', text: `<${workflowUrl}|Open workflow →>` } },
  ]

  return postMessage(slack.bot_token, slack.default_channel, blocks, `Workflow volume cliff: ${cliff.workflow_name}`)
}
