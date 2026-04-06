// Slack alert sender — Block Kit messages for workflow failures and circuit breaker events
// Bot token is stored in service_connections.config.bot_token (fetched at runtime from Supabase)

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ErrorType } from '../types'

export interface SlackConnection {
  bot_token: string
  default_channel: string
  workspace_name?: string
}

export interface FailureAlertPayload {
  workflow_id: string
  workflow_name: string
  execution_id: string
  trace_id: string
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
  const cfg = data.config as Record<string, string>
  if (!cfg.bot_token || !cfg.default_channel) return null
  return {
    bot_token: cfg.bot_token,
    default_channel: cfg.default_channel,
    workspace_name: cfg.workspace_name,
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
  const executionUrl = `${appUrl}/workflows/${payload.workflow_id}/executions/${payload.execution_id}`

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '⚠️ Workflow Execution Failed', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Workflow:*\n${payload.workflow_name}` },
        { type: 'mrkdwn', text: `*Failed step:*\n${stepText}` },
        { type: 'mrkdwn', text: `*Error type:*\n${errorLabel}` },
        { type: 'mrkdwn', text: `*Time:*\n${new Date(payload.timestamp).toUTCString()}` },
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
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View execution', emoji: true },
          url: executionUrl,
          style: 'danger',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `trace_id: \`${payload.trace_id}\`` },
      ],
    },
  ]

  await postMessage(connection.bot_token, channel, blocks, `Workflow "${payload.workflow_name}" failed at ${stepText}: ${payload.error_message}`)
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
        text: isOpen ? '🔴 Circuit Breaker Opened' : '🟢 Circuit Breaker Recovered',
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Service:*\n${payload.service_name}` },
        ...(isOpen && payload.error_count !== undefined
          ? [{ type: 'mrkdwn', text: `*Errors in window:*\n${payload.error_count}` }]
          : []),
        ...(isOpen && payload.consecutive_cooldowns !== undefined && payload.consecutive_cooldowns > 0
          ? [{ type: 'mrkdwn', text: `*Consecutive cooldowns:*\n${payload.consecutive_cooldowns}` }]
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
    body: JSON.stringify({ channel, blocks, text }),
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
