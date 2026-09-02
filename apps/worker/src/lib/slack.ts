// Slack alert sender — Block Kit messages for workflow failures and circuit breaker events
// Bot token is stored in service_connections.config.bot_token (fetched at runtime from Supabase)

import type { SupabaseClient } from '@supabase/supabase-js'
import { coerceString } from './coerce'
import { parseJson } from './json'
import { isPermanentDbError, isNoRowMatchedError, sleep, toDbError } from './db-retry'
import { MIN_AGE_MINUTES as STRAND_DRAIN_MIN_AGE_MINUTES } from './stranded-executions'
import { GENERIC_FIX_HINT } from './export-error-hints'
import { truncateErrorForAlert } from './format-error'
import type { ErrorType } from '../types'
// Type-only, so this does not create a cycle with the module that calls the
// alert below: the import is erased at build time.
import type { ScheduleStatus, ScheduleVerdict, WatchedWorkflow } from './workflow-schedule-watch'
import { type DispatchAttempt, dispatchFailed } from './workflow-dispatch-driver'

export interface SlackConnection {
  bot_token: string
  default_channel: string
  workspace_name?: string
  volume_alerts_enabled: boolean
  matrix_alerts_enabled: boolean
  config_alerts_enabled: boolean
  /** GitHub workflow-backup-failure alerts (#206). Own toggle so muting config
   *  noise doesn't silently disable this data-safety alert (#223). */
  backup_alerts_enabled: boolean
  /** Optional dedicated channel for matrix-change alerts. Falls back to default_channel when null. */
  matrix_alerts_channel: string | null
}

export interface FailureAlertPayload {
  workflow_id: string
  workflow_name: string
  execution_id: string
  step_namespace?: string
  /** Node id of the failed step, when known — deep-links the alert straight to
   * the offending node on the canvas (in addition to opening the execution). */
  node_id?: string
  error_message: string
  error_type: ErrorType
  /** Retries the failed step consumed before giving up. 0/undefined = failed on
   * the first attempt (no retry). Shown in the alert only when > 0. */
  retries_used?: number
  timestamp: string
}

export interface CircuitAlertPayload {
  service_name: string
  state: 'opened' | 'closed'
  error_count?: number
  consecutive_cooldowns?: number
}

// ── Connection lookup ─────────────────────────────────────────────────────────

// Short retry ladder for the connection read. A transient DB blip must not look
// like "org has no Slack" — that silently drops the alert exactly when an incident
// is unfolding (#409). Kept short (a few hundred ms) because some callers fire this
// during execution, not only in waitUntil; a sustained outage falls through to a
// logged null so the dropped alert is at least visible, never silent.
const SLACK_CONN_RETRY_DELAYS_MS = [150, 400]

export async function getSlackConnection(
  supabase: SupabaseClient,
  orgId: string,
  delaysMs: number[] = SLACK_CONN_RETRY_DELAYS_MS,
): Promise<SlackConnection | null> {
  let data: { config?: unknown } | null = null
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) await sleep(delaysMs[attempt - 1])
    const res = await supabase
      .from('service_connections')
      .select('config')
      .eq('organization_id', orgId)
      .eq('service_type', 'slack')
      .maybeSingle()
    if (!res.error) {
      data = res.data as { config?: unknown } | null
      break
    }
    const dbErr = toDbError(res.error)
    // Schema drift / bad query can't be retried — fail fast, but LOG so the
    // dropped alert isn't mistaken for a not-configured org.
    if (isPermanentDbError(dbErr)) {
      console.error(`[slack] getSlackConnection permanent error for org ${orgId}: ${dbErr.message}; alert dropped`)
      return null
    }
    if (attempt === delaysMs.length) {
      // Transient error survived every retry: the alert that needs this connection
      // will be dropped. Make it visible instead of returning a silent "no Slack".
      console.error(`[slack] getSlackConnection failed for org ${orgId} after ${delaysMs.length} retries: ${dbErr.message}; alert dropped`)
      return null
    }
  }

  if (!data?.config) return null
  const cfg = data.config as Record<string, unknown>
  const botToken = typeof cfg.bot_token === 'string' ? cfg.bot_token : null
  const defaultChannel = typeof cfg.default_channel === 'string' ? cfg.default_channel : null
  if (!botToken || !defaultChannel) return null
  return {
    bot_token: botToken,
    default_channel: defaultChannel,
    workspace_name: typeof cfg.workspace_name === 'string' ? cfg.workspace_name : undefined,
    // Default true so existing connections keep alerting; opt-out only.
    volume_alerts_enabled: cfg.volume_alerts_enabled !== false,
    matrix_alerts_enabled: cfg.matrix_alerts_enabled !== false,
    config_alerts_enabled: cfg.config_alerts_enabled !== false,
    backup_alerts_enabled: cfg.backup_alerts_enabled !== false,
    matrix_alerts_channel: typeof cfg.matrix_alerts_channel === 'string' && cfg.matrix_alerts_channel ? cfg.matrix_alerts_channel : null,
  }
}

// ── Alert senders ─────────────────────────────────────────────────────────────

export interface SlackAlertHandle {
  channel: string
  ts: string
  bot_token: string
}

export async function sendFailureAlert(
  supabase: SupabaseClient,
  orgId: string,
  channelOverride: string | null,
  payload: FailureAlertPayload,
  appUrl: string
): Promise<SlackAlertHandle | null> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return null  // Slack not configured — silently skip

  const channel = channelOverride || connection.default_channel
  const errorLabel = payload.error_type === 'transient' ? 'Transient' : 'Permanent'
  const stepText = payload.step_namespace ? `\`${payload.step_namespace}\`` : 'unknown step'
  const executionUrl = `${appUrl}/workflows/${payload.workflow_id}?execution=${payload.execution_id}` +
    (payload.node_id ? `&node=${payload.node_id}` : '')

  // Only show the retry line when at least one retry actually happened — a step
  // that failed on its first attempt shouldn't add noise claiming "0 retries".
  const retries = payload.retries_used ?? 0
  const retryText = retries > 0
    ? `retried ${retries} ${retries === 1 ? 'time' : 'times'} before failing`
    : 'failed on first attempt (no retry)'

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Workflow Execution Failed', emoji: false },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Workflow:* ${payload.workflow_name}` },
        { type: 'mrkdwn', text: `*Failed step:* ${stepText}` },
        { type: 'mrkdwn', text: `*Error type:* ${errorLabel}` },
        { type: 'mrkdwn', text: `*Retries:* ${retryText}` },
        { type: 'mrkdwn', text: `*Time:* ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(payload.timestamp))}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        // Slack hard-rejects any section block whose text exceeds 3000 chars,
        // which would fail the whole alert. The full error is stored uncapped
        // and visible in the execution detail view; here we send as much as the
        // block allows (2900, leaving headroom for the *Error:* prefix and code
        // fence) and let Slack's native "Show more" collapse it. Anything past
        // the cap gets a trailing note pointing at the execution.
        text: (() => {
          const full = payload.error_message
          const shown = full.length > 2900
            ? `${full.slice(0, 2900)}\n… (truncated, full error in execution detail)`
            : full
          return `*Error:*\n\`\`\`${shown}\`\`\``
        })(),
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<${executionUrl}|View execution →>`,
      },
    },
  ]

  const ts = await postMessage(connection.bot_token, channel, blocks, `Workflow "${payload.workflow_name}" failed at ${stepText}: ${payload.error_message}`)
  return ts ? { channel, ts, bot_token: connection.bot_token } : null
}

export async function sendDurationAlert(
  supabase: SupabaseClient,
  orgId: string,
  channelOverride: string | null,
  payload: {
    workflow_id: string
    workflow_name: string
    execution_id: string
    duration_ms: number
    threshold_ms: number
    timestamp: string
    /** Node id of the slowest (bottleneck) step, when known — deep-links the
     *  alert straight to that node on the canvas in addition to the execution. */
    node_id?: string
  },
  appUrl: string
): Promise<SlackAlertHandle | null> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return null

  const channel = channelOverride || connection.default_channel
  const seconds = (payload.duration_ms / 1000).toFixed(1)
  const thresholdSeconds = (payload.threshold_ms / 1000).toFixed(0)
  const executionUrl = `${appUrl}/workflows/${payload.workflow_id}?execution=${payload.execution_id}` +
    (payload.node_id ? `&node=${payload.node_id}` : '')

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Slow Execution', emoji: false },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Workflow:* ${payload.workflow_name}` },
        { type: 'mrkdwn', text: `*Duration:* ${seconds}s (threshold: ${thresholdSeconds}s)` },
        { type: 'mrkdwn', text: `*Time:* ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(payload.timestamp))}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `<${executionUrl}|View execution →>` },
    },
  ]

  const ts = await postMessage(
    connection.bot_token,
    channel,
    blocks,
    `Workflow "${payload.workflow_name}" took ${seconds}s (threshold: ${thresholdSeconds}s)`
  )
  return ts ? { channel, ts, bot_token: connection.bot_token } : null
}

export interface SlowSpikeAlertPayload {
  workflow_id: string
  workflow_name: string
  /** Slow runs (duration_ms > threshold) in the window. */
  slow_count: number
  /** All terminal runs in the window — the denominator. */
  total_count: number
  threshold_ms: number
  slowest_ms: number
  median_slow_ms: number
  window_minutes: number
  timestamp: string
}

/**
 * Aggregated slow-execution alert — fired by the cron slow-spike check, not per
 * run. Links to the workflow's execution list (filtered by the eye test) rather
 * than a single execution, since the point is a cluster, not one slow lead.
 */
export async function sendSlowSpikeAlert(
  supabase: SupabaseClient,
  orgId: string,
  channelOverride: string | null,
  payload: SlowSpikeAlertPayload,
  appUrl: string
): Promise<string | null> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return null

  const channel = channelOverride || connection.default_channel
  const thresholdSeconds = (payload.threshold_ms / 1000).toFixed(0)
  const medianSeconds = (payload.median_slow_ms / 1000).toFixed(1)
  const slowestSeconds = (payload.slowest_ms / 1000).toFixed(1)
  const sharePct = payload.total_count > 0 ? Math.round((payload.slow_count / payload.total_count) * 100) : 0
  const workflowUrl = `${appUrl}/workflows/${payload.workflow_id}`

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Slow Execution Spike', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${payload.workflow_name}* had *${payload.slow_count} of ${payload.total_count} runs* (${sharePct}%) exceed the ${thresholdSeconds}s threshold in the last ${payload.window_minutes} minutes.`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Median slow run:* ${medianSeconds}s` },
        { type: 'mrkdwn', text: `*Slowest:* ${slowestSeconds}s` },
        { type: 'mrkdwn', text: `*Time:* ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(payload.timestamp))}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `<${workflowUrl}|Open workflow →>` },
    },
  ]

  return postMessage(
    connection.bot_token,
    channel,
    blocks,
    `Slow execution spike: ${payload.workflow_name}, ${payload.slow_count}/${payload.total_count} runs over ${thresholdSeconds}s`
  )
}

export interface FailureSpikeAlertPayload {
  workflow_id: string
  workflow_name: string
  /** The muted signal's match string, e.g. "ACRO_GATEWAY". */
  signal: string
  /** Matching failed runs in the window. */
  failure_count: number
  window_minutes: number
  timestamp: string
}

// Aggregated failure-rate alert (#248): the per-run page for a muted signal is
// suppressed; this fires ONCE when matching failures cross the rate threshold —
// the signal that a transient blip has become a real, large outage.
export async function sendFailureSpikeAlert(
  supabase: SupabaseClient,
  orgId: string,
  channelOverride: string | null,
  payload: FailureSpikeAlertPayload,
  appUrl: string
): Promise<string | null> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return null

  const channel = channelOverride || connection.default_channel
  const workflowUrl = `${appUrl}/workflows/${payload.workflow_id}`

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Failure Spike', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${payload.workflow_name}* had *${payload.failure_count} failures* matching \`${payload.signal}\` in the last ${payload.window_minutes} minutes. Per-run alerts for this signal are muted; this is the aggregated rate alert.`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Time:* ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(payload.timestamp))}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `<${workflowUrl}|Open workflow →>` },
    },
  ]

  return postMessage(
    connection.bot_token,
    channel,
    blocks,
    `Failure spike: ${payload.workflow_name}, ${payload.failure_count} failures matching ${payload.signal} in ${payload.window_minutes}m`
  )
}

export interface UpstreamOutageAlertPayload {
  /** Stable cause id, e.g. "salesforce". */
  cause_key: string
  /** Human label, e.g. "Salesforce". */
  cause_label: string
  /** Matching failed runs across the org in the window. */
  failure_count: number
  window_minutes: number
  /** Distinct workflows hit by this cause. */
  workflow_names: string[]
  /**
   * The busiest distinct error shapes behind this cause, busiest first (#834).
   * The cause label alone ("Salesforce appears degraded") does not distinguish a
   * vendor outage from our own call pattern hitting their concurrency governor,
   * and the specific message was already in memory when this payload was built.
   */
  error_shapes?: { sample: string; count: number }[]
  /** Distinct shapes not listed, so the top one does not read as the whole story. */
  other_shape_count?: number
  /**
   * What to actually go and look at, derived from the dominant shape by
   * describeHowToCheck rather than a fixed sentence about the vendor's status
   * page (L36). Optional so a caller that cannot judge falls back to the neutral
   * wording rather than asserting a cause.
   */
  how_to_check?: string
  timestamp: string
}

export interface FailureSaturationAlertPayload {
  workflow_id: string
  workflow_name: string
  failure_count: number
  total_count: number
  window_minutes: number
  /** The busiest distinct error shapes, busiest first, so the page names them. */
  error_shapes?: { sample: string; count: number }[]
  other_shape_count?: number
  timestamp: string
}

/**
 * Most of a workflow's runs are failing right now (#1100).
 *
 * Deliberately NOT a cause alert. The aggregated upstream page needs a
 * recognised signature and DEFAULT_OUTAGE_THRESHOLD failures inside one minute,
 * which an absolute count can only see on a busy lane: on 2026-09-02 roughly
 * every Main Flow lead failed for eighteen minutes before one minute reached
 * the threshold, and on 2026-09-01 fifty RML LendSwift leads failed over twenty
 * minutes without ever getting close, carrying an error that is not in the
 * cause list at all.
 *
 * So this says only what it measured, a share of runs over a window, and names
 * the errors without claiming what they mean. Anything more would be a guess
 * about a cause nothing here identified (L11, and the same complaint as #746).
 */
export async function sendFailureSaturationAlert(
  supabase: SupabaseClient,
  orgId: string,
  payload: FailureSaturationAlertPayload,
  appUrl: string
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false

  const shapes = payload.error_shapes ?? []
  const shapesLine = shapes.length > 0
    ? [
        '*What they failed on:*',
        ...shapes.map((sh) => `- ${sh.count} x \`${sh.sample.replace(/`/g, "'")}\``),
        ...((payload.other_shape_count ?? 0) > 0
          ? [`- and ${payload.other_shape_count} other error ${payload.other_shape_count === 1 ? 'shape' : 'shapes'}`]
          : []),
      ].join('\n')
    : ''
  const pct = Math.round((payload.failure_count / payload.total_count) * 100)
  const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(payload.timestamp))

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Most Runs Failing', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `<!here> *${payload.failure_count} of the ${payload.total_count} runs* on *${payload.workflow_name}* ` +
          `failed in the last ${payload.window_minutes} minutes, which is ${pct}% of them.`,
      },
    },
  ]
  if (shapesLine) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: shapesLine } })
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        'This measures how many runs failed, not why. Start with the errors above and the ' +
        'affected runs; nothing here has identified a cause.',
    },
  })
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Time:* ${when}\n<${appUrl}/workflows/${payload.workflow_id}|Open workflow>` } })

  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `Most runs failing: ${payload.workflow_name}, ${payload.failure_count} of ${payload.total_count} in ${payload.window_minutes}m`
  )) !== null
}

// Aggregated shared-upstream outage alert (#331): when a dependency shared by
// many leads degrades, the per-run pages are suppressed at the engine gate and
// this fires ONCE per (org, cause) — an @here page because a degraded upstream
// is serious and time-sensitive.
export async function sendUpstreamOutageAlert(
  supabase: SupabaseClient,
  orgId: string,
  payload: UpstreamOutageAlertPayload,
  appUrl: string
): Promise<string | null> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return null

  const channel = connection.default_channel
  const dashboardUrl = `${appUrl}/dashboard`
  const affected = payload.workflow_names.length
  const workflowsLine = affected > 0
    ? `Affected ${affected === 1 ? 'workflow' : 'workflows'}: ${payload.workflow_names.join(', ')}.`
    : ''
  // The specific errors, which are what tell a vendor outage from our own call
  // pattern. Rendered as code so long JSON payloads stay readable, and the
  // unshown remainder is counted so this does not read as the whole story.
  const shapes = payload.error_shapes ?? []
  const shapesLine = shapes.length > 0
    ? [
        '*What they failed on:*',
        ...shapes.map((s) => `- ${s.count} x \`${s.sample.replace(/`/g, "'")}\``),
        ...((payload.other_shape_count ?? 0) > 0
          ? [`- and ${payload.other_shape_count} other error ${payload.other_shape_count === 1 ? 'shape' : 'shapes'}`]
          : []),
      ].join('\n')
    : ''
  const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(payload.timestamp))

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Upstream Service Degraded', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<!here> *${payload.cause_label} appears degraded.* *${payload.failure_count} leads* failed sharing this cause in the last ${payload.window_minutes} minutes. Per-lead pages for this cause are suppressed; this is the aggregated alert.`,
      },
    },
    ...(workflowsLine ? [{ type: 'section', text: { type: 'mrkdwn', text: workflowsLine } }] : []),
    ...(shapesLine ? [{ type: 'section', text: { type: 'mrkdwn', text: shapesLine } }] : []),
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*How to check:* ${payload.how_to_check ?? `review the affected runs to see what they failed on.`}`,
      },
    },
    {
      type: 'section',
      fields: [{ type: 'mrkdwn', text: `*Time:* ${when}` }],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `<${dashboardUrl}|Open dashboard →>` },
    },
  ]

  return postMessage(
    connection.bot_token,
    channel,
    blocks,
    `Upstream degraded: ${payload.cause_label}, ${payload.failure_count} leads affected in ${payload.window_minutes}m`
  )
}

export async function sendThreadReply(handle: SlackAlertHandle, text: string): Promise<void> {
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${handle.bot_token}`,
      },
      body: JSON.stringify({
        channel: handle.channel,
        thread_ts: handle.ts,
        text,
        unfurl_links: false,
      }),
    })
    if (!res.ok) {
      console.error(`[slack] thread reply HTTP error ${res.status}`)
      return
    }
    // Slack signals delivery failures with HTTP 200 + { ok: false }.
    const data = await parseJson<{ ok: boolean; error?: string }>(res)
    if (!data.ok) console.error(`[slack] thread reply API error: ${data.error}`)
  } catch (e) {
    console.error('[slack] thread reply failed:', e)
  }
}

export interface MatrixChangeAlertPayload {
  changed_at: string
  changes: MatrixConfigChange[]
  /** Optional one-click link to the matrix list view in SF Lightning. */
  matrix_url?: string
}

export interface MatrixConfigChange {
  partner_slug: string
  config_name: string
  added: MatrixRowSummary[]
  removed: MatrixRowSummary[]
  edited: MatrixRowEdit[]
}

export interface MatrixRowSummary {
  row_id: string | null
  range: string
  is_sell_off: boolean
  bid_amount: number
  /** Direct URL to the row in Salesforce — appended as a clickable mrkdwn link when present. */
  source_url?: string
}

export interface MatrixRowEdit {
  row_id: string | null
  range: string
  is_sell_off: boolean
  changes: { field: string; before: unknown; after: unknown }[]
  /** Direct URL to the row in Salesforce — appended as a clickable mrkdwn link when present. */
  source_url?: string
}

// Returns true when there was nothing to deliver (no Slack connection, matrix
// alerts opted out, or no changes) OR the message was delivered; false when a
// configured, opted-in alert failed to send. Callers that defer state on a
// failed alert (sf-matrix-audit) gate on this.
export async function sendMatrixChangeAlert(
  supabase: SupabaseClient,
  orgId: string,
  channelOverride: string | null,
  payload: MatrixChangeAlertPayload
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return true
  if (!connection.matrix_alerts_enabled) return true
  if (payload.changes.length === 0) return true

  const channel = channelOverride || connection.matrix_alerts_channel || connection.default_channel
  const totalAdded = payload.changes.reduce((s, c) => s + c.added.length, 0)
  const totalRemoved = payload.changes.reduce((s, c) => s + c.removed.length, 0)
  const totalEdited = payload.changes.reduce((s, c) => s + c.edited.length, 0)

  const summary = [
    totalAdded > 0 ? `${totalAdded} added` : null,
    totalEdited > 0 ? `${totalEdited} edited` : null,
    totalRemoved > 0 ? `${totalRemoved} removed` : null,
  ].filter(Boolean).join(', ')

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Bid Matrix Changed', emoji: false },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Synced at:* ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(payload.changed_at))}` },
        { type: 'mrkdwn', text: `*Summary:* ${summary || 'no changes'}` },
      ],
    },
  ]

  for (const change of payload.changes) {
    const lines: string[] = []
    for (const e of change.edited) {
      const fields = e.changes.map((c) => `${c.field}: ${formatValue(c.before, c.field)} → ${formatValue(c.after, c.field)}`).join(', ')
      lines.push(`• Edited ${e.range}${e.is_sell_off ? ' (sell-off)' : ''}: ${fields}${linkSuffix(e.source_url)}`)
    }
    for (const a of change.added) {
      lines.push(`• Added ${a.range}${a.is_sell_off ? ' (sell-off)' : ''}: $${a.bid_amount}${linkSuffix(a.source_url)}`)
    }
    for (const r of change.removed) {
      lines.push(`• Removed ${r.range}${r.is_sell_off ? ' (sell-off)' : ''} (was $${r.bid_amount})${linkSuffix(r.source_url)}`)
    }
    if (lines.length === 0) continue
    // The audit job uses partner_slug='salesforce_audit' as a sentinel — there's
    // only ever one section, so its header is redundant noise. Per-partner sync
    // alerts (post-cutover) use real partner slugs and benefit from the header.
    const showHeader = change.partner_slug !== 'salesforce_audit'
    const body = lines.slice(0, 20).join('\n') + (lines.length > 20 ? `\n_…and ${lines.length - 20} more_` : '')
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: showHeader ? `*${change.partner_slug}*: _${change.config_name}_\n${body}` : body,
      },
    })
  }

  if (payload.matrix_url) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `<${payload.matrix_url}|View bid matrix →>` },
    })
  }

  return (await postMessage(connection.bot_token, channel, blocks, `Bid matrix changed: ${summary}`)) !== null
}

// One problem found in a matrix's structure. Mirrors MatrixProblem in
// bid-matrix-validate.ts; redeclared here so slack.ts has no dependency on its
// caller (same pattern as the timeout warning shapes below).
export interface MatrixValidationProblem {
  kind: 'overlap' | 'gap'
  axis: 'row' | 'range'
  is_sell_off: boolean
  detail: string
}

export interface MatrixConfigProblems {
  partner_slug: string
  config_name: string
  problems: MatrixValidationProblem[]
}

export interface MatrixValidationAlertPayload {
  checked_at: string
  configs: MatrixConfigProblems[]
  /** Optional one-click link to the matrix list view in SF Lightning. */
  matrix_url?: string
}

/**
 * Alert that one or more partner bid matrices are structurally malformed —
 * overlapping cells (two cells claim the same lead) or gaps (a lead falls in a
 * hole no cell covers). Posted by the hourly sync after it detects problems,
 * gated on the same matrix_alerts_enabled toggle as the change alert. Returns
 * true when nothing needed sending or the send succeeded; false on a real send
 * failure. The hourly cadence is the natural rate limit, so this re-fires each
 * sync while a matrix stays broken.
 */
export async function sendMatrixValidationAlert(
  supabase: SupabaseClient,
  orgId: string,
  channelOverride: string | null,
  payload: MatrixValidationAlertPayload
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return true
  if (!connection.matrix_alerts_enabled) return true
  if (payload.configs.length === 0) return true

  const channel = channelOverride || connection.matrix_alerts_channel || connection.default_channel
  const total = payload.configs.reduce((s, c) => s + c.problems.length, 0)

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Bid Matrix Problem', emoji: false },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Checked at:* ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(payload.checked_at))}` },
        { type: 'mrkdwn', text: `*Found:* ${total} ${total === 1 ? 'problem' : 'problems'} across ${payload.configs.length} ${payload.configs.length === 1 ? 'partner' : 'partners'}` },
      ],
    },
  ]

  for (const cfg of payload.configs) {
    if (cfg.problems.length === 0) continue
    const lines = cfg.problems.slice(0, 20).map((p) => {
      const sellOff = p.is_sell_off ? ' (sell-off)' : ''
      const tag = p.kind === 'overlap' ? 'Overlap' : 'Gap'
      return `• ${tag}${sellOff}: ${p.detail}`
    })
    const body = lines.join('\n') + (cfg.problems.length > 20 ? `\n_…and ${cfg.problems.length - 20} more_` : '')
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${cfg.partner_slug}*: _${cfg.config_name}_\n${body}` },
    })
  }

  if (payload.matrix_url) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `<${payload.matrix_url}|View bid matrix →>` },
    })
  }

  return (await postMessage(connection.bot_token, channel, blocks, `Bid matrix problem: ${total} found`)) !== null
}

// Structural shapes of one workflow's offending nodes. Defined here (rather than
// imported from timeout-audit) so slack.ts has no dependency back on its caller.
interface TimeoutConfigWarning {
  workflow_id: string
  workflow_name: string
  nodes: Array<{ node_id: string; label: string | null; namespace: string; type: string; configured_ms: number; floor_ms: number }>
}

interface TimeoutUnderProvisionedWarning {
  workflow_id: string
  workflow_name: string
  nodes: Array<{
    node_id: string
    label: string | null
    namespace: string
    type: string
    configured_ms: number
    suggested_ms: number
    p99_ms: number
    sample_size: number
    severity: 'red' | 'amber'
  }>
}

/**
 * Alert that one or more active workflows have a step whose timeout is below the
 * node-type reliability floor (fails on cold runs) or below the history-based
 * suggested value (real runs time out or burn retries). Posted by the daily
 * audit cron, deduped upstream so it fires only when the offending set changes.
 * The caller passes an already fetched connection and has already checked
 * config_alerts_enabled.
 */
export async function sendTimeoutConfigAlert(
  connection: SlackConnection,
  warnings: TimeoutConfigWarning[],
  underProvisioned: TimeoutUnderProvisionedWarning[],
  appUrl: string
): Promise<void> {
  const subFloorCount = warnings.reduce((sum, w) => sum + w.nodes.length, 0)
  const underCount = underProvisioned.reduce((sum, w) => sum + w.nodes.length, 0)
  const totalNodes = subFloorCount + underCount
  if (totalNodes === 0) return

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Step Timeout Warnings', emoji: false } },
  ]

  if (subFloorCount > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Below the reliable minimum:* ${subFloorCount} step${subFloorCount === 1 ? '' : 's'} ${subFloorCount === 1 ? 'has' : 'have'} a timeout below the minimum that reliably works for the node type. On a cold run the step exceeds it before the work starts, so it times out and fails on every retry. Raise each to at least the listed minimum.`,
      },
    })
    for (const w of warnings) {
      const lines = w.nodes
        .slice(0, 20)
        .map((n) => {
          const nodeUrl = `${appUrl}/workflows/${w.workflow_id}?node=${n.node_id}`
          return `• <${nodeUrl}|${n.label || n.namespace}> (${n.type}): set to ${n.configured_ms}ms, needs at least ${n.floor_ms}ms`
        })
      const more = w.nodes.length > 20 ? `\n_and ${w.nodes.length - 20} more_` : ''
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${w.workflow_name}*\n${lines.join('\n')}${more}` },
      })
    }
  }

  if (underCount > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Below the suggested value:* ${underCount} step${underCount === 1 ? '' : 's'} ${underCount === 1 ? 'has' : 'have'} a timeout below what typical run history clears: most runs at this step time out or burn a retry, not just the rare slow outlier.`,
      },
    })
    for (const w of underProvisioned) {
      const lines = w.nodes
        .slice(0, 20)
        .map((n) => {
          const nodeUrl = `${appUrl}/workflows/${w.workflow_id}?node=${n.node_id}`
          return `• <${nodeUrl}|${n.label || n.namespace}> (${n.type}): set to ${n.configured_ms.toLocaleString()}ms, most runs would time out. Try ${n.suggested_ms.toLocaleString()}ms (p99 ${n.p99_ms.toLocaleString()}ms over ${n.sample_size.toLocaleString()} runs)`
        })
      const more = w.nodes.length > 20 ? `\n_and ${w.nodes.length - 20} more_` : ''
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${w.workflow_name}*\n${lines.join('\n')}${more}` },
      })
    }
  }

  await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `Step timeout warnings: ${totalNodes} step${totalNodes === 1 ? '' : 's'} need a higher timeout`
  )
}

/**
 * Alert that one or more secret env vars the database expects are missing from
 * Cloudflare — so any workflow referencing them resolves to nothing (#199).
 * Posted by the daily secret-drift cron; the caller has already fetched the
 * connection and checked config_alerts_enabled. Returns true when delivered.
 */
export async function sendSecretDriftAlert(
  connection: SlackConnection,
  missing: { key: string; scope: string; workflow_id: string | null }[],
  appUrl: string
): Promise<boolean> {
  if (missing.length === 0) return false

  const lines = missing.slice(0, 30).map((s) => {
    const where = s.scope === 'global' || !s.workflow_id ? 'global' : `workflow ${s.workflow_id}`
    return `• \`${s.key}\` (${where})`
  })
  const more = missing.length > 30 ? `\n_and ${missing.length - 30} more_` : ''

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Secret Out of Sync', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${missing.length} secret${missing.length === 1 ? '' : 's'} the app expects ${missing.length === 1 ? 'is' : 'are'} missing from Cloudflare.* Any workflow referencing ${missing.length === 1 ? 'it' : 'them'} resolves to nothing. Re-sync from the saved copy on the Environment Variables page.`,
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') + more } },
    { type: 'section', text: { type: 'mrkdwn', text: `<${appUrl}/env|Open Environment Variables →>` } },
  ]

  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `Secrets out of sync: ${missing.length} missing from Cloudflare`
  )) !== null
}

export interface BackupFailureAlert {
  workflow_id: string
  workflow_name: string
  consecutive_failures: number
  error_message: string
}

export interface OutcomeDeadLetterAlert {
  /** The tier-2 op that was lost, e.g. 'lead_sightings.finalize'. */
  label: string
  /** Losses accumulated in the alert window, including those the cooldown
   *  suppressed. NOT a consecutive streak: a partial outage interleaves successes,
   *  so a streak understated the incident (#599). */
  window_loss_count: number
  /** Length of that window in minutes, for the copy. */
  window_minutes: number
  error_message: string
  /**
   * SQLSTATE / PostgREST code of the cause, when the loss was a Supabase write
   * (undefined for a non-DB failure like a tier-3 Salesforce writeback). Gates
   * the "How to fix" copy: only a genuinely transient DB code points the reader
   * at Supabase health; a permanent code (constraint, no-row-matched) does not
   * (#600).
   */
  error_code?: string | null
}

/**
 * Cause-specific remediation line for a dead-lettered outcome write (#600, #585).
 *
 * The write already survived the full retry ladder before dead-lettering, so the
 * brief nightly-purge 503 is never the real cause. Classification reuses db-retry
 * (the single source of truth), so this copy can never drift from what the retry
 * logic actually treats as transient vs permanent.
 */
function outcomeDeadLetterGuidance(label: string, errorCode: string | null | undefined): string {
  const err = errorCode ? { code: errorCode, message: '' } : null

  // #585: an execution_finalize loss that is NOT a missing row left the
  // workflow_executions row stuck at status='running' (the UPDATE could not
  // land). That is exactly what the stranded-execution drain repairs on its
  // per-minute cron, so this self-heals. Say so instead of paging as if the
  // record were lost. The no-row case falls through: there is no 'running' row
  // for the drain to find, so it stays genuinely unrecoverable below.
  if (label === 'execution_finalize' && !isNoRowMatchedError(err)) {
    return `*How to fix:* This left the execution row stuck at status='running'; the record itself is intact. The stranded-execution drain runs every minute and finalizes rows once they are older than ${STRAND_DRAIN_MIN_AGE_MINUTES} minutes, so this recovers automatically. Confirm the row reached a terminal status; only escalate if it is still 'running' beyond ${STRAND_DRAIN_MIN_AGE_MINUTES} minutes.`
  }

  const base =
    '*How to fix:* This write is not auto-recovered. The lost record must be re-derived manually from the execution log below.'
  if (isNoRowMatchedError(err)) {
    // The finalize/execution case is a served lead whose row could not be
    // created or reconstructed; the lead-sightings case is an ordering race
    // between two of our own writes. Both are permanent and both need the
    // execution log, but only the sightings case has the #591 explanation.
    if (label === 'execution_finalize') {
      return `${base} The execution row could not be created or reconstructed, so a served lead has no audit record. Inspect the error above.`
    }
    return `${base} The row it targeted did not exist when it ran, usually an ordering race between two of our own background writes (see #591), not a database outage. Inspect the error above.`
  }
  if (isPermanentDbError(err)) {
    return `${base} The error above is permanent, so retrying cannot fix it (the write is malformed or the schema drifted). Fix the cause rather than waiting it out.`
  }
  if (errorCode) {
    return `${base} The write exhausted its full retry ladder, so Supabase was likely degraded for longer than the retry window. Check Supabase health.`
  }
  return `${base} Inspect the error above to find the cause.`
}

/**
 * Alert that a must-not-lose outcome write was dead-lettered after its retries
 * were exhausted (or a tier-3 Salesforce writeback was given up on). The record
 * feeds billing / win-tracking / repeat-lead analytics and is NOT auto-recovered.
 * Caller has already fetched the connection and checked config_alerts_enabled.
 * Returns true when delivered. See #309.
 */
export async function sendOutcomeDeadLetterAlert(
  connection: SlackConnection,
  payload: OutcomeDeadLetterAlert,
  appUrl: string
): Promise<boolean> {
  const errText = truncateErrorForAlert(payload.error_message)
  // #585: an execution_finalize loss that isn't a missing row self-heals via the
  // stranded-execution drain. Reframe the whole alert (header + summary) so it
  // reads as a recoverable delay, not a permanent loss, matching the guidance.
  const err = payload.error_code ? { code: payload.error_code, message: '' } : null
  const drainRecoverable = payload.label === 'execution_finalize' && !isNoRowMatchedError(err)
  const wasWere = payload.window_loss_count === 1 ? 'write was' : 'writes were'
  const summary = drainRecoverable
    ? `A finalize write (*${payload.label}*) failed after all retries, so *${payload.window_loss_count}* execution ${payload.window_loss_count === 1 ? 'row is' : 'rows are'} stuck at status='running' from the last ${payload.window_minutes} minutes. The records are intact and the stranded-execution drain recovers them automatically; this is informational unless it persists.`
    : `A must-not-lose outcome write (*${payload.label}*) failed after all retries. *${payload.window_loss_count}* ${wasWere} lost in the last ${payload.window_minutes} minutes. These records feed billing, win-tracking, and repeat-lead analytics; they were not saved and are not auto-recovered.`
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: drainRecoverable ? 'Execution Finalize Delayed' : 'Outcome Record Lost', emoji: false },
    },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Error:* ${errText}` } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: outcomeDeadLetterGuidance(payload.label, payload.error_code) },
    },
    { type: 'section', text: { type: 'mrkdwn', text: `<${appUrl}/dashboard|Open dashboard →>` } },
  ]

  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    drainRecoverable ? `Execution finalize delayed: ${payload.label}` : `Outcome record lost: ${payload.label}`
  )) !== null
}

/**
 * Alert that the off-Supabase GitHub backup for a workflow has failed repeatedly.
 * Posted from the workflow save path once the per-org failure streak crosses the
 * threshold; the caller has already fetched the connection and checked
 * config_alerts_enabled. Returns true when delivered. See #206.
 */
export async function sendBackupFailureAlert(
  connection: SlackConnection,
  payload: BackupFailureAlert,
  appUrl: string
): Promise<boolean> {
  const errText = truncateErrorForAlert(payload.error_message)
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Workflow Backup Failing', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `The off-Supabase GitHub backup for *${payload.workflow_name}* has failed *${payload.consecutive_failures} saves in a row*. Recent saves are not being mirrored and their version history has no commit on GitHub until this is fixed.`,
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: `*Error:* ${errText}` } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Check that the GitHub token is valid and the backup repo is configured correctly, or confirm GitHub is reachable.',
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: `<${appUrl}/workflows/${payload.workflow_id}|Open workflow →>` } },
  ]

  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `Workflow backup failing: ${payload.workflow_name}`
  )) !== null
}

/**
 * Alert that the daily lead-sighting strand drain has stalled: in_flight
 * sightings older than the drain's cutoff are piling up, which means they will
 * be exported to Snowflake mislabeled (the #343 regression). #350
 */
export async function sendDrainStallAlert(
  supabase: SupabaseClient,
  orgId: string,
  strandedCount: number,
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Lead-sighting strand drain has stalled', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${strandedCount.toLocaleString()}* lead_sightings rows are stuck at \`outcome_state='in_flight'\` and older than 30 hours. The daily drains (08:00 + 08:30 UTC) should have finalized these. While they stay stuck, the 09:00 UTC Snowflake export records them with a null winner/bid/enrichment instead of their real outcome. This is the data-loss mode #343 fixed, so the drain has likely stopped running.`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*How to fix:* In the Supabase SQL editor, check the jobs ran: `SELECT j.jobname, d.status, d.return_message, d.start_time FROM cron.job_run_details d JOIN cron.job j USING (jobid) WHERE j.jobname IN (\'reduce-finalize-stranded\',\'finalize-unrecoverable-stranded\') ORDER BY d.start_time DESC LIMIT 6;`. If they errored or did not run, re-run by hand: `SELECT public.reduce_finalize_stranded(8); SELECT public.finalize_unrecoverable_stranded(26);`. Common causes: lock contention with the 03:30 UTC partition purge, a permission change on the SECURITY DEFINER functions, or schema drift on lead_sightings.',
      },
    },
  ]
  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `Strand drain stalled: ${strandedCount.toLocaleString()} in_flight lead_sightings over 30h old`,
  )) !== null
}

/**
 * Alert that one or more non-partitioned tables have grown large enough that
 * unbounded PostgREST list reads will truncate at the 1,000-row cap, and they
 * aren't yet in the pagination guard's known list (#222).
 */
export async function sendBigTableGrowthAlert(
  supabase: SupabaseClient,
  orgId: string,
  tables: { table_name: string; est_rows: number }[],
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false
  const list = tables.map((t) => `• \`${t.table_name}\` (~${t.est_rows.toLocaleString()} rows)`).join('\n')
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Table approaching the 1,000-row read cap', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `These non-partitioned tables have grown large but aren't in the pagination guard's known list, so an unbounded \`.select()\` of them will silently truncate at PostgREST's 1,000-row cap:\n${list}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Add each to `BIG_TABLES` (apps/web/.../worker-big-table-pagination.test.ts) and the mirrored `KNOWN_BIG_TABLES` (apps/worker/src/lib/big-table-guard.ts), and make sure reads use `fetchAllPaged` / `.range()` / `.single()`.',
      },
    },
  ]
  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `Big table approaching the 1,000-row cap: ${tables.map((t) => t.table_name).join(', ')}`,
  )) !== null
}

export async function sendCronHeartbeatAlert(
  supabase: SupabaseClient,
  orgId: string,
  job: { label: string; triggerCron: string; dependents: string },
  status: 'stale' | 'never_ran',
  ageMs: number | null,
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false
  const hours = ageMs === null ? null : Math.round(ageMs / 3_600_000)
  const when =
    status === 'never_ran'
      ? `has not run since it was first observed${hours === null ? '' : ` ~${hours}h ago`}`
      : `has not run in ~${hours}h`
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${job.label} is dark`, emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `The ${job.label} cron (\`${job.triggerCron}\`) ${when}. While it is down: ${job.dependents}.`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*How to fix:* confirm the worker deployed with its cron triggers (wrangler.toml \`[triggers]\` must include \`${job.triggerCron}\`) and that the scheduled handler is not throwing before dispatch. Check the Cloudflare dashboard: Workers and Pages > bidspoke-worker > Settings > Triggers, and the worker logs for the \`${job.triggerCron}\` run.`,
      },
    },
  ]
  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `${job.label} is dark (${status})`,
  )) !== null
}

/**
 * Alert that a DATABASE scheduled job is failing or has stopped (#770).
 *
 * Each status gets its own wording. A job erroring every run, a job that has
 * quietly stopped being scheduled, and a job whose schedule this check cannot
 * read need three different actions, and saying the wrong one sends the reader
 * to the wrong place (LESSONS L11).
 */
export async function sendPgCronAlert(
  supabase: SupabaseClient,
  orgId: string,
  verdict: { jobname: string; status: string; detail: string },
  schedule: string,
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false

  const headers: Record<string, string> = {
    failing: `Database job ${verdict.jobname} is failing`,
    stalled: `Database job ${verdict.jobname} has stopped running`,
    never_succeeded: `Database job ${verdict.jobname} has never succeeded`,
    unknown_schedule: `Cannot tell whether database job ${verdict.jobname} is healthy`,
    inactive: `Database job ${verdict.jobname} is disabled`,
  }
  const fixes: Record<string, string> = {
    failing: `*How to fix:* read the error above. \`cron.job_run_details\` holds the full message and the run history for this job.`,
    stalled: `*How to fix:* check the job is still present and active in \`cron.job\`. A job removed or disabled by a migration produces no failed runs, so its silence is the only signal there is.`,
    never_succeeded: `*How to fix:* the job is scheduled and has not completed successfully in the window. Read its most recent run in \`cron.job_run_details\`.`,
    unknown_schedule: `*How to fix:* the staleness half of this check is not running for this job. Either simplify the schedule or teach \`expectedGapMs\` to read this shape.`,
    inactive: `*How to fix:* re-enable it, or remove it, so a job nobody meant to keep is not left looking scheduled.`,
  }

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headers[verdict.status] ?? `Database job ${verdict.jobname} needs attention`, emoji: false },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`${verdict.jobname}\` (\`${schedule}\`): ${verdict.detail}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: fixes[verdict.status] ?? '*How to fix:* read this job in `cron.job_run_details`.' },
    },
  ]
  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `${verdict.jobname}: ${verdict.status}`,
  )) !== null
}

/**
 * Alert about the repo's SCHEDULED GITHUB WORKFLOWS: which have gone dark, which
 * are firing and failing, and whether the check can see them at all (#805, #843,
 * #844).
 *
 * ONE message per run, whatever the registry length. Before #843 each watched
 * workflow posted its own message with its own timer, so every cause that is
 * global rather than per-workflow (an unusable credential, a GitHub outage, a
 * rate limit) arrived as one identical message per entry, four times a day, and
 * the registry length decided how loud one fact was (L36).
 *
 * Each status keeps its own wording. A workflow that stopped firing, one that
 * fires and fails, one the check cannot read, and a registry entry naming a file
 * that is gone need four different actions, and saying the wrong one sends the
 * reader to the wrong place while the real fault continues (L11). In particular a
 * check that cannot see must never be reported as a workflow that stopped: that
 * is an accusation this check cannot support (L119).
 */
export interface WorkflowScheduleAlert {
  /** Set when the check could not read the repository at all. */
  config: { reason: string; files: string[] } | null
  /** The workflows with a real per-workflow verdict. Empty when config is set. */
  workflows: { workflow: WatchedWorkflow; verdict: ScheduleVerdict }[]
}

const scheduleHeadline = (label: string, status: ScheduleStatus): string => {
  switch (status) {
    case 'stale':
      return `${label} has stopped running`
    case 'never_ran':
      return `${label} has never run on its schedule`
    case 'failing':
      // Not "every run": what was measured is a run of consecutive failures at
      // the head of the history, and the whole history was never read (L11).
      return `${label} keeps failing`
    case 'missing':
      return `${label} is no longer in the repository`
    default:
      return `Cannot tell whether ${label} is still running`
  }
}

const scheduleSentence = (
  { file, cron, dependents }: WatchedWorkflow,
  { status, ageMs, detail }: ScheduleVerdict,
): string => {
  const hours = ageMs === null ? null : Math.round(ageMs / 3_600_000)
  switch (status) {
    case 'stale':
      return `\`${file}\` (\`${cron}\`) has not run on its schedule in ~${hours}h. While it is not running: ${dependents}.`
    case 'never_ran':
      return `GitHub has no scheduled runs on record for \`${file}\` (\`${cron}\`). While it is not running: ${dependents}.`
    case 'failing':
      return `\`${file}\` (\`${cron}\`) is running on time but ${detail}. It is firing, so nothing needs re-enabling: the runs themselves are going red.`
    case 'missing':
      return `\`${file}\` is in the worker's watch list but GitHub does not have it: ${detail}. Either the file was renamed or deleted, or the watch list is out of date.`
    default:
      return `The check that watches the \`${file}\` schedule could not read GitHub's run history: ${detail}. Until it can, a workflow that has silently stopped would look exactly like one that is fine, so this is reported rather than passed over.`
  }
}

/** The fix hints the statuses present in this alert actually call for. */
const scheduleFixes = (statuses: Set<ScheduleStatus>): string[] => {
  const fixes: string[] = []
  if (statuses.has('stale') || statuses.has('never_ran')) {
    fixes.push(
      'For a workflow that has stopped: open it in GitHub Actions. A workflow disabled by hand, or one GitHub suspended for repository inactivity, both show there and both are re-enabled from that page. If it is enabled, check the `schedule` trigger in `.github/workflows`.',
    )
  }
  if (statuses.has('failing')) {
    fixes.push('For a workflow that is failing: open its most recent run in GitHub Actions and read the failed step.')
  }
  if (statuses.has('missing')) {
    fixes.push(
      'For a workflow GitHub does not have: either restore the file or remove its entry from `WATCHED_WORKFLOWS` in `apps/worker/src/lib/workflow-schedule-watch.ts`.',
    )
  }
  if (statuses.has('unreadable')) {
    fixes.push(SCHEDULE_ACCESS_FIX)
  }
  return fixes
}

/**
 * Named once so the configuration message and a per-workflow unreadable state
 * cannot drift apart, and so it names the DEDICATED secret. The live #842 failure
 * was the check borrowing `GITHUB_TOKEN`, which exists to push to the separate
 * backup repo and cannot see this repository at all.
 */
const SCHEDULE_ACCESS_FIX =
  'The worker needs `GITHUB_ACTIONS_TOKEN` set to a credential that can read this repository\'s Actions history (a fine-grained token scoped to this repository with Actions: read and write, and Metadata: read; write is needed because the worker also dispatches these workflows itself), and `GITHUB_CODE_REPO` set to this repository. `GITHUB_TOKEN` is only a fallback and belongs to the workflow-backup repo, so it is expected not to work here.'

/**
 * The worker could not DISPATCH one or more scheduled workflows (#1058).
 *
 * Separate from `sendWorkflowScheduleAlert` on purpose. That one reports a
 * workflow that has stopped running and points the reader at GitHub Actions to
 * re-enable it. When the cause is our own driver being refused, that advice is
 * wrong and the reader loses time on a workflow that was never disabled, which
 * is L11 exactly: a message may claim only what its check actually measured.
 * This fires hours earlier and names the real repair.
 *
 * Only `failed` and `unconfigured` speak. An `unknown` outcome means the last
 * run could not be read, and the schedule watch already reports that condition;
 * repeating it here would be two checks alerting on one fact (L53).
 */
export async function sendWorkflowDispatchAlert(
  supabase: SupabaseClient,
  orgId: string,
  results: DispatchAttempt[],
): Promise<boolean> {
  const problems = dispatchFailed(results)
  if (problems.length === 0) return false
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false

  const many = problems.length > 1
  const files = problems.map((p) => `\`${p.file}\``).join(', ')
  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: many
          ? `The worker could not start ${problems.length} scheduled checks`
          : `The worker could not start ${problems[0].file}`,
        emoji: false,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `GitHub stopped delivering this repository's scheduled events reliably, so the worker dispatches these ` +
          `checks from its own cron. That dispatch is failing, which means ${files} ${many ? 'are' : 'is'} ` +
          'not running at all. Whatever each one protects is unprotected until this is fixed.',
      },
    },
  ]

  for (const problem of problems) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*\`${problem.file}\`:* ${problem.reason}` },
    })
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        '*How to fix:* This is not a workflow that needs re-enabling in GitHub Actions. The dispatch itself is ' +
        'being refused, so read the reason above: a 401 or 403 means `GITHUB_ACTIONS_TOKEN` needs Actions read ' +
        'and write on this repository, a 422 means the workflow is missing its `driver` input, and a missing ' +
        'secret names itself.',
    },
  })

  const summary = `workflow dispatch failed: ${problems.map((p) => p.file).join(', ')}`
  return (await postMessage(connection.bot_token, connection.default_channel, blocks, summary)) !== null
}

export async function sendWorkflowScheduleAlert(
  supabase: SupabaseClient,
  orgId: string,
  alert: WorkflowScheduleAlert,
): Promise<boolean> {
  if (alert.config === null && alert.workflows.length === 0) return false
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false

  const blocks: unknown[] = []
  let summary: string

  if (alert.config !== null) {
    // One fact about configuration. It still names what is unwatched, or the
    // reader cannot judge how much it matters, and it deliberately does not
    // accuse any workflow of having stopped.
    const files = alert.config.files.map((f) => `\`${f}\``).join(', ')
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: 'Cannot tell whether the scheduled checks are still running', emoji: false },
    })
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `The check that watches this repository's scheduled workflows could not read GitHub's run history: ${alert.config.reason}. Until it can, a workflow that has silently stopped would look exactly like one that is fine, so this is reported rather than passed over. Unwatched meanwhile: ${files}.`,
      },
    })
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*How to fix:* ${SCHEDULE_ACCESS_FIX}` } })
    summary = 'scheduled workflow check: cannot read GitHub'
  } else {
    const many = alert.workflows.length > 1
    const header = many
      ? `${alert.workflows.length} scheduled checks need attention`
      : scheduleHeadline(alert.workflows[0].workflow.label, alert.workflows[0].verdict.status)
    blocks.push({ type: 'header', text: { type: 'plain_text', text: header, emoji: false } })
    for (const { workflow, verdict } of alert.workflows) {
      const lead = many ? `*${scheduleHeadline(workflow.label, verdict.status)}.* ` : ''
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${lead}${scheduleSentence(workflow, verdict)}` },
      })
    }
    const fixes = scheduleFixes(new Set(alert.workflows.map((w) => w.verdict.status)))
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*How to fix:* ${fixes.join(' ')}` } })
    summary = alert.workflows.map((w) => `${w.workflow.label}: ${w.verdict.status}`).join(', ')
  }

  return (await postMessage(connection.bot_token, connection.default_channel, blocks, summary)) !== null
}

/**
 * Alert that the hourly bid-matrix sync had problems (#408): one or more partner
 * configs failed to sync (Salesforce down / token expired, so the matrix is going
 * stale) and/or returned empty so the last-known matrix was preserved instead of
 * applied (#407). Aggregated per org; uses the config-alerts toggle. Returns true
 * when delivered. A manual "Sync now" intentionally does not call this.
 */
export async function sendMatrixSyncFailureAlert(
  supabase: SupabaseClient,
  orgId: string,
  channelOverride: string | null,
  issue: { failed: { config_slug: string; error: string }[]; preserved: { config_slug: string }[] },
): Promise<boolean> {
  if (issue.failed.length === 0 && issue.preserved.length === 0) return false
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection || !connection.config_alerts_enabled) return false

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Bid matrix sync needs attention', emoji: false } },
  ]
  if (issue.failed.length > 0) {
    const lines = issue.failed.slice(0, 20).map((f) => `• \`${f.config_slug}\`: ${f.error}`).join('\n')
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${issue.failed.length} partner matrix sync${issue.failed.length === 1 ? '' : 's'} failed.* The matrix is serving the last good data and will go stale until the next good sync:\n${lines}`,
      },
    })
  }
  if (issue.preserved.length > 0) {
    const lines = issue.preserved.slice(0, 20).map((p) => `• \`${p.config_slug}\``).join('\n')
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${issue.preserved.length} matrix${issue.preserved.length === 1 ? '' : 'es'} preserved.* Salesforce returned no rows, so the last-known matrix was kept rather than wiped. Confirm whether the partner's ranges were intentionally cleared:\n${lines}`,
      },
    })
  }
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*How to fix:* check Salesforce availability and that the partner flag filter (`Is{Partner}__c`) still matches rows. Bidding keeps running on the last good matrix meanwhile.',
    },
  })

  const channel = channelOverride || connection.default_channel
  const summary = `Bid matrix sync: ${issue.failed.length} failed, ${issue.preserved.length} preserved`
  return (await postMessage(connection.bot_token, channel, blocks, summary)) !== null
}

/**
 * Alert that a Snowflake export reported errors (#412). The export jobs
 * accumulate failures into a returned summary rather than throwing, so a Snowflake
 * outage was previously only console-logged. Rows stay in Supabase (not purged)
 * until a later run succeeds, so there's no data loss, only a stalled pipeline and
 * disk pressure. Uses the config-alerts toggle. Returns true when delivered.
 *
 * Deliberately does not say "nightly": only the Achieve export runs once a day.
 * The lead sightings export has run every 2 hours since 2026-06-29, so a single
 * failed run is normally picked back up well before the next morning.
 */
export async function sendExportFailureAlert(
  supabase: SupabaseClient,
  orgId: string,
  channelOverride: string | null,
  payload: { jobName: string; errors: string[]; fixHint?: string; failingSince?: string },
): Promise<boolean> {
  if (payload.errors.length === 0) return false
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection || !connection.config_alerts_enabled) return false

  const lines = payload.errors.slice(0, 20).map((line) => `• ${line}`).join('\n')
  // A failed purge means the rows are ALREADY in Snowflake and only the Supabase
  // cleanup is behind; claiming stale analytics for it is false-alarm copy
  // (2026-07-24). Only an export failure actually leaves analytics behind.
  const isPurge = payload.jobName.toLowerCase().includes('purge')
  const consequence = isPurge
    ? 'The affected rows are already exported to Snowflake, so analytics are fine; only the Supabase cleanup is behind, and it retries on the next run. Watch Supabase disk if this persists:'
    : 'The affected rows were not exported and will retry on the next run, but analytics in Snowflake are missing them until it succeeds:'
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: `${payload.jobName} failed`, emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${payload.jobName}* reported ${payload.errors.length} error${payload.errors.length === 1 ? '' : 's'}. ${consequence}\n${lines}`,
      },
    },
  ]
  if (payload.failingSince) {
    const since = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(payload.failingSince))
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        // Present only when the transient grace held back an earlier failure:
        // this is the second consecutive failed run, no longer a lone blip.
        text: `*Failing since:* ${since}. This is the second consecutive failed run; the first was held back as a likely one-off blip.`,
      },
    })
  }
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      // The hint is derived from the actual error class by the caller (#542).
      // Falls back to the generic line for callers that don't classify.
      text: `*How to fix:* ${payload.fixHint ?? GENERIC_FIX_HINT}`,
    },
  })
  const channel = channelOverride || connection.default_channel
  return (await postMessage(connection.bot_token, channel, blocks, `${payload.jobName} failed: ${payload.errors.length} error(s)`)) !== null
}

/**
 * Alert that secret env vars cannot be decrypted (#404). The env-loader silently
 * skips these, so a node loses the credential with no error until the call fails.
 * The cause is almost always a stored value encrypted under a previous
 * SECRET_ENCRYPTION_KEY (or predating encryption), so the fix is to re-enter the
 * value in the UI to re-encrypt it under the current key. Returns true when delivered.
 */
export async function sendSecretDecryptAlert(
  connection: SlackConnection,
  keys: string[],
  appUrl: string,
): Promise<boolean> {
  if (keys.length === 0) return false
  const lines = keys.slice(0, 30).map((k) => `• \`${k}\``)
  const more = keys.length > 30 ? `\n_and ${keys.length - 30} more_` : ''
  const isOne = keys.length === 1
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Secret cannot be decrypted', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${keys.length} secret${isOne ? '' : 's'} cannot be decrypted* and ${isOne ? 'is' : 'are'} silently skipped at load, so any node that needs ${isOne ? 'it' : 'them'} runs without the credential (no error until the partner call fails):`,
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') + more } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*How to fix:* the stored value was encrypted under a previous SECRET_ENCRYPTION_KEY (or predates encryption). Re-enter each secret's value on the Environment Variables page to re-encrypt it under the current key.\n<${appUrl}/env|Open Environment Variables →>`,
      },
    },
  ]
  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `Secret cannot be decrypted: ${keys.join(', ')}`,
  )) !== null
}

export async function sendRequiredSecretsAlert(
  supabase: SupabaseClient,
  orgId: string,
  missingKeys: string[],
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection || !connection.config_alerts_enabled) return false
  const list = missingKeys.map((k) => `• \`${k}\``).join('\n')
  const fixCmds = missingKeys.map((k) => `wrangler secret put ${k} --name bidspoke-worker`).join('\n')
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Required worker secret missing in production', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `These secrets the worker requires are unset or empty, so the code paths that use them will fail on live traffic:\n${list}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*How to fix:* set each from its source in a real terminal (a non-interactive shell uploads a blank value), then redeploy:\n\`\`\`\n${fixCmds}\n\`\`\`\nSources for each secret are in docs/disaster-recovery.md (Secret inventory).`,
      },
    },
  ]
  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `Required worker secret missing: ${missingKeys.join(', ')}`,
  )) !== null
}

/**
 * Alert that a required non-secret config value (environment_variables table)
 * is missing or blank in production, so the workflows that use it will fail on
 * live traffic (#394). Unlike a worker secret, these are fixed in the Bidspoke
 * UI, so the alert points there. Returns true when delivered.
 */
export async function sendRequiredEnvVarsAlert(
  supabase: SupabaseClient,
  orgId: string,
  missingKeys: string[],
  appUrl?: string,
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection || !connection.config_alerts_enabled) return false
  const list = missingKeys.map((k) => `• \`${k}\``).join('\n')
  const link = appUrl ? `\n<${appUrl}/env|Open Environment Variables →>` : ''
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Required configuration value missing in production', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `These required configuration values are unset or blank, so the workflows that use them (Salesforce, Equifax) will fail on live traffic:\n${list}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*How to fix:* open Environment Variables in Bidspoke and set each key to its correct value.${link}`,
      },
    },
  ]
  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `Required configuration value missing: ${missingKeys.join(', ')}`,
  )) !== null
}

function linkSuffix(url: string | undefined): string {
  return url ? ` · <${url}|view in SF>` : ''
}

function formatValue(v: unknown, field: string): string {
  if (v === null || v === undefined) return '∅'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return field === 'bid_amount' ? `$${v}` : String(v)
  return coerceString(v)
}

export async function sendCircuitAlert(
  supabase: SupabaseClient,
  orgId: string,
  channelOverride: string | null,
  payload: CircuitAlertPayload
): Promise<void> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return

  const channel = channelOverride || connection.default_channel
  const isOpen = payload.state === 'opened'

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: isOpen ? 'Circuit Breaker Opened' : 'Circuit Breaker Recovered',
        emoji: false,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Service:* ${payload.service_name}` },
        ...(isOpen && payload.error_count !== undefined
          ? [{ type: 'mrkdwn', text: `*Errors in window:* ${payload.error_count}` }]
          : []),
        ...(isOpen && payload.consecutive_cooldowns !== undefined && payload.consecutive_cooldowns > 0
          ? [{ type: 'mrkdwn', text: `*Consecutive cooldowns:* ${payload.consecutive_cooldowns}` }]
          : []),
      ],
    },
  ]

  const fallback = isOpen
    ? `Circuit breaker opened for ${payload.service_name}`
    : `Circuit breaker recovered for ${payload.service_name}`

  await postMessage(connection.bot_token, channel, blocks, fallback)
}

/**
 * The all-clear for a rate-aggregated alert (#253).
 *
 * The three rate checks paged when a rate started spiking and said nothing when
 * it recovered, so silence in Slack meant both "still broken, suppressed by the
 * cooldown" and "fine again". Those are the two states a reader most needs to
 * tell apart during an incident, so recovery is now announced explicitly and
 * says how long the condition lasted.
 *
 * Returns whether it actually reached Slack. The caller only clears its
 * recovery marker on true, so a kicked bot retries rather than leaving the page
 * as the last word.
 */
export async function sendRecoveryAlert(
  slack: { bot_token: string },
  channel: string,
  payload: {
    signal: string
    subject: string
    alertedAt: string
    endedAt?: string | null
    url?: string
    /**
     * For a check that judges a TRAILING WINDOW rather than a running total, how
     * long that window is (#1101).
     *
     * Such a check observes the condition once per tick, so the gap between the
     * first and last alerting tick is not the length of the incident: a one-tick
     * incident has a gap of zero, and the field presence check would have
     * reported "under a minute" for the real thirty minute outage of
     * 2026-09-02. When the observed span is shorter than one window, the notice
     * reports the window it measured instead of asserting a span it did not
     * (L11). Omitted by the checks that judge a continuous rate, which keep
     * reporting their span unchanged.
     */
    measuredWindowMinutes?: number
  },
  now: number = Date.now(),
): Promise<boolean> {
  const started = Date.parse(payload.alertedAt)
  // The all-clear waits out a re-arm window before it is sent (#814), so the
  // duration is measured to the LAST OBSERVED FAILURE. Measuring to now would
  // add the whole quiet window to every reported outage. Falls back to now when
  // no end was recorded, and then claims nothing about when it cleared.
  const ended = payload.endedAt ? Date.parse(payload.endedAt) : NaN
  const clearedAt = Number.isFinite(ended) ? ended : null
  // An unparseable marker must not render "NaN minutes"; say nothing about the
  // duration rather than something wrong (LESSONS L11, L50).
  const lasted = Number.isFinite(started) ? describeDuration((clearedAt ?? now) - started) : null

  // A windowed check that saw the condition on only one tick knows the incident
  // happened somewhere inside that window and nothing finer. Reporting the tick
  // gap there would assert a duration nobody measured, so the window is named
  // instead.
  const windowMs = (payload.measuredWindowMinutes ?? 0) * 60 * 1000
  const spanMs = Number.isFinite(started) ? (clearedAt ?? now) - started : NaN
  const withinOneWindow = windowMs > 0 && Number.isFinite(spanMs) && spanMs < windowMs
  const windowWords = withinOneWindow ? describeDuration(windowMs) : null

  const howLong = withinOneWindow && windowWords
    ? ` and covered the ${windowWords} before it, which is as precisely as this check measures`
    : lasted ? ` and lasted ${lasted}` : ''
  const clearing = clearedAt !== null && (withinOneWindow || lasted)
    ? `, clearing at ${etTime(clearedAt)}.`
    : '.'

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Recovered', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${payload.subject}* is back within normal range. The ${payload.signal} alert fired at ` +
          `${etTime(started)}${howLong}${clearing}`,
      },
    },
  ]
  if (payload.url) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `<${payload.url}|Open workflow >` } })
  }

  return (await postMessage(slack.bot_token, channel, blocks, `Recovered: ${payload.subject}`)) !== null
}

/** A duration in plain words. Rounded, because nobody acts on the seconds. */
export function describeDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  const h = `${hours} hour${hours === 1 ? '' : 's'}`
  return rem === 0 ? h : `${h} ${rem} minute${rem === 1 ? '' : 's'}`
}

/** One ET timestamp format, so a new alert does not add another copy of it. */
export function etTime(at: number | string | Date): string {
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return 'an unknown time'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d)
}

// ── Internal ──────────────────────────────────────────────────────────────────

// Post a Slack message. Returns the message ts on success, or null on any
// failure — an HTTP error OR an API-level error (Slack returns HTTP 200 with
// { ok: false, error } for channel_not_found / not_in_channel / invalid_auth).
// Callers that gate a cooldown must treat null as "not delivered".
export async function postMessage(
  botToken: string,
  channel: string,
  blocks: unknown[],
  text: string
): Promise<string | null> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, blocks, text, unfurl_links: false }),
  })

  if (!res.ok) {
    console.error(`[slack] HTTP error ${res.status}`)
    return null
  }

  const data = await parseJson<{ ok: boolean; error?: string; ts?: string }>(res)
  if (!data.ok) {
    console.error(`[slack] API error: ${data.error}`)
    return null
  }
  return data.ts ?? null
}
