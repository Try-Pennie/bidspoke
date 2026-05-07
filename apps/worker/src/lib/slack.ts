// Slack alert sender — Block Kit messages for workflow failures and circuit breaker events
// Bot token is stored in service_connections.config.bot_token (fetched at runtime from Supabase)

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ErrorType } from '../types'

export interface SlackConnection {
  bot_token: string
  default_channel: string
  workspace_name?: string
  volume_alerts_enabled: boolean
  matrix_alerts_enabled: boolean
  /** Optional dedicated channel for matrix-change alerts. Falls back to default_channel when null. */
  matrix_alerts_channel: string | null
}

export interface FailureAlertPayload {
  workflow_id: string
  workflow_name: string
  execution_id: string
  step_namespace?: string
  error_message: string
  error_type: ErrorType
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
    matrix_alerts_channel: typeof cfg.matrix_alerts_channel === 'string' && cfg.matrix_alerts_channel ? cfg.matrix_alerts_channel : null,
  }
}

// ── Alert senders ─────────────────────────────────────────────────────────────

export async function sendFailureAlert(
  supabase: SupabaseClient,
  orgId: string,
  channelOverride: string | null,
  payload: FailureAlertPayload,
  appUrl: string
): Promise<void> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return  // Slack not configured — silently skip

  const channel = channelOverride || connection.default_channel
  const errorLabel = payload.error_type === 'transient' ? 'Transient' : 'Permanent'
  const stepText = payload.step_namespace ? `\`${payload.step_namespace}\`` : 'unknown step'
  const executionUrl = `${appUrl}/workflows/${payload.workflow_id}?execution=${payload.execution_id}`

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
        { type: 'mrkdwn', text: `*Time:* ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(payload.timestamp))}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Error:*\n\`\`\`${payload.error_message.slice(0, 500)}\`\`\``,
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

  await postMessage(connection.bot_token, channel, blocks, `Workflow "${payload.workflow_name}" failed at ${stepText}: ${payload.error_message}`)
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
  },
  appUrl: string
): Promise<void> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return

  const channel = channelOverride || connection.default_channel
  const seconds = (payload.duration_ms / 1000).toFixed(1)
  const thresholdSeconds = (payload.threshold_ms / 1000).toFixed(0)
  const executionUrl = `${appUrl}/workflows/${payload.workflow_id}?execution=${payload.execution_id}`

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

  await postMessage(
    connection.bot_token,
    channel,
    blocks,
    `Workflow "${payload.workflow_name}" took ${seconds}s (threshold: ${thresholdSeconds}s)`
  )
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

export async function sendMatrixChangeAlert(
  supabase: SupabaseClient,
  orgId: string,
  channelOverride: string | null,
  payload: MatrixChangeAlertPayload
): Promise<void> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return
  if (!connection.matrix_alerts_enabled) return
  if (payload.changes.length === 0) return

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
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${change.partner_slug}* — _${change.config_name}_\n${lines.slice(0, 20).join('\n')}${lines.length > 20 ? `\n_…and ${lines.length - 20} more_` : ''}` },
    })
  }

  if (payload.matrix_url) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `<${payload.matrix_url}|View bid matrix →>` },
    })
  }

  await postMessage(connection.bot_token, channel, blocks, `Bid matrix changed: ${summary}`)
}

function linkSuffix(url: string | undefined): string {
  return url ? ` · <${url}|view in SF>` : ''
}

function formatValue(v: unknown, field: string): string {
  if (v === null || v === undefined) return '∅'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return field === 'bid_amount' ? `$${v}` : String(v)
  return String(v)
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

async function postMessage(
  botToken: string,
  channel: string,
  blocks: unknown[],
  text: string
): Promise<void> {
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
    return
  }

  const data = (await res.json()) as { ok: boolean; error?: string }
  if (!data.ok) {
    console.error(`[slack] API error: ${data.error}`)
  }
}
