// Slack alert sender — Block Kit messages for workflow failures and circuit breaker events
// Bot token is stored in service_connections.config.bot_token (fetched at runtime from Supabase)

import type { SupabaseClient } from '@supabase/supabase-js'
import { coerceString } from './coerce'
import { parseJson } from './json'
import type { ErrorType } from '../types'

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

export async function getSlackConnection(
  supabase: SupabaseClient,
  orgId: string
): Promise<SlackConnection | null> {
  const { data } = await supabase
    .from('service_connections')
    .select('config')
    .eq('organization_id', orgId)
    .eq('service_type', 'slack')
    .maybeSingle()

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
        text: `*Below the suggested value:* ${underCount} step${underCount === 1 ? '' : 's'} ${underCount === 1 ? 'has' : 'have'} a timeout below what recent run history needs. Slower-than-typical runs hit the timeout and burn retries, or fail outright when the value sits below p99.`,
      },
    })
    for (const w of underProvisioned) {
      const lines = w.nodes
        .slice(0, 20)
        .map((n) => {
          const nodeUrl = `${appUrl}/workflows/${w.workflow_id}?node=${n.node_id}`
          const impact = n.severity === 'red' ? 'most runs would time out' : 'slow runs will time out'
          return `• <${nodeUrl}|${n.label || n.namespace}> (${n.type}): set to ${n.configured_ms.toLocaleString()}ms, ${impact}. Try ${n.suggested_ms.toLocaleString()}ms (p99 ${n.p99_ms.toLocaleString()}ms over ${n.sample_size.toLocaleString()} runs)`
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
  const errText = payload.error_message.length > 300 ? `${payload.error_message.slice(0, 300)}…` : payload.error_message
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
 * Alert that the execution-log writer has been repeatedly falling back from
 * Hyperdrive (direct Postgres) to PostgREST — i.e. the direct path is degraded
 * and the schema-cache-503 protection Hyperdrive provides is currently off (#134).
 */
export async function sendHyperdriveFallbackAlert(
  supabase: SupabaseClient,
  orgId: string,
  count: number,
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Execution-log DB path degraded', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Execution-log writes fell back from Hyperdrive (direct Postgres) to PostgREST *${count}+ times* in the last 5 minutes, outside the nightly partition-purge window. The direct path is likely degraded: a Supabase pooler outage, an expired/rotated DB password, or origin connection-limit exhaustion. While it is down, those writes are back on PostgREST and re-exposed to the schema-cache 503s Hyperdrive was provisioned to eliminate.`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Check the Hyperdrive config and the Supabase pooler / DB credentials. Worker log line: `[step-logger] Hyperdrive insert failed, falling back to PostgREST`. (The nightly 03:30 UTC partition purge causes the same fallback by design. That cluster is auto-suppressed, so this alert means the cause is something else.)',
      },
    },
  ]
  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `Hyperdrive degraded: ${count}+ execution-log writes reverted to PostgREST in 5 min`,
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
