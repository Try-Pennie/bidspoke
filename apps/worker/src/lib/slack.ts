// Slack alert sender — Block Kit messages for workflow failures and circuit breaker events
// Bot token is stored in service_connections.config.bot_token (fetched at runtime from Supabase)

import { scheduleInWords } from './schedule-words'
import { DRAIN_STALL_SCHEDULES } from './strand-schedules'
import { listWithOverflow, MAX_LISTED_LINES } from './list-overflow'
import type { SupabaseClient } from '@supabase/supabase-js'
// Type only, so this cannot create an import cycle with the watcher that calls
// sendPgCronAlert: the import is erased at compile time.
import type { AlertingStatus } from './pg-cron-watch'
import { coerceString } from './coerce'
import { parseJson } from './json'
import { stripUrlQueriesInText } from './url-redact'
import { isPermanentDbError, isNoRowMatchedError, sleep, toDbError, READ_BACK_MISSING_CODE } from './db-retry'
import { MIN_AGE_MINUTES as STRAND_DRAIN_MIN_AGE_MINUTES } from './stranded-executions'
import { GENERIC_FIX_HINT } from './export-error-hints'
import { truncateErrorForAlert } from './format-error'
import { cloudflareEdgeCodeIn } from './html-error-summary'
import { listSteps } from '../engine/running-step'
import { CONTINUATION_UNFINISHED_LABEL, WRITEBACK_HELD_LABEL, WRITEBACK_STORE_LABEL, WRITEBACK_UNCAPTURABLE_LABEL } from '../engine/dead-letter-labels'
import { describeRepeat, type StandingCondition } from './alert-backoff'
import { RECOVERY_REARM_MINUTES } from './alert-recovery'
import { describeDuration, measureIncidentSpan } from './incident-span'
import type { ErrorType } from '../types'
// Type-only, so this does not create a cycle with the module that calls the
// alert below: the import is erased at build time.
import { GITHUB_RATE_LIMIT_FIX } from './github-refusal'
import type { ScheduleStatus, ScheduleVerdict, WatchedWorkflow } from './workflow-schedule-watch'
import { type DispatchAttempt, dispatchFailed } from './workflow-dispatch-driver'

import { parseSlackConnection, type SlackConnection } from './slack-connection'
import { leadRead } from './lead-read-budget'
export type { SlackConnection } from './slack-connection'

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
    const res = await slackConnectionQuery(supabase, orgId)
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

  return parseSlackConnection(data?.config)
}

/** The one read of an org's Slack connection row, for both readers below. */
function slackConnectionQuery(supabase: SupabaseClient, orgId: string) {
  return supabase
    .from('service_connections')
    .select('config')
    .eq('organization_id', orgId)
    .eq('service_type', 'slack')
    .maybeSingle()
}

/**
 * The org's Slack connection for a page sent while a lead waits (#1849): one
 * read through leadRead, so on a lead's client it is bounded and never retried,
 * and a database outage reaches the caller's fallback (the last-good copy of the
 * Slack connections) at once instead of after getSlackConnection's retries.
 * Null when the org has no usable connection; throws when the row cannot be read.
 */
export async function readSlackConnectionForLead(supabase: SupabaseClient, orgId: string): Promise<SlackConnection | null> {
  const res = await leadRead(supabase, slackConnectionQuery(supabase, orgId), 'slack connection')
  if (res.error) throw new Error(`service_connections: ${res.error.message}`)
  return parseSlackConnection((res.data as { config?: unknown } | null)?.config)
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
  // The step's error text, never our own link above: an address inside it loses its
  // query string, which a script's fetch failure names in full (L741, #1740).
  const errorText = stripUrlQueriesInText(payload.error_message)

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
          const full = errorText
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

  const ts = await postMessage(connection.bot_token, channel, blocks, `Workflow "${payload.workflow_name}" failed at ${stepText}: ${errorText}`)
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
 *
 * Deliberately does NOT ping the channel, unlike the shared-upstream alert it
 * sits beside. Dan's call on 2026-09-02: the condition is serious but it is
 * measured at roughly three firings in five days, and an alert that interrupts
 * everyone at that rate is how a channel gets muted. A test asserts the sibling
 * alert still pings, so this absence cannot be satisfied by pings breaking
 * everywhere.
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
        ...shapes.map((sh) => `- ${sh.count} x \`${stripUrlQueriesInText(sh.sample).replace(/`/g, "'")}\``),
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
          `*${payload.failure_count} of the ${payload.total_count} runs* on *${payload.workflow_name}* ` +
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
        ...shapes.map((s) => `- ${s.count} x \`${stripUrlQueriesInText(s.sample).replace(/`/g, "'")}\``),
        ...((payload.other_shape_count ?? 0) > 0
          ? [`- and ${payload.other_shape_count} other error ${payload.other_shape_count === 1 ? 'shape' : 'shapes'}`]
          : []),
      ].join('\n')
    : ''
  const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(payload.timestamp))

  // The lead says only what was counted: leads whose errors matched one cause's
  // signature (#835). It used to say "<cause> appears degraded", which no check
  // measured, and which is false for two causes the how to check line below names:
  // a missing credential, and our own Apex failing inside Salesforce.
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Many Leads Failing for One Cause', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<!here> *${payload.failure_count} leads* failed in the last ${payload.window_minutes} minutes with errors matching *${payload.cause_label}*. The page for each lead is held back while this lasts, so this is the one alert for them.`,
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
    `${payload.failure_count} leads failing for one cause: ${payload.cause_label}, in ${payload.window_minutes}m`
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
 * Cloudflare, which leaves them without the fallback a node uses when the saved
 * value cannot be decrypted (#199, #835).
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
        // Workflows read the saved, decrypted value, which wins over the Cloudflare
        // copy (buildSandboxEnv), so a missing copy changes nothing until the saved
        // value also cannot be decrypted (#835). It used to say every workflow
        // referencing the secret resolved to nothing.
        text: `*${missing.length} secret${missing.length === 1 ? '' : 's'} saved in Bidspoke ${missing.length === 1 ? 'has' : 'have'} no copy in Cloudflare.* Workflows still read the saved value. The Cloudflare copy is the fallback that code, Webhook and Salesforce nodes use when the saved value cannot be decrypted, so until it is restored there is no fallback. Fix: re-sync from the saved copy on the Environment Variables page.`,
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
  /** The reminder sentence when this is a repeat of a standing failure (#1337). */
  repeat?: string
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
  /**
   * The run behind the latest loss, when the caller has one (the engine's
   * after-the-answer writeback). Lets the alert name the workflow, the time
   * and link the run instead of pointing at a log it cannot show.
   */
  run?: {
    workflow_id: string
    workflow_name: string
    execution_id: string
    at: string
    /**
     * Work after the answer only (#1882): the steps the run was still on when
     * Bidspoke stopped waiting, by label and namespace. Absent when not known.
     */
    still_running?: string[]
    /**
     * A timed out post-answer update whose request the at-risk record holds, on
     * any object, until the read-back (#2023) takes over the objects it covers
     * (#2163). Field names only, never values.
     */
    held?: {
      step: string
      sf_object: string
      sf_record_id: string
      fields: string[]
      /** ISO: when the held request is deleted. */
      until: string
    }
  }
}

// The sighting strand drain (reduce_finalize_stranded) runs on pg_cron every 30
// minutes. Kept in one place so the finalize guidance, the summary and the bid
// guidance below cannot drift from each other. A guard
// (alert-strand-cadence-matches-cron) ties this to the cron schedule in
// supabase/migrations, so the copy cannot silently go stale if the cron changes.
export const SIGHTING_STRAND_DRAIN_CADENCE_MINUTES = 30

// Whether a dead-lettered write self-heals, shared by the guidance copy and the
// alert header/summary so the two can never disagree (#1953). Each rebuilds the
// db-retry error shape from the code, which is the single source of truth for
// transient vs permanent.
function execFinalizeSelfHeals(label: string, errorCode: string | null | undefined): boolean {
  return label === 'execution_finalize' && !isNoRowMatchedError(errorCode ? { code: errorCode, message: '' } : null)
}
function sightingFinalizeSelfHeals(label: string, errorCode: string | null | undefined): boolean {
  return label === 'lead_sightings.finalize' && !isPermanentDbError(errorCode ? { code: errorCode, message: '' } : null)
}
function bidInsertConditionalRecovery(label: string, errorCode: string | null | undefined): boolean {
  return label === 'lead_sighting_bids.insert' && !isPermanentDbError(errorCode ? { code: errorCode, message: '' } : null)
}

/**
 * Cause-specific remediation line for a dead-lettered outcome write (#600, #585, #1953).
 *
 * The write already survived the full retry ladder before dead-lettering, so the
 * brief nightly-purge 503 is never the real cause. Classification reuses db-retry
 * (the single source of truth), so this copy can never drift from what the retry
 * logic actually treats as transient vs permanent.
 */
function outcomeDeadLetterGuidance(label: string, errorCode: string | null | undefined, hasRun: boolean): string {
  const err = errorCode ? { code: errorCode, message: '' } : null

  // #585: an execution_finalize loss that is NOT a missing row left the
  // workflow_executions row stuck at status='running' (the UPDATE could not
  // land). That is exactly what the stranded-execution drain repairs on its
  // per-minute cron, so this self-heals. Say so instead of paging as if the
  // record were lost. The no-row case falls through: there is no 'running' row
  // for the drain to find, so it stays genuinely unrecoverable below.
  if (execFinalizeSelfHeals(label, errorCode)) {
    return `*How to fix:* This left the execution row stuck at status='running'; the record itself is intact. The stranded-execution drain runs every minute and finalizes rows once they are older than ${STRAND_DRAIN_MIN_AGE_MINUTES} minutes, so this recovers automatically. Confirm the row reached a terminal status; only escalate if it is still 'running' beyond ${STRAND_DRAIN_MIN_AGE_MINUTES} minutes.`
  }

  // #1953: a lost lead-sighting finalize leaves the sighting at
  // outcome_state='in_flight', which reduce_finalize_stranded (the strand drain)
  // replays from the execution's saved finalize data, re-inserting any lost bid
  // rows at the same time. A permanent error or a missing row would recur on the
  // replay, so those fall through to the copy below (isPermanentDbError already
  // covers the no-row code).
  if (sightingFinalizeSelfHeals(label, errorCode)) {
    return `*How to fix:* The lead sighting is stuck at outcome_state='in_flight' and recovers automatically. The strand drain runs every ${SIGHTING_STRAND_DRAIN_CADENCE_MINUTES} minutes and replays the outcome, and any lost bid rows, from the execution's saved finalize data. Confirm the sighting reached outcome_state='finalized'; only escalate if it is still 'in_flight' after the next pass.`
  }

  // #1953: the strand drain re-inserts a lost bid row too, but ONLY when it
  // finalizes a still-stranded sighting (the re-insert is gated on the drain
  // having just recovered that sighting). So a bid row self-heals when the
  // finalize was lost as well (the usual database-slowdown case), but not when
  // the sighting already finalized and only this bid write was lost.
  if (bidInsertConditionalRecovery(label, errorCode)) {
    return `*How to fix:* If the lead sighting is also still at outcome_state='in_flight' (the usual case in a database slowdown), the strand drain re-inserts this bid row automatically within ${SIGHTING_STRAND_DRAIN_CADENCE_MINUTES} minutes when it finalizes the sighting, so no action is needed. If the sighting already finalized, only this bid row is missing and is not auto-recovered: rebuild it by hand from ${hasRun ? 'the run linked below' : 'its run\'s execution log, found from the dashboard below'}.`
  }

  // The alert links the run when it has one; otherwise there is no log below to
  // point at (#835), so the reader is sent to the run by name.
  const base = hasRun
    ? '*How to fix:* This write is not auto-recovered. Rebuild the lost record by hand from the run linked below.'
    : '*How to fix:* This write is not auto-recovered. Rebuild the lost record by hand from its run\'s execution log, found from the dashboard below.'
  if (errorCode === READ_BACK_MISSING_CODE) {
    // #1880: found by reading the record back, not by an error the write returned.
    return `${base} The write timed out while the database was slow, and reading it back a few minutes later found it never landed. The error above names the record.`
  }
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
  // Only a code known to mean an overloaded or unreachable database earns the
  // database line (#835). Anything else outside the permanent list (a missing
  // grant, a missing function) used to read "Supabase was likely degraded", and
  // waiting does not fix those.
  if (isKnownTransientDbCode(errorCode)) {
    return `${base} The error above means the database was overloaded or unreachable for longer than the retries waited. Check the database's health and memory use in the Supabase dashboard for this project.`
  }
  return `${base} Inspect the error above to find the cause.`
}

/**
 * Postgres and PostgREST codes that mean the database was overloaded, busy or
 * briefly unreachable, so a write failing with one would have landed later (#835).
 *
 * Used for alert wording only, never for retry decisions, which db-retry owns:
 * there every code outside its permanent list is retried, which is the safe
 * choice for a write and the wrong one for telling a reader what happened. A
 * code not listed here is not called transient in copy, so an unfamiliar one
 * sends the reader to the error rather than to the database's health.
 */
const TRANSIENT_DB_CODES = new Set([
  '57014', // query_canceled: the statement timeout
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available: the lock timeout
  '53000', // insufficient_resources
  // 53100 disk_full is deliberately absent: a full disk does not clear by
  // waiting, so it is sent to the error, not called an overload.
  '53200', // out_of_memory
  '53300', // too_many_connections
  'PGRST000', // PostgREST could not connect to the database
  'PGRST001', // PostgREST connection error
  'PGRST002', // PostgREST could not load its schema cache
  'PGRST003', // PostgREST timed out waiting for a pool connection
])

function isKnownTransientDbCode(code: string | null | undefined): boolean {
  if (!code) return false
  // Class 08 is connection exceptions, every member of which is transient.
  return TRANSIENT_DB_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code)
}

/**
 * What an upstream said, as a person reads it: the messages of a Salesforce
 * error list ("Session expired or invalid."), or the text after the status.
 */
function upstreamSaid(error: string): string {
  const rest = error.replace(/^[^(]*\(\d{3}\):\s*/, '')
  try {
    const parsed: unknown = JSON.parse(rest)
    if (Array.isArray(parsed)) {
      const messages = parsed
        .map((e: unknown) => (e as { message?: unknown } | null)?.message)
        .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
      if (messages.length > 0) return stripUrlQueriesInText(messages.map((m) => (/[.!?]$/.test(m) ? m : `${m}.`)).join(' '))
    }
  } catch {
    // Not JSON: an HTML page or plain text, passed on as written.
  }
  return truncateErrorForAlert(rest)
}

/**
 * How a dead-letter alert names the period its loss count covers (#1944).
 *
 * The window counter rewrites its key with a fresh `windowMinutes` TTL on every
 * loss (durability.ts, #1881), so a burst of losses chains for longer than one
 * window: "in the last 30 minutes" overstates the span above a single loss. A
 * lone loss, though, really did just happen inside the window, so that case keeps
 * the precise period. One helper so every dead-letter renderer says it the same
 * way (L30).
 */
function deadLetterPeriod(n: number, windowMinutes: number): string {
  return n === 1 ? `in the last ${windowMinutes} minutes` : 'recently'
}

/**
 * A step after the lead was answered failed, so whatever it was writing (almost
 * always the Salesforce outcome) never landed. Plain copy (Dan, 2026-10-03): the
 * workflow, the time in ET, what the upstream said, one fix line, the run.
 */
async function sendLostWritebackAlert(
  connection: SlackConnection,
  payload: OutcomeDeadLetterAlert,
  run: NonNullable<OutcomeDeadLetterAlert['run']>,
  appUrl: string,
): Promise<boolean> {
  const isSalesforce = payload.error_message.startsWith('Salesforce')
  const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(run.at))
  const n = payload.window_loss_count
  // The window count is approximate (#1881): KV increments from isolates writing
  // at once can overwrite each other, so a count above one says "about".
  const affected = n === 1 ? '1 lead was affected' : `About ${n} leads were affected`
  const period = deadLetterPeriod(n, payload.window_minutes)
  const title = isSalesforce ? 'Salesforce update lost' : 'Update lost after a lead was answered'
  const summary = isSalesforce
    ? `${run.workflow_name} answered a lead at ${when} ET, but a Salesforce step after the answer failed, so Salesforce is missing that lead's outcome. ${affected} ${period}.`
    : `${run.workflow_name} answered a lead at ${when} ET, but a step after the answer failed, so its update never landed. ${affected} ${period}.`
  const said = `${isSalesforce ? 'Salesforce said' : 'The error was'}: ${upstreamSaid(payload.error_message)}`
  const fix = isSalesforce
    ? 'Fix: open the run below and enter the outcome in Salesforce by hand. Bidspoke will not retry it.'
    : 'Fix: open the run below and redo that step\'s update by hand. Bidspoke will not retry it.'
  const link = `<${appUrl}/workflows/${run.workflow_id}?execution=${run.execution_id}|${n === 1 ? 'View the run' : 'View the latest run'} →>`
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: title, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
    { type: 'section', text: { type: 'mrkdwn', text: said } },
    { type: 'section', text: { type: 'mrkdwn', text: fix } },
    { type: 'section', text: { type: 'mrkdwn', text: link } },
  ]
  return (await postMessage(connection.bot_token, connection.default_channel, blocks, `${title}: ${run.workflow_name}`)) !== null
}

/**
 * A Salesforce write after the answer failed and its request could not be kept
 * for a replay (#1993, #835): the step was not an update, or named no object,
 * record or body, or the replay store could not save it (#2084). Nothing will
 * resend it, so this never says
 * "failed after all retries", and it is a Salesforce outcome, not a billing
 * record. The failure itself is reported by the lost update alert; this says
 * only that the replay tool cannot resend it.
 */
async function sendUncapturableWritebackAlert(
  connection: SlackConnection,
  payload: OutcomeDeadLetterAlert,
  appUrl: string,
): Promise<boolean> {
  const run = payload.run
  const n = payload.window_loss_count
  const title = 'Salesforce update cannot be replayed'
  const who = run
    ? `${slackText(run.workflow_name)} answered a lead at ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(run.at))} ET, and a Salesforce step after the answer failed`
    : 'A Salesforce step after a lead was answered failed'
  const why = upstreamSaid(payload.error_message)
  const summary =
    `${who}. Its request could not be kept for a replay: ${/[.!?]$/.test(why) ? why : `${why}.`} ` +
    `This happened about ${n} ${n === 1 ? 'time' : 'times'} ${deadLetterPeriod(n, payload.window_minutes)}.`
  const fix = run
    ? 'Fix: open the run below and enter the outcome in Salesforce by hand. The replay tool cannot resend it.'
    : 'Fix: find the run on the dashboard and enter the outcome in Salesforce by hand. The replay tool cannot resend it.'
  const link = run
    ? `<${appUrl}/workflows/${run.workflow_id}?execution=${run.execution_id}|${n === 1 ? 'View the run' : 'View the latest run'} →>`
    : `<${appUrl}/dashboard|Open dashboard →>`
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: title, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
    { type: 'section', text: { type: 'mrkdwn', text: fix } },
    { type: 'section', text: { type: 'mrkdwn', text: link } },
  ]
  return (await postMessage(connection.bot_token, connection.default_channel, blocks, run ? `${title}: ${run.workflow_name}` : title)) !== null
}

/**
 * The held label without the record it was holding. The capture always sends the
 * record, so this is a defensive branch: the label alone still means unknown and
 * held, so it keeps that wording rather than falling into the generic "failed
 * after all retries" alert, which would claim a loss nobody measured (#2163).
 */
async function sendHeldWithoutRecordAlert(
  connection: SlackConnection,
  payload: OutcomeDeadLetterAlert,
  appUrl: string,
): Promise<boolean> {
  const n = payload.window_loss_count
  const title = 'Salesforce update not confirmed'
  const run = payload.run
  const summary = [
    'A Salesforce update after the answer was cut off before Salesforce replied, so it is not known whether it landed. This alert did not carry which record it was updating.',
    n > 1 ? `This happened about ${n} times recently.` : '',
  ].filter(Boolean).join(' ')
  const fix = run
    ? 'Fix: open the run below, find the Salesforce step that timed out, and check its record in Salesforce. If the update did not land, set it by hand.'
    : 'Fix: find the run on the dashboard, open the Salesforce step that timed out, and check its record in Salesforce. If the update did not land, set it by hand.'
  const link = run
    ? `<${appUrl}/workflows/${run.workflow_id}?execution=${run.execution_id}|View the run →>`
    : `<${appUrl}/dashboard|Open dashboard →>`
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: title, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
    { type: 'section', text: { type: 'mrkdwn', text: fix } },
    { type: 'section', text: { type: 'mrkdwn', text: link } },
  ]
  return (await postMessage(connection.bot_token, connection.default_channel, blocks, run ? `${title}: ${run.workflow_name}` : title)) !== null
}

/**
 * A Salesforce update after the answer was cut off before Salesforce replied (a
 * timeout, an abort, a dropped connection), and the at-risk record holds its
 * request in KV (#2163). So it is unknown, not lost and not unreplayable, and
 * until the read-back (#2023) ships nothing will look at it before KV deletes
 * it. The alert says that, names the record and the fields it was setting (never
 * the values, which are lead data, but it says the run shows them), and when the
 * request is deleted, in ET.
 *
 * The dead letter posts once per window, so the count says the record named is
 * the latest of several rather than claiming it is the only one.
 */
async function sendHeldWritebackAlert(
  connection: SlackConnection,
  payload: OutcomeDeadLetterAlert,
  run: NonNullable<OutcomeDeadLetterAlert['run']>,
  held: NonNullable<NonNullable<OutcomeDeadLetterAlert['run']>['held']>,
  appUrl: string,
): Promise<boolean> {
  const n = payload.window_loss_count
  const title = 'Salesforce update not confirmed'
  const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(run.at))
  const untilTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(held.until))
  const untilDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(new Date(held.until))
  const until = `${untilTime} ET on ${untilDay}`
  // Prospect__c reads as Prospect, the way the record is named in Salesforce's own pages.
  const object = slackText(held.sf_object.replace(/__c$/, '').replace(/_/g, ' '))
  const fields = held.fields.map(slackText)
  const setting = fields.length === 0 ? '' : `, setting ${listSteps(fields)}`
  // The failed step logs the request as its input (#2163), so the run is where
  // the values are; the values themselves stay out of Slack.
  const summary =
    `${slackText(run.workflow_name)} answered a lead at ${when} ET, and a Salesforce update after the answer was cut off before Salesforce replied, so it is not known whether it landed. ` +
    `It was updating ${object} ${slackText(held.sf_record_id)}${setting}. The run below shows the values it was sending.`
  const kept =
    `Bidspoke holds the request until ${until}. Nothing checks it before then, and it is deleted at that time.` +
    (n > 1 ? ` This happened about ${n} times ${deadLetterPeriod(n, payload.window_minutes)}, and this alert names the latest.` : '')
  const fix = `Fix: before ${until}, open that ${object} in Salesforce and check ${fields.length === 1 ? 'that field' : 'those fields'}. If the update did not land, set ${fields.length === 1 ? 'it' : 'them'} by hand.`
  const link = `<${appUrl}/workflows/${run.workflow_id}?execution=${run.execution_id}|${n === 1 ? 'View the run' : 'View the latest run'} →>`
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: title, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
    { type: 'section', text: { type: 'mrkdwn', text: kept } },
    { type: 'section', text: { type: 'mrkdwn', text: fix } },
    { type: 'section', text: { type: 'mrkdwn', text: link } },
  ]
  return (await postMessage(connection.bot_token, connection.default_channel, blocks, `${title}: ${run.workflow_name}`)) !== null
}

/**
 * Work after the answer still running when finalize stopped waiting for it
 * (#1860). Its outcome is unknown, not failed, so the alert says that and asks
 * for a check rather than a repair. It names the step the run was still on
 * (#1882): it used to point at the Salesforce update, which on 2026-10-08 had
 * finished 87 ms after the answer while the slow step was the Achieve call.
 */
async function sendUnfinishedWorkAlert(
  connection: SlackConnection,
  payload: OutcomeDeadLetterAlert,
  run: OutcomeDeadLetterAlert['run'],
  appUrl: string,
): Promise<boolean> {
  const n = payload.window_loss_count
  const title = 'Work after an answer did not finish in time'
  const who = run
    ? `${run.workflow_name} answered a lead at ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(run.at))} ET`
    : 'A workflow answered a lead'
  // A step's name carries its label, typed by whoever edits the canvas. Slack
  // reads <, > and & as markup, so they are escaped: a label cannot become a
  // channel mention or a link.
  const named = (run?.still_running ?? []).map(slackText)
  const one = named.length === 1
  const steps = named.length > 0 ? `${one ? 'the step' : 'the steps'} ${listSteps(named)}` : 'the steps after the answer'
  // Count-agnostic, like the other dead-letter renderers: the period comes from
  // the shared deadLetterPeriod helper (a lone loss keeps the precise window, a
  // chained burst reads "recently") and the count noun is pluralised, so the
  // sentence is grammatical for any n and says the period the same way the siblings
  // do (L30). What this renderer drops is the singular alternate wording ("This
  // happened once", "View the run"): one vocabulary regardless of count (#1944).
  const period = deadLetterPeriod(n, payload.window_minutes)
  const summary =
    `${who}, but ${steps} ${one ? 'was' : 'were'} still running when Bidspoke stopped waiting. ` +
    `${one ? 'It' : 'They'} may have finished, but nothing confirmed it. This happened about ${n} ${n === 1 ? 'time' : 'times'} ${period}.`
  const fix = named.length > 0
    ? `Fix: open the run below and check what ${listSteps(named)} did. If this keeps happening, ${one ? 'that step is' : 'those steps are'} running slowly.`
    : run
      ? 'Fix: open the run below and check what its last steps did. If this keeps happening, those steps are running slowly.'
      : 'Fix: open the recent runs on the dashboard and check what their last steps did. If this keeps happening, those steps are running slowly.'
  const link = run
    ? `<${appUrl}/workflows/${run.workflow_id}?execution=${run.execution_id}|View the latest run →>`
    : `<${appUrl}/dashboard|Open dashboard →>`
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: title, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
    { type: 'section', text: { type: 'mrkdwn', text: fix } },
    { type: 'section', text: { type: 'mrkdwn', text: link } },
  ]
  return (await postMessage(connection.bot_token, connection.default_channel, blocks, run ? `${title}: ${run.workflow_name}` : title)) !== null
}

/**
 * Alert that a must-not-lose outcome write was dead-lettered after its retries
 * were exhausted (or a tier-3 Salesforce writeback was given up on). The record
 * feeds billing / win-tracking / repeat-lead analytics. Most labels are NOT
 * auto-recovered, but the finalize losses self-heal through the strand drains
 * (execution_finalize and lead_sightings.finalize), so the alert reframes those
 * as a delay rather than a loss (#585, #1953). Caller has already fetched the
 * connection and checked config_alerts_enabled. Returns true when delivered. See #309.
 */
export async function sendOutcomeDeadLetterAlert(
  connection: SlackConnection,
  payload: OutcomeDeadLetterAlert,
  appUrl: string
): Promise<boolean> {
  if (payload.label === 'sf_writeback' && payload.run) return sendLostWritebackAlert(connection, payload, payload.run, appUrl)
  // Unknown and held, never lost or unreplayable (#2163).
  if (payload.label === WRITEBACK_HELD_LABEL) {
    if (payload.run?.held) return sendHeldWritebackAlert(connection, payload, payload.run, payload.run.held, appUrl)
    return sendHeldWithoutRecordAlert(connection, payload, appUrl)
  }
  // Always its own wording: an unfinished walk is never a lost record (#1860).
  if (payload.label === CONTINUATION_UNFINISHED_LABEL) return sendUnfinishedWorkAlert(connection, payload, payload.run, appUrl)
  // Never retried and never a billing record: the capture found nothing a replay
  // could resend, so it says that, in its own words (#835).
  // A held write the replay store could not save is the same fact as one it
  // could not capture: the replay tool has nothing to resend (#2084).
  if (payload.label === WRITEBACK_UNCAPTURABLE_LABEL || payload.label === WRITEBACK_STORE_LABEL) {
    return sendUncapturableWritebackAlert(connection, payload, appUrl)
  }
  const errText = truncateErrorForAlert(payload.error_message)
  // #585: an execution_finalize loss that isn't a missing row self-heals via the
  // stranded-execution drain. Reframe the whole alert (header + summary) so it
  // reads as a recoverable delay, not a permanent loss, matching the guidance.
  // The same self-heal predicates the guidance copy uses, so the header/summary
  // here cannot disagree with the "How to fix" line below (#585, #1953). A lost
  // bid row self-heals only when the sighting is also stranded, so it is not
  // reframed as a delay; its summary and guidance both state that condition.
  const execDrainRecoverable = execFinalizeSelfHeals(payload.label, payload.error_code)
  const sightingDrainRecoverable = sightingFinalizeSelfHeals(payload.label, payload.error_code)
  const bidDrainConditional = bidInsertConditionalRecovery(payload.label, payload.error_code)
  const n = payload.window_loss_count
  // Approximate above one (#1881): see sendLostWritebackAlert.
  const count = n === 1 ? '*1*' : `About *${n}*`
  const wasWere = n === 1 ? 'write was' : 'writes were'
  // #1944: a single loss really is within the window; a chained burst spans past
  // it, so above one loss the period reads "recently". One helper for the class.
  const period = deadLetterPeriod(n, payload.window_minutes)
  const how = payload.error_code === READ_BACK_MISSING_CODE
    ? 'timed out, and reading it back afterwards found it never landed'
    : 'failed after all retries'
  const summary = execDrainRecoverable
    ? `A finalize write (*${payload.label}*) ${how}, so ${n === 1 ? '*1*' : `about *${n}*`} execution ${n === 1 ? 'row is' : 'rows are'} stuck at status='running' ${period}. The records are intact and the stranded-execution drain recovers them automatically; this is informational unless it persists.`
    : sightingDrainRecoverable
    ? `A finalize write (*${payload.label}*) ${how}, so ${n === 1 ? '*1*' : `about *${n}*`} lead ${n === 1 ? 'sighting is' : 'sightings are'} stuck at outcome_state='in_flight' ${period}. The records are intact and the strand drain recovers them automatically within ${SIGHTING_STRAND_DRAIN_CADENCE_MINUTES} minutes; this is informational unless it persists.`
    : bidDrainConditional
    ? `A bid row (*${payload.label}*) ${how}. ${count} ${wasWere} affected ${period}. If the lead sighting is also stranded, the strand drain re-inserts this within ${SIGHTING_STRAND_DRAIN_CADENCE_MINUTES} minutes; if the sighting already finalized, the bid row is lost. Check the sighting before re-deriving.`
    : `A must-not-lose outcome write (*${payload.label}*) ${how}. ${count} ${wasWere} lost ${period}. These records feed billing, win-tracking, and repeat-lead analytics; they were not saved and are not auto-recovered.`
  const header = execDrainRecoverable ? 'Execution Finalize Delayed' : sightingDrainRecoverable ? 'Outcome Record Delayed' : 'Outcome Record Lost'
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: header, emoji: false },
    },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Error:* ${errText}` } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: outcomeDeadLetterGuidance(payload.label, payload.error_code, Boolean(payload.run)) },
    },
    // The run behind the latest loss when the caller has one (#835), which is
    // where the record has to be rebuilt from; the dashboard otherwise.
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: payload.run
          ? `<${appUrl}/workflows/${payload.run.workflow_id}?execution=${payload.run.execution_id}|${n === 1 ? 'View the run' : 'View the latest run'} →>`
          : `<${appUrl}/dashboard|Open dashboard →>`,
      },
    },
  ]

  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    execDrainRecoverable
      ? `Execution finalize delayed: ${payload.label}`
      : sightingDrainRecoverable
      ? `Outcome record delayed: ${payload.label}`
      : `Outcome record lost: ${payload.label}`
  )) !== null
}

export interface SlowdownSummaryAlert {
  /** Runs with at least one record in the slowdown. */
  runs: number
  /** Their workflows, with how many runs each, most first. */
  workflows: Array<{ name: string; runs: number }>
  /** Records read back, step row sets included. */
  records: number
  landed: number
  /** Outcome records that never landed. */
  lost: number
  /**
   * Records still unreadable when the summary went out, each already named by
   * the Records could not be confirmed alert (the database was still down).
   */
  unconfirmed?: number
  /** The runs those records belong to, and which records each lost. */
  lost_runs?: Array<{ workflow_id: string; workflow_name: string; execution_id: string; labels: string[] }>
  /** Runs whose step rows a read back found incomplete. */
  steps_missing: number
  /** First seen time of the earliest and latest timed out write, ISO. */
  from: string
  to: string
}

/**
 * One message per database slowdown (#1881). On 2026-10-08 a single stall posted
 * about 35 messages inside a minute, every one with the same cause. The minute
 * sweep sends this once it has read back everything the slowdown left: how many
 * runs, which workflows, and whether every record landed.
 */
export async function sendSlowdownSummaryAlert(
  connection: { bot_token: string; default_channel: string },
  payload: SlowdownSummaryAlert,
  appUrl: string,
): Promise<boolean> {
  const clock = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
  const from = clock(payload.from)
  const to = clock(payload.to)
  const when = from === to ? `At ${from} ET` : `Between ${from} and ${to} ET`
  const unconfirmed = payload.unconfirmed ?? 0
  const allLanded = payload.lost === 0 && payload.steps_missing === 0 && unconfirmed === 0
  const title = allLanded
    ? 'Database slowdown, every record saved'
    : payload.lost > 0 || payload.steps_missing > 0
      ? 'Database slowdown, some records not saved'
      : 'Database slowdown, some records not yet confirmed'
  const runs = payload.runs === 1 ? '1 run' : `${payload.runs} runs`
  const shown = payload.workflows.slice(0, 5)
  const others = payload.workflows.length - shown.length
  const workflows = shown.map((w) => `${slackText(w.name)} (${w.runs})`).join(', ') + (others > 0 ? ` and ${others} more` : '')
  const what =
    `${when} the database answered too slowly for ${runs} to confirm their records in time: ${workflows}. ` +
    'Every one of them had already answered its lead.'
  const result = allLanded
    ? `Bidspoke read every record back afterwards, and all ${payload.records} landed.`
    : [
        `Bidspoke read the records back afterwards: ${payload.landed} of ${payload.records} landed.`,
        payload.lost > 0 ? `${payload.lost} outcome ${payload.lost === 1 ? 'record' : 'records'} never did.` : '',
        unconfirmed > 0
          ? `${unconfirmed === 1 ? '1 record still could not be read back' : `${unconfirmed} records still could not be read back`}, and the Records could not be confirmed alert names ${unconfirmed === 1 ? 'it' : 'them'}.`
          : '',
        payload.steps_missing > 0 ? `${payload.steps_missing === 1 ? '1 run is' : `${payload.steps_missing} runs are`} missing some step records, so the step by step view of ${payload.steps_missing === 1 ? 'that run' : 'those runs'} is incomplete.` : '',
      ].filter(Boolean).join(' ')
  const fix = allLanded
    ? '*Fix:* Nothing to do. If this keeps happening, check the database load on Supabase.'
    : payload.lost > 0
      ? '*Fix:* Re-derive the lost records from the runs below. Missing step records cannot be recovered and need nothing.'
      : payload.steps_missing > 0
        ? '*Fix:* Nothing to redo. Missing step records cannot be recovered; the runs and their leads are otherwise complete.'
        : '*Fix:* Nothing to redo yet. Bidspoke keeps reading the unconfirmed records back and alerts on any it finds missing.'
  const lostRuns = payload.lost_runs ?? []
  const listed = lostRuns.slice(0, 10)
  const lostLinks =
    listed
      .map((r) => `<${appUrl}/workflows/${r.workflow_id}?execution=${r.execution_id}|${slackLinkLabel(r.workflow_name)} run> (${[...new Set(r.labels.map(recordNoun))].join(', ')})`)
      .join('\n') + (lostRuns.length > listed.length ? `\nand ${lostRuns.length - listed.length} more` : '')
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: title, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: `${what} ${result}` } },
    { type: 'section', text: { type: 'mrkdwn', text: fix } },
  ]
  if (listed.length > 0) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lostLinks } })
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `<${appUrl}/dashboard|Open dashboard →>` } })
  return (await postMessage(connection.bot_token, connection.default_channel, blocks, `${title}: ${runs}`)) !== null
}

export interface UnconfirmedWritesAlert {
  /** Records still unconfirmed in this alert. */
  count: number
  /** Their dead letter labels, e.g. 'lead_sightings.finalize'. */
  labels: string[]
  /** When the oldest of them timed out, ISO. */
  oldest_at: string
  /** How long the sweep has been trying to read them back, in whole minutes. */
  minutes: number
  /** The runs they belong to, distinct. */
  runs: Array<{ workflow_id: string; workflow_name: string; execution_id: string }>
}

/** A person edited name made safe inside mrkdwn text: `<` and `&` are markup there. */
function slackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * A person edited name made safe as the label of a Slack link: Slack's mrkdwn
 * reads `&`, `<` and `>` as markup and `|` as the end of the address, so a name
 * holding one breaks the link or injects markup.
 */
function slackLinkLabel(text: string): string {
  return slackText(text).replace(/\|/g, '/')
}

/** What a dead letter label wrote, as a reader names it. */
function recordNoun(label: string): string {
  if (label === 'execution_finalize') return 'run records'
  if (label.startsWith('lead_sightings.')) return 'lead sightings'
  if (label.startsWith('lead_sighting_bids.')) return 'bid rows'
  return label
}

/**
 * Records written after leads were answered timed out, and the database has
 * not answered the read back for 15 minutes (#1880). Their fate is unknown, so
 * this never says lost: the sweep keeps reading them back and the lost alert
 * follows for any it finds missing. Posted from whatever connection the caller
 * found, the last-good copy included, since the database is down.
 */
export async function sendUnconfirmedWritesAlert(
  connection: { bot_token: string; default_channel: string },
  payload: UnconfirmedWritesAlert,
  appUrl: string,
): Promise<boolean> {
  const title = 'Records could not be confirmed'
  const since = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(payload.oldest_at))
  const kinds = [...new Set(payload.labels.map(recordNoun))].join(', ')
  const n = payload.count
  const summary =
    `${n === 1 ? '1 record' : `${n} records`} written after leads were answered (${kinds}) timed out from ${since} ET. ` +
    `Bidspoke has tried to read them back for ${payload.minutes} minutes and the database still does not answer, so it cannot tell whether they were saved. ` +
    'This does not mean they were lost.'
  // Our own project's database, not Supabase's status page: the 2026-10-08 stall
  // was this database running out of memory (#835). And no alert title is named,
  // because a lost finalize record is reported as Delayed, not Lost.
  const fix =
    "*Fix:* Check the database's health and memory use in the Supabase dashboard for this project. Nothing needs redoing by hand yet: Bidspoke keeps reading these records back every minute and alerts on any it finds missing."
  const shown = payload.runs.slice(0, 10)
  const more = payload.runs.length > shown.length ? `\nand ${payload.runs.length - shown.length} more` : ''
  const runs = shown.map((r) => `<${appUrl}/workflows/${r.workflow_id}?execution=${r.execution_id}|${slackLinkLabel(r.workflow_name)} run>`).join('\n') + more
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: title, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
    { type: 'section', text: { type: 'mrkdwn', text: fix } },
  ]
  if (shown.length > 0) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: runs } })
  return (await postMessage(connection.bot_token, connection.default_channel, blocks, `${title}: ${n} unconfirmed`)) !== null
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
    { type: 'header', text: { type: 'plain_text', text: `Workflow Backup Failing${payload.repeat ? ' (still)' : ''}`, emoji: false } },
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
    ...(payload.repeat ? [{ type: 'section', text: { type: 'mrkdwn', text: payload.repeat } }] : []),
    { type: 'section', text: { type: 'mrkdwn', text: `<${appUrl}/workflows/${payload.workflow_id}|Open workflow →>` } },
  ]

  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `Workflow backup failing: ${payload.workflow_name}`
  )) !== null
}

// The strand job schedules the drain stall alert quotes, from a leaf module a web
// guard imports to tie them to the migrations (#835). Re-exported for callers here.
export { DRAIN_STALL_SCHEDULES }

/** "every hour at :27 and :57" for a minute list, or the daily time in words. */
function drainScheduleWords(cron: string, now: Date): string {
  const [minute, hour] = cron.trim().split(/\s+/)
  if (hour === '*' && /^\d+(,\d+)+$/.test(minute)) {
    const mins = minute.split(',').map((m) => `:${m.padStart(2, '0')}`)
    return `every hour at ${mins.slice(0, -1).join(', ')} and ${mins[mins.length - 1]}`
  }
  return scheduleInWords(cron, now) ?? `\`${cron}\``
}

/**
 * Alert that stranded lead sightings are not being finalized: in_flight
 * sightings older than 30 hours are piling up (#350).
 *
 * What the check measured is the count. What follows from it by construction:
 * finalize-unrecoverable-stranded finalizes every in_flight sighting older than
 * 26 hours, so a row past 30 hours means that pass did not run or did not
 * finish, and the export takes only finalized sightings, so the rows are held
 * back from Snowflake rather than exported wrong (#835). Causes are not listed:
 * none is measured here, and the failed run's own message names it.
 */
export async function sendDrainStallAlert(
  supabase: SupabaseClient,
  orgId: string,
  strandedCount: number,
  now: Date = new Date(),
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false
  const jobs = Object.keys(DRAIN_STALL_SCHEDULES) as (keyof typeof DRAIN_STALL_SCHEDULES)[]
  const when = (job: keyof typeof DRAIN_STALL_SCHEDULES) => drainScheduleWords(DRAIN_STALL_SCHEDULES[job], now)
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Lead sightings are not being finalized', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*${strandedCount.toLocaleString()}* lead sightings are still at \`outcome_state='in_flight'\` more than 30 hours after their run. ` +
          '`finalize-unrecoverable-stranded` finalizes every sighting older than 26 hours, so its last daily pass did not happen or did not finish. ' +
          'The Snowflake export takes only finalized sightings, so these leads are missing from reporting until they are finalized.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*How to fix:* in the Supabase SQL editor, read the latest run of each strand job: ' +
          `\`SELECT DISTINCT ON (j.jobname) j.jobname, d.status, d.return_message, d.start_time FROM cron.job j LEFT JOIN cron.job_run_details d USING (jobid) WHERE j.jobname IN (${jobs.map((j) => `'${j}'`).join(',')}) ORDER BY j.jobname, d.start_time DESC;\`. ` +
          'A failed run\'s return_message names the cause, and a job missing from the result is no longer scheduled. ' +
          'Then finalize the backlog by hand: `SELECT public.reduce_finalize_stranded(8); SELECT public.finalize_unrecoverable_stranded(26);`.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_Schedules: \`reduce-finalize-stranded\` ${when('reduce-finalize-stranded')}, \`reduce-finalize-stranded-deep\` ${when('reduce-finalize-stranded-deep')}, \`finalize-unrecoverable-stranded\` ${when('finalize-unrecoverable-stranded')}._`,
      },
    },
  ]
  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `Lead sightings not finalized: ${strandedCount.toLocaleString()} in_flight over 30h old`,
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

/**
 * One statement near its role's statement_timeout, as query-timeout-watch judges it (#1043).
 * Declared here as a minimal structural shape so slack.ts does not import the watch module
 * (which imports this one), and StatementVerdict satisfies it by structure.
 */
export interface QueryTimeoutOffender {
  role: string
  queryid: string | number
  calls: number
  meanMs: number
  maxMs: number
  timeoutMs: number
  meanPct: number
  maxPct: number
  severity: 'ok' | 'warn' | 'critical'
  querySample?: string
}

export async function sendQueryTimeoutAlert(
  supabase: SupabaseClient,
  orgId: string,
  offenders: QueryTimeoutOffender[],
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
  const anyCritical = offenders.some((o) => o.severity === 'critical')
  // The offenders are already sorted most severe first by judgeStatements. Each line names
  // the role whose ceiling it is judged against, the share of that ceiling, and the counts.
  // At most six, because a Slack section's text is capped at 3000 characters and more than
  // that would be rejected as invalid_blocks; the count line says how many were left off.
  const SHOWN = 6
  const list = offenders
    .slice(0, SHOWN)
    .map((o) => {
      const near = o.severity === 'critical'
        ? `its slowest run reached ${Math.round(o.maxPct * 100)}% of the ${secs(o.timeoutMs)} ceiling (${secs(o.maxMs)}), one slow run from being cancelled`
        : `it typically runs at ${Math.round(o.meanPct * 100)}% of the ${secs(o.timeoutMs)} ceiling (mean ${secs(o.meanMs)}, slowest ${secs(o.maxMs)})`
      // The sample is normalised SQL, so it carries `<`, `>` and `&`, which Slack reads as
      // markup even inside a code span; escape it as every other person- or data-sourced
      // string in this file is (L757). Cut to 120 characters BEFORE escaping, so the cut
      // cannot land inside an entity such as `&amp;` and leave a broken fragment. The id and
      // role are digits and a known role name.
      const sample = o.querySample ? `\n   \`${slackText(o.querySample.replace(/`/g, "'").slice(0, 120))}\`` : ''
      return `• \`${o.role}\` query ${o.queryid} over ${o.calls.toLocaleString()} calls: ${near}${sample}`
    })
    .join('\n')
  const more = offenders.length > SHOWN ? `\n(and ${offenders.length - SHOWN} more, see the log line event=query_timeout_watch)` : ''
  const intro = 'Postgres cancels a statement at its role\'s timeout (service_role 30s, the browser 8s) with no warning, which is how the archive cliff happened (#1040). These statements are close enough to warn now:\n'
  // Slack rejects a section over 3000 characters as invalid_blocks. The body is kept under it
  // by the SHOWN cap (6 lines) and the 120-character sample cap above, not by a cut here: a
  // whole-body slice could land inside a `&amp;` entity or a code span and drop the "and more"
  // line. Worst case here is about 6 * 300 + the intro, well under the limit.
  const body = intro + list + more
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: anyCritical ? 'A database query is close to being cancelled' : 'A database query is approaching its timeout',
        emoji: false,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: body },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*How to fix:* find the statement by its `queryid` in `pg_stat_statements` (the text is normalised, so look it up rather than searching for literals), then make it cheaper (an index, a narrower scan, a bounded page) or, if it is genuinely heavy, raise that path\'s budget. The slowest-run figure is cumulative since stats were last reset, so a fixed one-off spike clears only on a reset.',
      },
    },
  ]
  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `Query approaching its statement timeout: ${offenders.length} statement(s)`,
  )) !== null
}

export async function sendCronHeartbeatAlert(
  supabase: SupabaseClient,
  orgId: string,
  job: { label: string; triggerCron: string; dependents: string; completionDroughtMs?: number },
  status: 'stale' | 'never_ran' | 'vanished' | 'unstamped',
  ageMs: number | null,
  standing: StandingCondition | null = null,
  nowMs: number = Date.now(),
  // True only when the caller measured that the status is the one already
  // posted (#1768); the default never claims nothing changed.
  unchanged: boolean = false,
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false
  const hours = ageMs === null ? null : Math.round(ageMs / 3_600_000)
  const minutes = ageMs === null ? null : Math.round(ageMs / 60_000)
  // A reminder that reads as a fresh discovery is the whole complaint behind
  // #1334: three identical messages, each looking like a new incident. Every
  // shape below carries this sentence, and the header says "still" (#1334).
  const repeat = describeRepeat(standing, nowMs, unchanged)
  const again = repeat ? ' still' : ''
  // The reminder line goes before the schedule line, which stays last (#1300).
  const withRepeat = (blocks: object[]): object[] =>
    repeat ? [...blocks.slice(0, -1), { type: 'section', text: { type: 'mrkdwn', text: repeat } }, blocks[blocks.length - 1]] : blocks
  // What happened and what to do lead; the schedule string and how the check
  // saw it come last, in one line (#1300, Dan, 2026-09-10: "They're not easy to read").
  const words = scheduleInWords(job.triggerCron, new Date(nowMs))
  const schedule = words ? `${words} (\`${job.triggerCron}\`)` : `\`${job.triggerCron}\``
  const lastLine = (how: string) => ({ type: 'section', text: { type: 'mrkdwn', text: `_${how} Schedule: ${schedule}._` } })
  // A job that is demonstrably finishing runs while its heartbeat stamp is
  // missing is not dark, and telling anyone to go and check its cron triggers
  // sends them to confirm the one thing that is not wrong (#1332).
  if (status === 'unstamped') {
    const blocks = withRepeat([
      {
        type: 'header',
        text: { type: 'plain_text', text: `${job.label} is${again} missing its heartbeat`, emoji: false },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          // Says what was read and no more (#835): a finished row in job_runs is
          // not proof the schedule fires, since a run started by hand records one
          // too, and the heartbeat stamp is wired for every registered job by a
          // guard (cron-jobs-all-stamped), so a missing call is not the cause.
          text: `${job.label} has no current heartbeat stamp, but \`job_runs\` records it finishing a run within its usual interval. Until the stamp is written again, nothing warns if this job stops, and then: ${job.dependents}.`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*How to fix:* search the worker logs for \`[cron-heartbeat]\` around this job's scheduled times, where a failed stamp write is logged. If none failed, the finished runs may have been started by hand (the admin re-archive route records one), so check this job's scheduled trigger is still firing.`,
        },
      },
      lastLine('Seen because the heartbeat stamp is missing or late while `job_runs` shows a finished run.'),
    ])
    return (await postMessage(
      connection.bot_token,
      connection.default_channel,
      blocks,
      `${job.label} is missing its heartbeat`,
    )) !== null
  }
  // A run that started and never finished is a different failure from a
  // trigger that never fired, with a different place to look (#985), so it
  // gets its own header, sentence and remedy rather than the "is dark" ones.
  if (status === 'vanished') {
    const blocks = withRepeat([
      { type: 'header', text: { type: 'plain_text', text: `${job.label}${again} started and never finished`, emoji: false } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          // A minute job is judged on a drought of finished runs (#2057), so its
          // age is how long nothing has finished, not when one run started.
          text: job.completionDroughtMs
            ? `No run has finished in ~${minutes} minutes, while new runs keep starting. Until a run completes: ${job.dependents}.`
            : `A run started ~${minutes} minutes ago and has not finished. Until a run completes: ${job.dependents}.`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*How to fix:* nothing yet. The next scheduled run tries again on its own${words ? ` (${words})` : ''}, and this one may have completed part of its work before it stopped. If the next run stops too, read this run's own outcome, which Cloudflare records for each invocation alongside the wall time and CPU time it used: a run stopped for exceeding a resource limit needs its work bounded or split, one the platform simply cancelled was inside every limit and needs no change to anything here, and if its outcome is ok the run finished after this check looked, so nothing needs changing at all.`,
        },
      },
      lastLine(
        job.completionDroughtMs
          ? 'Seen because no run has stamped a completion for that long; why they stop is not visible from here.'
          : 'Seen because the run stamped its start and no completion inside its allowance; why it stopped is not visible from here.',
      ),
    ])
    return (await postMessage(
      connection.bot_token,
      connection.default_channel,
      blocks,
      `${job.label} started and never finished (vanished)`,
    )) !== null
  }
  const when =
    status === 'never_ran'
      ? `has not run since it was first observed${hours === null ? '' : ` ~${hours}h ago`}`
      : `has not run in ~${hours}h`
  const blocks = withRepeat([
    { type: 'header', text: { type: 'plain_text', text: `${job.label} is${again} dark`, emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${job.label} ${when}. While it is down: ${job.dependents}.`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*How to fix:* confirm the worker deployed with its scheduled triggers (wrangler.toml \`[triggers]\` must list this job's schedule, below) and that the scheduled handler is not throwing before it starts the job. The worker's triggers and its logs for this job's runs are in the Cloudflare dashboard.`,
      },
    },
    lastLine('Seen because the job has not stamped a run inside its expected cadence.'),
  ])
  return (await postMessage(
    connection.bot_token,
    connection.default_channel,
    blocks,
    `${job.label} is${again} dark (${status})`,
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

  // Typed on the vocabulary, not on `string`: a status added to the watcher with
  // no wording here would otherwise page with the generic headline below and a
  // remedy pointing at the wrong place, and nothing would say so (L113). That is
  // what happened to unknown_identity when it was added (#1152).
  const headers: Record<AlertingStatus, string> = {
    failing: `Database job ${verdict.jobname} is failing`,
    stalled: `Database job ${verdict.jobname} has stopped running`,
    never_succeeded: `Database job ${verdict.jobname} has never succeeded`,
    unknown_identity: `Cannot tell which database job ${verdict.jobname} is`,
    unknown_schedule: `Cannot tell whether database job ${verdict.jobname} is healthy`,
    unreadable_success: `Cannot tell when database job ${verdict.jobname} last succeeded`,
    inactive: `Database job ${verdict.jobname} is disabled`,
  }
  const fixes: Record<AlertingStatus, string> = {
    failing: `*How to fix:* read the error above. \`cron.job_run_details\` holds the full message and the run history for this job.`,
    // Only what stalled measured (#835): the job is in cron.job and enabled (or it
    // would not be judged, or would be reported as disabled), and its last success
    // is older than its schedule allows. Nothing about failures: the health read
    // sees them only inside a fixed window, and stalled is also reached after a
    // failure in that window that was reported and recovered. Its run history is
    // where the reader tells a stuck run, a failure and an idle scheduler apart.
    stalled: `*How to fix:* the job is scheduled and enabled but has not succeeded for longer than its schedule allows. Read its latest rows in \`cron.job_run_details\`: a row with no end_time is a stuck run, which cancelling its pid frees for the next slot; a failed row names its error; and no row since the last success means pg_cron is not launching it.`,
    never_succeeded: `*How to fix:* the job is scheduled and has not completed successfully in the window. Read its most recent run in \`cron.job_run_details\`.`,
    unknown_identity: `*How to fix:* \`pg_cron_health\` is not returning this job's \`jobid\`, so a job that was just rescheduled cannot be told apart from one that has never run. Apply the outstanding database migrations, since the worker is running ahead of them.`,
    unknown_schedule: `*How to fix:* the staleness half of this check is not running for this job. Either simplify the schedule or teach \`expectedGapMs\` to read this shape.`,
    unreadable_success: `*How to fix:* \`pg_cron_health\` returned a last success time the watcher cannot parse as a date. Compare what that function returns for this job with what \`judgeJob\` in pg-cron-watch.ts reads, and fix whichever side changed shape.`,
    inactive: `*How to fix:* re-enable it, or remove it, so a job nobody meant to keep is not left looking scheduled.`,
  }

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headers[verdict.status as AlertingStatus] ?? `Database job ${verdict.jobname} needs attention`, emoji: false },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`${verdict.jobname}\` (\`${schedule}\`): ${verdict.detail}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: fixes[verdict.status as AlertingStatus] ?? '*How to fix:* read this job in `cron.job_run_details`.' },
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
  config: { reason: string; files: string[]; rateLimited?: boolean } | null
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

/** The fix hints the verdicts present in this alert actually call for. */
const scheduleFixes = (verdicts: ScheduleVerdict[]): string[] => {
  const statuses = new Set(verdicts.map((v) => v.status))
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
  // A rate limit and a credential that cannot see are both unreadable, and need
  // opposite responses: one waits, one replaces the credential (#1365).
  const unreadable = verdicts.filter((v) => v.status === 'unreadable')
  if (unreadable.some((v) => v.rateLimited)) fixes.push(GITHUB_RATE_LIMIT_FIX)
  if (unreadable.some((v) => !v.rateLimited)) fixes.push(SCHEDULE_ACCESS_FIX)
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
    const since = problem.failingSince ? ` Failing since ${easternInstant(problem.failingSince)}.` : ''
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*\`${problem.file}\`:* ${problem.reason}.${since}` },
    })
  }

  const fixes: string[] = []
  if (problems.some((p) => p.rateLimited)) fixes.push(GITHUB_RATE_LIMIT_FIX)
  if (problems.some((p) => p.transient)) {
    // A 5xx or a dropped connection is GitHub's own service failing. It has
    // already failed twice in a row to get here (#1751), so it is not a blip,
    // but the token advice below would send the reader after a credential that
    // works.
    fixes.push(
      'A 5xx or a dropped connection means GitHub\'s own service failed, not our credential. Check ' +
        'https://www.githubstatus.com for an Actions or API incident. The worker keeps retrying every 15 minutes, ' +
        'so this clears on its own once GitHub recovers.',
    )
  }
  if (problems.some((p) => !p.rateLimited && !p.transient)) {
    fixes.push(
      'This is not a workflow that needs re-enabling in GitHub Actions. The dispatch itself is ' +
        'being refused, so read the reason above: a 401, or a 403 that is not a rate limit, means `GITHUB_ACTIONS_TOKEN` needs Actions read ' +
        'and write on this repository, a 422 means the workflow is missing its `driver` input, and a missing ' +
        'secret names itself.',
    )
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*How to fix:* ${fixes.join(' ')}` } })

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
    const fix = alert.config.rateLimited ? GITHUB_RATE_LIMIT_FIX : SCHEDULE_ACCESS_FIX
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*How to fix:* ${fix}` } })
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
    const fixes = scheduleFixes(alert.workflows.map((w) => w.verdict))
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*How to fix:* ${fixes.join(' ')}` } })
    summary = alert.workflows.map((w) => `${w.workflow.label}: ${w.verdict.status}`).join(', ')
  }

  return (await postMessage(connection.bot_token, connection.default_channel, blocks, summary)) !== null
}

/**
 * What to do about one failed matrix sync, read from the error the sync threw
 * (bid-matrix-sync.ts, salesforce-creds.ts, bid-range-flags.ts, paginate.ts).
 * An error none of these recognise is sent to its own text, never to a guess.
 */
function matrixSyncRemedy(error: string): string {
  if (/^Salesforce credentials missing/.test(error)) {
    return 'Set the Salesforce credentials the error names on the Environment Variables page.'
  }
  if (/^Salesforce |^the describe of /.test(error)) {
    return 'Salesforce refused or failed the call: read its answer in the error above, and check Salesforce is reachable if it is a 5xx or a timeout.'
  }
  if (/^bid_matrix_rows |^existing-row query |^partner_bid_config not found/.test(error)) {
    return "Our database read or write failed, not Salesforce: check the database's health in the Supabase dashboard, and the next hourly sync retries."
  }
  if (/sync_source is|has no sf_object configured/.test(error)) {
    return "The partner's matrix settings are incomplete: set its Salesforce object and source on the partner page."
  }
  return 'Read the error above to find which step failed.'
}

/**
 * Alert that the hourly bid-matrix sync had problems (#408): one or more partner
 * configs failed to sync (the matrix is going stale) and/or returned empty so the
 * last-known matrix was preserved instead of applied (#407). Aggregated per org;
 * uses the config-alerts toggle. Returns true when delivered. A manual "Sync now"
 * intentionally does not call this. The remedy follows each error (#835).
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
  // One remedy per kind of failure actually present, chosen from each error's own
  // wording (#835). It used to send every failure to Salesforce availability,
  // including a database write that failed and a credential nobody had set.
  const remedies = [...new Set([
    ...issue.failed.map((f) => matrixSyncRemedy(f.error)),
    ...(issue.preserved.length > 0
      ? ['For a preserved matrix, check that the partner flag filter (`Is{Partner}__c`) still matches rows in Salesforce, or confirm the ranges were cleared on purpose.']
      : []),
  ])]
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*How to fix:* ${remedies.join(' ')} Bidding keeps running on the last good matrix meanwhile.`,
    },
  })

  const channel = channelOverride || connection.default_channel
  const summary = `Bid matrix sync: ${issue.failed.length} failed, ${issue.preserved.length} preserved`
  return (await postMessage(connection.bot_token, channel, blocks, summary)) !== null
}

/**
 * A titled alert: the title, the findings, an optional context line and an
 * optional fix, nothing else (Dan, 2026-10-01). The failing since, intermittent
 * and reminder lines are kept, because they say whether this is a new incident.
 * Exported for the stored copy alert (#1848), which must post from the last-good
 * Slack connection while the database that holds the connection is down.
 */
export async function sendTitledAlert(
  connection: { bot_token: string; default_channel: string },
  channelOverride: string | null,
  payload: {
    title: string
    errors: string[]
    context?: string
    fixHint?: string
    failingSince?: string
    intermittentSince?: string
    repeat?: string
  },
): Promise<boolean> {
  const shown = payload.errors.slice(0, 20)
  const findings = shown.length === 1 ? shown[0] : shown.map((line) => `• ${line}`).join('\n')
  const title = payload.repeat ? `${payload.title} (still)` : payload.title
  const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } })
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: title, emoji: false } },
    section(payload.context ? `${findings}\n${payload.context}` : findings),
  ]
  if (payload.failingSince) blocks.push(section(`*Failing since:* ${easternInstant(payload.failingSince)}.`))
  else if (payload.intermittentSince) blocks.push(section(`*Last seen:* ${easternInstant(payload.intermittentSince)}, with clean runs since.`))
  if (payload.fixHint) blocks.push(section(`*Fix:* ${payload.fixHint}`))
  if (payload.repeat) blocks.push(section(payload.repeat))
  const channel = channelOverride || connection.default_channel
  return (await postMessage(connection.bot_token, channel, blocks, title)) !== null
}

const easternInstant = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso))

/**
 * What one export error means for the rows, read from the phase its line names
 * (`<phase>: <error>`, as sightings-export.ts and achieve-export.ts write them).
 *
 * The sentence used to be chosen by job name alone, so every error from an
 * export job read "the rows were not exported", including a sandbox purge (those
 * rows are never exported), an enrollment view backfill (the export is not held
 * up by it), and an exported_at stamp that matched nothing after the MERGE had
 * already landed the rows in Snowflake (#835).
 */
function exportErrorConsequence(jobName: string, error: string): string {
  const phase = /^([^:]+):/.exec(error)?.[1]?.trim().toLowerCase() ?? ''
  if (phase === 'sandbox purge') {
    return 'Sandbox rows are never exported, so nothing is missing from Snowflake; they stay in Supabase until a purge succeeds.'
  }
  if (phase === 'enrollment view backfill') {
    return 'This does not hold up the export: the rows still export, but without the Salesforce enrollment view filled in.'
  }
  if (phase === 'trades backfill') {
    return 'Rows still missing their trades were held back from this export, and wait for a run whose trades backfill succeeds.'
  }
  if (/\.exported_at \(/.test(error) && /matched zero rows/.test(error)) {
    return 'These rows are already in Snowflake but were not marked as exported, so each run sends them again and they are not purged until the mark lands.'
  }
  // A purge job's every error is a purge falling behind, whatever its line starts
  // with (an edge page reads "error code: 522", a database error its own prefix),
  // so the job name decides there; a purge phase inside an export job decides too.
  if (phase.endsWith('purge') || jobName.toLowerCase().includes('purge')) {
    return 'The affected rows are already exported to Snowflake, so analytics are fine; only the Supabase cleanup is behind, and it retries on the next run. Watch Supabase disk if this persists.'
  }
  return 'The affected rows were not exported and retry on the next run, so Snowflake is missing them until a run succeeds.'
}

/** Each distinct consequence once, in the order the errors first raise it. */
function exportConsequence(jobName: string, errors: string[]): string {
  return [...new Set(errors.map((e) => exportErrorConsequence(jobName, e)))].join(' ')
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
  payload: {
    jobName: string
    errors: string[]
    fixHint?: string
    consequence?: string
    failingSince?: string
    /**
     * The first failure of a stretch that a successful run has already
     * INTERRUPTED (#1441). Mutually exclusive with `failingSince`: one says the
     * job has been failing since then, the other says it failed then, recovered,
     * and has failed again, which is a different thing to go and look at.
     */
    intermittentSince?: string
    /**
     * Present only on a REMINDER, saying which one it is and how long the
     * condition has stood (#1334). Absent on a first report, so a message
     * carrying it is visibly the same incident as the one before rather than a
     * fresh discovery.
     */
    repeat?: string
    /** What the job DID, when "failed" is untrue (a check that ran and found something). */
    headlineVerb?: string
    /** What the listed items ARE, when "error" is untrue (a finding, a difference). */
    itemNoun?: { one: string; many: string }
    /** A plain header in place of the job name. With it the alert carries no framing sentence (TitledRemedy). */
    title?: string
    /** One line under the findings of a titled alert. */
    context?: string
  },
): Promise<boolean> {
  if (payload.errors.length === 0) return false
  // An error line is upstream text and can name an address with its query (L741, #1740).
  payload = { ...payload, errors: payload.errors.map(stripUrlQueriesInText) }
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection || !connection.config_alerts_enabled) return false
  if (payload.title) return sendTitledAlert(connection, channelOverride, payload as typeof payload & { title: string })

  const lines = payload.errors.slice(0, 20).map((line) => `• ${line}`).join('\n')
  // A failed purge means the rows are ALREADY in Snowflake and only the Supabase
  // cleanup is behind; claiming stale analytics for it is false-alarm copy
  // (2026-07-24). Only an export failure actually leaves analytics behind. A
  // caller that classified the errors may supply the sentence itself (#1180):
  // the killed-run takeover is neither a purge nor an export, and choosing by
  // job name told the reader rows were not exported for a job that exports
  // nothing.
  const consequence = payload.consequence ?? exportConsequence(payload.jobName, payload.errors)
  // A check that ran correctly and found something has not failed, and what it
  // found is not an error (2026-09-10). Both default to the failure wording, so
  // every existing caller is unchanged and only one that KNOWS better differs.
  const headlineVerb = payload.headlineVerb ?? 'failed'
  const noun = payload.errors.length === 1
    ? (payload.itemNoun?.one ?? 'error')
    : (payload.itemNoun?.many ?? 'errors')
  const again = payload.repeat ? ' still' : ''
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: `${payload.jobName}${again} ${headlineVerb}`, emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${payload.jobName}* reported ${payload.errors.length} ${noun}. ${consequence}\n${lines}`,
      },
    },
  ]
  if (payload.failingSince) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        // Present only when the transient grace held back an earlier failure
        // and NO run has succeeded since: this is the second consecutive failed
        // run, no longer a lone blip.
        text: `*Failing since:* ${easternInstant(payload.failingSince)}. This is the second consecutive failed run; the first was held back as a likely one-off blip.`,
      },
    })
  } else if (payload.intermittentSince) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        // The stretch ENDED and started again, so this may claim only that
        // (#1441). Saying "failing since" here named a day-long outage that had
        // in fact healed twice, across 22 successful runs.
        text: `*Intermittent:* this last happened on ${easternInstant(payload.intermittentSince)} and runs have succeeded since, so it is recurring rather than standing.`,
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
  if (payload.repeat) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: payload.repeat } })
  const channel = channelOverride || connection.default_channel
  return (await postMessage(connection.bot_token, channel, blocks, `${payload.jobName}${again} ${headlineVerb}: ${payload.errors.length} ${noun}`)) !== null
}

/**
 * Alert that secret env vars cannot be decrypted (#404). The env-loader never
 * passes ciphertext on, so a node loses the credential with no error until the
 * call fails. What it does instead depends on the kind, and the alert says so for
 * the kinds it lists, and only those (#1681): an org secret is left out of every
 * run (code, Webhook and Salesforce nodes then fall back to its Cloudflare copy,
 * if one exists), and a secret saved for one workflow is handed to that
 * workflow's runs empty, so the org value of the same key never stands in for it.
 * A workflow's own secret is named with its workflow, since the same key can be
 * the org's too. The cause is almost always a stored value encrypted under a
 * previous SECRET_ENCRYPTION_KEY (or predating encryption), so the fix is to
 * re-enter the value in the UI to re-encrypt it under the current key. Returns
 * true when delivered.
 */
export async function sendSecretDecryptAlert(
  connection: SlackConnection,
  secrets: { key: string; workflow: string | null }[],
  appUrl: string,
): Promise<boolean> {
  if (secrets.length === 0) return false
  const keys = secrets.map((s) => s.key)
  const lines = secrets.slice(0, 30).map((s) =>
    s.workflow === null
      ? `• \`${s.key}\``
      : `• \`${s.key}\`, saved for the workflow ${s.workflow}, whose runs get it empty`
  )
  const more = secrets.length > 30 ? `\n_and ${secrets.length - 30} more_` : ''
  const isOne = secrets.length === 1
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Secret cannot be decrypted', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${keys.length} secret${isOne ? '' : 's'} cannot be decrypted.*`,
          ...(secrets.some((s) => s.workflow === null)
            ? ['An organization secret is left out of every run. Code, Webhook and Salesforce nodes fall back to its Cloudflare copy if one exists; other nodes get no value.']
            : []),
          ...(secrets.some((s) => s.workflow !== null)
            ? ["A secret saved for one workflow is handed to that workflow's runs empty, so the organization's value of the same name is never sent in its place."]
            : []),
          `Nothing errors until a call that needs ${isOne ? 'it' : 'one'} fails:`,
        ].join(' '),
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
        text: `*How to fix:* set each from its source in a real terminal (a non-interactive shell uploads a blank value). Each takes effect as it is set:\n\`\`\`\n${fixCmds}\n\`\`\`\nSources for each secret are in docs/disaster-recovery.md (Secret inventory).`,
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
  payload: CircuitAlertPayload,
  /** Where the connection comes from; a caller on a lead's path passes one with a fallback (#1849). */
  resolveConnection: () => Promise<Pick<SlackConnection, 'bot_token' | 'default_channel'> | null> = () => getSlackConnection(supabase, orgId),
): Promise<void> {
  const connection = await resolveConnection()
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

/** One recovered subject: what paged, when, and where to look. */
export interface RecoveredSubject {
  subject: string
  alertedAt: string
  endedAt?: string | null
  url?: string
}

/** The rules every all-clear sentence follows, single or grouped. */
export interface RecoveryWording {
  signal: string
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
  /**
   * What the subject is said to be doing again, when "back within normal range"
   * would claim more than the check measured (#1336).
   *
   * The dead field tier stands an incident down on a single resolution, which
   * does not put its seven day rate back over the line, so the default sentence
   * would assert a recovery nobody observed (L11). Optional, and every check
   * that really does judge a range keeps the default unchanged.
   */
  recoveredPhrase?: string
}

/** The Slack link appended to a recovered subject, or nothing. */
function recoveryLink(item: RecoveredSubject): string {
  return item.url ? `  <${item.url}|open>` : ''
}

/** What one subject is now doing again, before any timing or link. */
function recoveredStatus(item: RecoveredSubject, wording: RecoveryWording): string {
  const recovered = wording.recoveredPhrase ?? 'is back within normal range'
  return `*${item.subject}* ${recovered}.`
}

/**
 * The timing clause: when the alert fired and how long it lasted.
 *
 * Depends only on the alert ticks and the wording, never on the subject, so a
 * group that all paged and cleared on the same tick shares one of these (#1270).
 */
function recoveryTiming(item: RecoveredSubject, wording: RecoveryWording, now: number): string {
  // The span itself comes from the one rule the dashboard's incident record also
  // reads (incident-span.ts, #2101): measured to the LAST OBSERVED FAILURE, not to
  // now (#814); the window in place of a span shorter than one window (#1101);
  // nothing at all for an unreadable marker (L11, L50).
  const span = measureIncidentSpan(item.alertedAt, item.endedAt, wording.measuredWindowMinutes, now)

  // Inside one window there is no observed END either (#1268): the last tick the
  // condition was seen on is the tick that paged, so "clearing at" would name
  // the moment the alert fired as the moment the outage ended. On 2026-09-10 that
  // told the reader a LendSwift outage cleared at 6:01 AM while the ping API
  // went on failing until 6:52. What the check DID observe is that the condition
  // had passed by the tick that announced this, so that is what it says.
  let howLong = '.'
  if (span.kind === 'within_window') {
    howLong =
      ` and covered the ${describeDuration(span.windowMs)} before it, which is as precisely as this check measures. ` +
      `It had passed by ${etTime(now)}.`
  } else if (span.kind === 'measured') {
    const lasted = describeDuration(span.ms)
    if (lasted) howLong = ` and lasted ${lasted}${span.clearedAt !== null ? `, clearing at ${etTime(span.clearedAt)}` : ''}.`
  }

  return `The ${wording.signal} alert fired at ${etTime(Date.parse(item.alertedAt))}${howLong}`
}

/**
 * The full sentence for ONE recovered subject: status, then timing, then link.
 *
 * One builder for the single and the grouped notice, so the two cannot describe
 * the same incident two different ways.
 */
function recoverySentence(item: RecoveredSubject, wording: RecoveryWording, now: number): string {
  return `${recoveredStatus(item, wording)} ${recoveryTiming(item, wording, now)}${recoveryLink(item)}`
}

/** Whether every subject paged and cleared on the same tick, so the timing is one sentence. */
function sameRecoveryTick(items: readonly RecoveredSubject[]): boolean {
  const first = items[0]
  return (
    Number.isFinite(Date.parse(first.alertedAt)) &&
    items.every((i) => i.alertedAt === first.alertedAt && (i.endedAt ?? null) === (first.endedAt ?? null))
  )
}

/**
 * Whether a read error names a database object that is missing or not permitted
 * (#835): a function or table PostgREST cannot find, an undefined function,
 * table or column, or a missing grant. Each answers the same way until a
 * migration or a grant changes it, so it never recovers by waiting. Read from the
 * rendered error text, because that is what the caller hands over.
 */
function missingDatabaseObject(error: string): boolean {
  return /\b(PGRST202|PGRST205|42883|42P01|42703|42501)\b|permission denied for/.test(error)
}

/**
 * Bidspoke cannot read its own database (#1297). Posted by the minute cliff
 * check from the last-good Slack connection in KV, because the token's home is
 * the database that cannot be read. Returns the message ts, or null when Slack
 * refused, so the caller can gate its cooldown on delivery.
 */
export async function sendDatabaseUnreachableAlert(
  slack: { bot_token: string },
  channel: string,
  payload: { what: string; error: string; appUrl: string; repeat?: string },
): Promise<string | null> {
  // A Cloudflare error page in place of the answer (#2058, #2117) means the
  // worker could not reach the database through Cloudflare, which is all that
  // was measured: on 2026-10-14 the reads got `error code: 1016` while Supabase
  // served no errors. So it gets its own title, quote and fix (L11).
  const edgeCode = cloudflareEdgeCodeIn(payload.error)
  if (edgeCode !== null) return sendDatabaseUnreachableThroughCloudflare(slack, channel, payload, edgeCode)
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Bidspoke cannot read its database${payload.repeat ? ' (still)' : ''}`, emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          // No claim about leads (#835): since the stored copies (#1845) a live run
          // can still be served from them, so "leads are refused with 503" is no
          // longer what happens. What this check knows is that it cannot count.
          `<!here> The minute volume check could not read *${payload.what}* from Supabase: \`${truncateErrorForAlert(payload.error)}\`. ` +
          'While this lasts it cannot count executions, so it cannot see a drop in volume. ' +
          'The volume cliff alerts will only fire once the database is readable again, and they will then report the outage as a caller stopping, which it is not.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: missingDatabaseObject(payload.error)
          // A missing function, table or grant answers the same way every minute.
          ? '*How to fix:* the database answered, but what this check reads is missing or not permitted, and that does not clear up on its own. Apply the outstanding database migrations, or restore the grant the error names. An all-clear follows here once this check can read again.'
          : '*How to fix:* check <https://status.supabase.com|status.supabase.com> and the database\'s health and memory use in the Supabase dashboard for this project. Nothing on the worker needs restarting; it recovers on its own when the database answers. An all-clear follows here once this check can read again.',
      },
    },
    ...(payload.repeat ? [{ type: 'section', text: { type: 'mrkdwn', text: payload.repeat } }] : []),
    { type: 'section', text: { type: 'mrkdwn', text: `<${payload.appUrl}/dashboard|Open dashboard>` } },
  ]
  return postMessage(slack.bot_token, channel, blocks, 'Bidspoke cannot read its database')
}

/** The same alert when the read got a Cloudflare error page instead of an answer. */
function sendDatabaseUnreachableThroughCloudflare(
  slack: { bot_token: string },
  channel: string,
  payload: { what: string; appUrl: string; repeat?: string },
  code: number,
): Promise<string | null> {
  const title = 'Bidspoke cannot reach its database through Cloudflare'
  const meaning = code === 1016 ? ' Code 1016 means Cloudflare could not look up the database\'s address.' : ''
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${title}${payload.repeat ? ' (still)' : ''}`, emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `<!here> The minute volume check could not read *${payload.what}*. Cloudflare answered in place of the database, with \`error code: ${code}\`.${meaning} ` +
          'That answer comes from Cloudflare, so it does not show that the database itself is down. ' +
          'While this lasts the check cannot count executions, so it cannot see a drop in volume. ' +
          'The volume cliff alerts will only fire once the database is readable again, and they will then report the outage as a caller stopping, which it is not.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*How to fix:* check <https://www.cloudflarestatus.com|cloudflarestatus.com> for an incident affecting Workers. Nothing on the worker or the database needs changing; this check recovers on its own when Cloudflare reaches the database again. An all-clear follows here once it can read again.',
      },
    },
    ...(payload.repeat ? [{ type: 'section', text: { type: 'mrkdwn', text: payload.repeat } }] : []),
    { type: 'section', text: { type: 'mrkdwn', text: `<${payload.appUrl}/dashboard|Open dashboard>` } },
  ]
  return postMessage(slack.bot_token, channel, blocks, title)
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
  payload: RecoveredSubject & RecoveryWording,
  now: number = Date.now(),
): Promise<boolean> {
  const { url, ...item } = payload
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Recovered', emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: recoverySentence(item, payload, now) } },
  ]
  if (url) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `<${url}|Open workflow >` } })
  }

  return (await postMessage(slack.bot_token, channel, blocks, `Recovered: ${payload.subject}`)) !== null
}

/**
 * One all-clear covering every subject that recovered on the same tick (#1267).
 *
 * The field presence page is one message per channel (#1120), and its all-clear
 * was still one per field, so an outage that emptied four sibling fields at
 * once was announced over in four near-identical messages. This is the page's
 * mirror: one message, one line per subject, the same sentence rules as the
 * single notice. Returns whether it delivered, so the caller settles every
 * incident in the group or none of them.
 */
export async function sendGroupedRecoveryAlert(
  slack: { bot_token: string },
  channel: string,
  payload: RecoveryWording & { items: RecoveredSubject[] },
  now: number = Date.now(),
): Promise<boolean> {
  // When every subject paged and cleared on the same tick the timing sentence is
  // identical on each line, so it is said once below the subject list rather than
  // repeated per subject (#1270). The subjects themselves still differ, so each
  // keeps its own status line. A group whose ticks differ keeps the full
  // per-subject sentence, since the timing is then a real difference.
  let text: string
  if (payload.items.length > 1 && sameRecoveryTick(payload.items)) {
    const statusLines = payload.items.map((item) => `${recoveredStatus(item, payload)}${recoveryLink(item)}`)
    const timing = recoveryTiming(payload.items[0], payload, now)
    // Reserve the timing clause (plus its blank-line separator) from the section
    // budget so the subject list plus the timing stays under Slack's 3,000 char
    // block limit, not just the list on its own.
    const subjects = listWithOverflow(statusLines, payload.items.length, MAX_LISTED_LINES, timing.length + 2)
    text = `${subjects}\n\n${timing}`
  } else {
    const lines = payload.items.map((item) => recoverySentence(item, payload, now))
    text = listWithOverflow(lines, payload.items.length)
  }
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Recovered', emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text } },
  ]
  const fallback = `Recovered: ${payload.items.map((i) => i.subject).join(', ')}`
  return (await postMessage(slack.bot_token, channel, blocks, fallback)) !== null
}

/** What the heartbeat's all-clear calls its signal; the incident record's label is the same words (#2103). */
export const CRON_HEARTBEAT_RECOVERY_WORDS = 'scheduled job'

/**
 * The all-clear for a scheduled job the heartbeat check paged as "started and
 * never finished" once a run of it has finished (#2057). On 2026-10-14 the run
 * had only finished late, and the page was left standing as an accusation. One
 * line, through the shared recovery sentence. Returns whether it reached Slack,
 * so the caller stands the incident down only on a real delivery.
 */
export async function sendCronHeartbeatRecoveryAlert(
  supabase: SupabaseClient,
  orgId: string,
  recovery: { label: string; status: 'vanished'; alertedAt: string; endedAt: string | null; sameRun: boolean },
  now: number = Date.now(),
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false
  return sendRecoveryAlert(
    connection,
    connection.default_channel,
    {
      signal: CRON_HEARTBEAT_RECOVERY_WORDS,
      subject: recovery.label,
      // Only what the completion shows: the reported run itself, late, or a later one.
      recoveredPhrase: recovery.sameRun
        ? 'finished the run reported as never finished, late'
        : 'has finished a run since, so it is running again',
      alertedAt: recovery.alertedAt,
      endedAt: recovery.endedAt,
    },
    now,
  )
}

/**
 * All-clear for a DATABASE scheduled job the pg_cron watch had paged (#851, #770).
 *
 * The watch paged when a job started failing, stalling or never succeeding and
 * then said nothing when it came back, so a quiet channel meant both "somebody
 * fixed it" and "the cooldown is still holding" (L98). This is the recovery line:
 * one sentence, the plain job name, and how long it was unhealthy. It delegates
 * to the shared recovery sentence so an all-clear here cannot describe an incident
 * differently from any other check's. Returns whether it reached Slack, so the
 * caller only stands the incident down on a real delivery.
 */
export async function sendPgCronRecoveryAlert(
  supabase: SupabaseClient,
  orgId: string,
  recovery: { jobname: string; alertedAt: string; endedAt: string | null },
  now: number = Date.now(),
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false
  return sendRecoveryAlert(
    connection,
    connection.default_channel,
    {
      signal: 'database job',
      subject: recovery.jobname,
      recoveredPhrase: 'is running and succeeding again',
      alertedAt: recovery.alertedAt,
      endedAt: recovery.endedAt,
    },
    now,
  )
}

/**
 * All-clear for a scheduled GitHub workflow the schedule watch had paged (#851,
 * #805). The same shape as the pg_cron one: the plain workflow label, the shared
 * recovery sentence, one message per org. Returns whether it reached Slack.
 */
export async function sendWorkflowScheduleRecoveryAlert(
  supabase: SupabaseClient,
  orgId: string,
  recovery: { label: string; alertedAt: string; endedAt: string | null },
  now: number = Date.now(),
): Promise<boolean> {
  const connection = await getSlackConnection(supabase, orgId)
  if (!connection) return false
  return sendRecoveryAlert(
    connection,
    connection.default_channel,
    {
      signal: 'scheduled workflow',
      subject: recovery.label,
      recoveredPhrase: 'is running on schedule again',
      alertedAt: recovery.alertedAt,
      endedAt: recovery.endedAt,
    },
    now,
  )
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

// ── Click sold buyer pages and the over cap notice (#1542) ───────────────────

/** Composed by lib/buyer-click-alert.ts, which owns the wording; this only lays it out. */
export interface BuyerClickAlertMessage {
  header: string
  body: string
  link: string | null
}

export async function sendBuyerClickAlert(
  slack: { bot_token: string },
  channel: string,
  message: BuyerClickAlertMessage,
): Promise<string | null> {
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: message.header, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: message.body } },
  ]
  if (message.link) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `<${message.link}|Open the executions>` } })
  return postMessage(slack.bot_token, channel, blocks, message.header)
}

// ── Partner firewall block page (#1265) ──────────────────────────────────────

export interface PartnerBlockAlertPayload {
  host: string
  status: number
  vendor: 'cloudflare' | 'unknown'
  bodyRayId: string | null
  edgeRayId: string | null
  markers: string[]
  seenIn: string
  /** Absent when the sighting came from the scheduled reachability probe (#1274), which runs no workflow. */
  workflowId?: string
  workflowName?: string | null
  traceId?: string
  appUrl: string
  /** describeRepeat's sentence while the block stands, null on the first post. */
  repeat: string | null
  /** The partner's other hosts with a standing block, so one incident reads as one story. */
  alsoBlocked: string[]
  /** The host is one of our own proxy workers, so the edge in front of it is ours. */
  ownProxy: boolean
  at: number
}

/**
 * The header and the how-to say only what the detector measured (#1265): a Cloudflare block
 * or challenge page names Cloudflare and tells the reader what to ask the partner for; an
 * HTML 403 with none of those markers is reported as exactly that, with no firewall wording,
 * because the check did not measure a firewall.
 */
export async function sendPartnerBlockAlert(
  slack: { bot_token: string },
  channel: string,
  payload: PartnerBlockAlertPayload,
): Promise<string | null> {
  const where = payload.ownProxy ? `our own proxy \`${payload.host}\`` : `\`${payload.host}\``
  const header = payload.vendor === 'cloudflare'
    ? `Cloudflare is blocking Bidspoke's calls to ${payload.host}`
    : `${payload.host} answered ${payload.status} with an HTML page instead of data`
  // The probe has no workflow: its sentence names the probe and the message carries no
  // execution link, because there is no execution to open (#1274).
  const fromProbe = payload.workflowId === undefined
  const workflow = payload.workflowName ? `${payload.workflowName} (${(payload.workflowId ?? '').slice(0, 8)})` : (payload.workflowId ?? '')
  const who = fromProbe ? 'The scheduled reachability probe\'s GET' : `A call from ${workflow}, step \`${payload.seenIn}\`,`
  const what = payload.vendor === 'cloudflare'
    ? `${who} to ${where} came back as HTTP ${payload.status} with a Cloudflare block page (${payload.markers.join(', ')}) instead of the partner's answer. Every request to that host is failing the same way while this lasts.`
    : `${who} to ${where} came back as HTTP ${payload.status} with an HTML page where JSON was expected. The page carries none of the markers a Cloudflare block or challenge page has, so what is refusing it was not measured.`
  const ids = [
    payload.bodyRayId ? `Ray ID on the page (the one their firewall log holds): \`${payload.bodyRayId}\`` : null,
    payload.edgeRayId ? `Ray ID of the edge in front of the host${payload.ownProxy ? ', which is ours' : ''}: \`${payload.edgeRayId}\`` : null,
  ].filter((s): s is string => s !== null)
  const lines: string[] = [what]
  if (ids.length > 0) lines.push(ids.join('\n'))
  if (payload.alsoBlocked.length > 0) lines.push(`Also standing blocked for the same partner: ${payload.alsoBlocked.map((h) => `\`${h}\``).join(', ')}.`)
  if (payload.repeat) lines.push(payload.repeat)
  lines.push(`Seen at ${etTime(payload.at)}.`)

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n\n') } },
  ]
  if (payload.vendor === 'cloudflare' && !payload.ownProxy) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*How to fix:* quote the Ray ID on the page to the partner. Our calls leave from Cloudflare\'s shared Workers address and from several locations, so ask for an allowlist keyed on our identifying request headers rather than on an address (see achieve-identity.ts for the Achieve precedent). Nothing on our side needs restarting; leads keep flowing to every other partner.',
      },
    })
  }
  if (!fromProbe) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `<${payload.appUrl}/workflows/${payload.workflowId}/executions?trace=${encodeURIComponent(payload.traceId ?? '')}|Open the execution>` } })
  }
  return postMessage(slack.bot_token, channel, blocks, header)
}

export interface PartnerUnreachableAlertPayload {
  host: string
  /** The failure text or code from the probe's last look. */
  reason: string
  /** ISO time the host was first seen not answering in this incident. */
  since: string
  repeat: string | null
  at: number
}

/**
 * A partner host that has not answered the reachability probe for its whole window (#1274).
 * Deliberately not called a block: the probe measured silence, not a refusal, and a
 * network level block looks exactly like a partner that is down.
 */
export async function sendPartnerUnreachableAlert(
  slack: { bot_token: string },
  channel: string,
  payload: PartnerUnreachableAlertPayload,
): Promise<string | null> {
  const header = `${payload.host} is not answering Bidspoke's calls`
  const lines = [
    `The scheduled reachability probe has had no answer from \`${payload.host}\` since ${etTime(Date.parse(payload.since))}. The last look failed with: \`${stripUrlQueriesInText(payload.reason)}\`. Leads that call this host are failing the same way while this lasts.`,
  ]
  if (payload.repeat) lines.push(payload.repeat)
  lines.push(`Seen at ${etTime(payload.at)}.`)
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n\n') } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*How to fix:* check the partner\'s status page first. If the partner is up for everyone else, this is the shape of a block at the network level rather than a page, so ask them whether Cloudflare\'s shared Workers address is being dropped. An all-clear follows here once the host has answered for 30 minutes.',
      },
    },
  ]
  return postMessage(slack.bot_token, channel, blocks, header)
}

export interface ProbeControlAlertPayload {
  host: string
  /** Whether the control has ever read blocked since deploy. Changes the remedy entirely. */
  everPassed: boolean
  status: number | null
  bodyHead: string
  since: string
  repeat: string | null
  at: number
}

/**
 * The reachability probe's positive control is not reading as a block (#1274). Two
 * wordings and two remedies: a control that has NEVER passed since deploy means the rule
 * was never created, and one that passed and then stopped means the rule was removed or
 * the block page changed under the detector (L11, L622).
 */
export async function sendProbeControlAlert(
  slack: { bot_token: string },
  channel: string,
  payload: ProbeControlAlertPayload,
): Promise<string | null> {
  const measured = `It answered ${payload.status === null ? 'nothing' : `HTTP ${payload.status}`} with: \`${stripUrlQueriesInText(payload.bodyHead).slice(0, 120) || '(empty)'}\`.`
  const header = payload.everPassed
    ? 'The block detector stopped seeing the block it should see'
    : 'The block detector has never seen the block it should see'
  const what = payload.everPassed
    ? `\`${payload.host}\` is deliberately blocked by a firewall rule on our own zone so that every probe run proves the detector can recognise a block. It stopped reading as blocked at ${etTime(Date.parse(payload.since))}. ${measured}`
    : `\`${payload.host}\` is meant to be blocked by a firewall rule on our own zone so that every probe run proves the detector can recognise a block. It has never once read as blocked since this deploy. ${measured}`
  const fix = payload.everPassed
    ? '*How to fix:* two causes, check in this order. The WAF custom rule on trypennie.dev blocking `http.host eq "block-probe.trypennie.dev"` was removed or disabled: open the Cloudflare dashboard, Security, WAF, Custom rules, and confirm it is there and enabled. Or Cloudflare changed the block page and the detector\'s markers no longer match: open the host in a browser and compare what it shows with the markers in html-error-summary.ts.'
    : '*How to fix:* create the rule. In the Cloudflare dashboard for trypennie.dev, open Security, WAF, Custom rules, add a rule with the expression `http.host eq "block-probe.trypennie.dev"` and the action Block, then open the host in a browser: it should show the "Sorry, you have been blocked" page. Until it does, the detector\'s ability to see a block is unproven.'
  const lines = [what]
  if (payload.repeat) lines.push(payload.repeat)
  lines.push(`Seen at ${etTime(payload.at)}.`)
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n\n') } },
    { type: 'section', text: { type: 'mrkdwn', text: fix } },
  ]
  return postMessage(slack.bot_token, channel, blocks, header)
}

export interface ProbeBrokenAlertPayload {
  reason: string
  since: string
  repeat: string | null
  at: number
}

/**
 * The reachability probe cannot fetch anything, its own control included (#1274). Posted
 * INSTEAD of one outage per partner, because a reading that says everything is dead is
 * first evidence about the measurement (L438).
 */
export async function sendProbeBrokenAlert(
  slack: { bot_token: string },
  channel: string,
  payload: ProbeBrokenAlertPayload,
): Promise<string | null> {
  const header = 'The partner reachability probe cannot fetch'
  const lines = [
    `Since ${etTime(Date.parse(payload.since))} the probe's own control host has not answered at all, so nothing it reports about the partners can be trusted and their readings are being held. The last look failed with: \`${stripUrlQueriesInText(payload.reason)}\`.`,
  ]
  if (payload.repeat) lines.push(payload.repeat)
  lines.push(`Seen at ${etTime(payload.at)}.`)
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n\n') } },
    { type: 'section', text: { type: 'mrkdwn', text: '*How to fix:* open the worker\'s logs and search for `event=partner_probe`. If every host reads unreachable with the same error, the worker\'s outbound fetch is failing: check Cloudflare\'s status page and the worker\'s subrequest usage. Leads are unaffected unless they fail too, which the failure alerts report separately.' } },
  ]
  return postMessage(slack.bot_token, channel, blocks, header)
}

/** Bytes in the units Supabase sizes compute in: decimal, so 4 GB of compute reads 4.0 GB. */
function decimalSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

export interface DatabaseMemoryShortPayload {
  totalBytes: number
  /** The share of memory under which a reading counts as thin, as the check judged it. */
  freeFloor: number
  /** The lowest available figure seen over the thin stretch. */
  lowestAvailableBytes: number
  /** Whether a reading in the stretch found less than the floor free. */
  lowFree: boolean
  /** Whether a reading in the stretch found swap in use above the concern level. */
  swapping: boolean
  /** Swap in use at the latest reading. */
  swapUsedBytes: number
  /** The swap level above which the check pages, as the check judged it. */
  swapConcernBytes: number
  since: string
  repeat: string | null
  at: number
}

/**
 * The database has been short of memory for 15 minutes (#1928). The swap sentence is
 * there only when swapping was seen, and the floor sentence only when free memory went
 * under it, so the message never claims a sign the readings did not show (L11).
 *
 * Two shapes, because they call for different actions. When free memory actually went
 * under the floor, that is the exhaustion that stalled on Oct 8, and the fix is a
 * resize. When only swap is high while free memory stayed healthy, it is an EARLY
 * WARNING that the working set is outgrowing memory: nothing is failing yet, so the
 * alert says so and frames the remedy as investigate-then-resize-if-it-persists rather
 * than resize now. The swap level that pages is near the Oct 8 shape (#1928 follow-up,
 * Dan 2026-10-12), so benign overnight swapping never reaches this copy.
 */
export async function sendDatabaseMemoryShortAlert(
  slack: { bot_token: string },
  channel: string,
  payload: DatabaseMemoryShortPayload,
): Promise<string | null> {
  const share = Math.round((payload.lowestAvailableBytes / payload.totalBytes) * 100)
  const floor = Math.round(payload.freeFloor * 100)
  const swapHere = `memory moving to disk, with ${decimalSize(payload.swapUsedBytes)} there now`
  // Swapping alone, with free memory never under the floor: not yet exhaustion.
  const swappingOnly = payload.swapping && !payload.lowFree

  const header = swappingOnly ? 'The database moved memory to disk' : 'The database is short of memory'
  const lines: string[] = []
  if (swappingOnly) {
    lines.push(
      `Since ${etTime(Date.parse(payload.since))} readings have found ${swapHere}. The database should keep swap under ${decimalSize(payload.swapConcernBytes)}, and it has climbed past that line. ` +
        `Free memory is still healthy: the least free was ${decimalSize(payload.lowestAvailableBytes)}, ` +
        `${share} percent of its ${decimalSize(payload.totalBytes)}, and no reading went under the ${floor} percent floor. ` +
        'So nothing is failing yet, but this is the shape that preceded the Oct 8 stall, where free memory itself ran out.',
    )
  } else {
    const signs: string[] = []
    if (payload.lowFree) signs.push(`less than ${floor} percent of its memory free`)
    if (payload.swapping) signs.push(swapHere)
    lines.push(
      `Since ${etTime(Date.parse(payload.since))} every reading that could be taken has found the database short of memory. Over that stretch, readings found ${signs.join(', and ')}. ` +
        `The least free was ${decimalSize(payload.lowestAvailableBytes)}, ${share} percent of its ${decimalSize(payload.totalBytes)}. ` +
        'When it runs out entirely every query slows at once, which is how the stall of Oct 8 began.',
    )
  }
  if (payload.repeat) lines.push(payload.repeat)
  lines.push(`Seen at ${etTime(payload.at)}.`)

  const fix = swappingOnly
    ? `*What to do:* this is an early warning, not the Oct 8 stall: free memory has not run out. Find what is holding memory: the scheduled stats refreshes inside the database (#1884), or a large query. If the swap keeps climbing toward the Oct 8 shape, or free memory starts dropping, move the database to the next compute size up in Supabase, under Project Settings, Compute and Disk. An all-clear follows here once memory has stayed clear for ${RECOVERY_REARM_MINUTES} minutes.`
    : `*How to fix:* move the database to the next compute size up in Supabase, under Project Settings, Compute and Disk. The change restarts the database for a minute or two, so pick a quiet hour. If the size was raised recently, find what is using the memory instead: the scheduled stats refreshes inside the database are the known heavy readers (#1884). An all-clear follows here once memory has stayed clear for ${RECOVERY_REARM_MINUTES} minutes.`

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n\n') } },
    { type: 'section', text: { type: 'mrkdwn', text: fix } },
  ]
  return postMessage(slack.bot_token, channel, blocks, header)
}

export interface DatabaseMemoryUnreadablePayload {
  reason: string
  since: string
  repeat: string | null
  at: number
}

/** The memory check has not been able to read Supabase's metrics feed for 30 minutes (#1928). */
export async function sendDatabaseMemoryUnreadableAlert(
  slack: { bot_token: string },
  channel: string,
  payload: DatabaseMemoryUnreadablePayload,
): Promise<string | null> {
  const header = "Bidspoke cannot read the database's memory"
  const lines = [
    `Since ${etTime(Date.parse(payload.since))} the memory check has not been able to read Supabase's metrics feed, so the database running low on memory would go unreported. The last attempt failed with: \`${stripUrlQueriesInText(truncateErrorForAlert(payload.reason))}\`.`,
  ]
  if (payload.repeat) lines.push(payload.repeat)
  lines.push(`Seen at ${etTime(payload.at)}.`)
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: header, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n\n') } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*How to fix:* search the worker's logs for \`event=database_memory\`. HTTP 401 or 403 means the worker's Supabase secret key no longer opens the feed: check it in Supabase under Project Settings, API Keys. A timeout or HTTP 5xx is usually Supabase itself, so check <https://status.supabase.com|status.supabase.com>. Leads are not affected by this check failing. An all-clear follows here once readings have worked for ${RECOVERY_REARM_MINUTES} minutes.`,
      },
    },
  ]
  return postMessage(slack.bot_token, channel, blocks, header)
}
