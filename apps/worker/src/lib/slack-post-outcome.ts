/**
 * One structured line per Slack post (#2364).
 *
 * From 2026-10-23 to 26 about 3,400 alert posts were refused with
 * not_in_channel and nothing paged: a refusal reached only a free text log
 * line, and nothing read those. deliverMessage and sendThreadReply (lib/slack.ts),
 * the only two places the Worker posts to Slack, each call logSlackPostOutcome
 * once per post, in every branch, before deliverMessage rethrows a post with no
 * answer. The tail Worker copies the line into slack_post_outcomes
 * (apps/worker-tail/src/slack-posts.ts), which the minute refusal check reads
 * (slack-refusal-watch.ts). A guard holds both posters to calling this
 * (slack-posts-log-their-outcome.test.ts).
 *
 * WHAT IT CARRIES: the outcome, Slack's error code or the HTTP status, how the
 * refusal is classed, the channel posted to, any Retry-After, a fresh post id
 * (the record's key, so a line copied twice is one row), the alert's title and
 * its fixed kind name.
 * Never the token, never the message body or its fallback text, which can
 * quote a lead.
 *
 * THE TITLE (Dan's decision 5): the all clear lists the alerts lost, by title.
 * It is the header block's plain text only, and it is not trusted: some titles
 * are built from a value (a partner, a job, a workflow name), and nothing stops
 * a future builder putting a lead's field in one. So redactAlertTitle replaces
 * anything shaped like an email address, a phone number, an SSN or any run of
 * four or more digits, and cuts it to 120 characters. A thread reply carries no
 * header, and its text is a summary of a failure, so it is titled only as a
 * thread reply.
 *
 * THE ALERT KIND (#2948): a title does not tell alert kinds apart. Some alerts
 * have no header (the HTTP money host page, at Dan's request, #2761) and some
 * build their title from a value. So a sender also names a fixed kind from
 * SLACK_ALERT_KINDS, which the line records as alert_kind whether or not a
 * title is shown, and the tail Worker copies into slack_post_outcomes.alert_kind
 * (#2811 tells a failing alert kind apart by it). The kind is a required
 * argument of every poster (postMessage, sendThreadReply and the shared
 * senders in lib/slack.ts), so an alert that names none does not compile. One
 * kind per kind of alert, never per call site: two places posting the same
 * alert share one, and one function posting two alerts names two. A thread
 * reply names the kind of the alert it replies under. Rows written before
 * #2948 hold null, which the table still allows.
 *
 * It adds no I/O and no await: one console.log, which Workers Logs and the tail
 * Worker both receive, and crypto.randomUUID. It never throws into a poster.
 */
import { classifySlackRefusal, type SlackRefusalKind } from './slack-refusal'

/** Kept in step with the tail Worker's parser, which the worker's test feeds this real line. */
export const SLACK_POST_OUTCOME_PREFIX = '[slack] post outcome '

/** The title every thread reply is recorded under. */
export const THREAD_REPLY_TITLE = 'Thread reply'

/** The most characters of a title kept. The table allows 200. */
export const TITLE_MAX = 120

export type SlackPostOutcome = 'delivered' | 'refused' | 'no_answer'

/**
 * Every alert kind a sender may name (#2948): fixed words, never built from a
 * value, so the record can group an alert's posts however its title reads.
 * Each is lower case words joined by single hyphens, at most ALERT_KIND_MAX
 * characters, which the table's own CHECK and the tail Worker's parser also
 * hold (migration 20261028170000). Named after the alert's job, check or
 * incident signal where it has one, and an all-clear after its page with
 * `-all-clear`. A new alert adds its kind here, and a removed one takes its
 * kind out: a guard fails on a listed kind no sender names, and on a name
 * listed twice (apps/web/src/lib/__guards__/worker/slack-alert-kinds-are-used.test.ts).
 */
export const SLACK_ALERT_KINDS = [
  // A run, a workflow's runs and its partners (the AI summary threads under the first two).
  'execution-failure',
  'slow-execution',
  'slow-spike',
  'slow-spike-all-clear',
  'failure-spike',
  'failure-saturation',
  'upstream-outage',
  'failure-rate-all-clear',
  'partner-error-rate',
  'partner-error-rate-all-clear',
  'circuit-breaker',
  'volume-cliff',
  'volume-cliff-all-clear',
  'volume-anomaly',
  'lead-validation-config',
  'lead-validation-config-all-clear',
  'lead-validation-rejection-rate',
  'lead-validation-rejection-rate-all-clear',
  'field-presence-drought',
  'field-presence-drought-all-clear',
  'field-presence-dead',
  'field-presence-dead-all-clear',
  'field-presence-wrong-path',
  'field-presence-wrong-path-all-clear',
  'email-drop-rate',
  'bid-recording-none',
  'bid-recording-ratio',
  'buyer-click-page',
  'buyer-click-over-cap',
  'slowdown-summary',
  'repeated-slowdown',
  // The bid matrix.
  'bid-matrix-change',
  'bid-matrix-validation',
  'bid-matrix-sync',
  'sf-matrix-audit',
  'sf-matrix-audit-rebuilt',
  // Writes that must not be lost.
  'outcome-deadletter',
  'outcome-deadletter-writeback-lost',
  'outcome-deadletter-writeback-uncapturable',
  'outcome-deadletter-writeback-held',
  'outcome-deadletter-writeback-held-unrecorded',
  'outcome-deadletter-continuation-unfinished',
  'deadletter-volume',
  'unconfirmed-writes',
  'writeback-backlog',
  'writeback-backlog-all-clear',
  'writeback-drain',
  'salesforce-read-back-resend-failed',
  'salesforce-read-back-unknown',
  'salesforce-read-back-conflict',
  'salesforce-read-back-unread',
  'salesforce-read-back-not-running',
  'salesforce-bulkhead-limit',
  'salesforce-bulkhead-limit-all-clear',
  'strand-branch-skew',
  'invalid-state-canary-watch',
  'send-salesforce-canary-watch',
  // Scheduled jobs and the checks that watch them.
  'export-alert',
  'cron-guard-failed-open',
  'cron-guard-skipped-duplicate',
  'cron-guard-double-run',
  'cron-heartbeat-dark',
  'cron-heartbeat-vanished',
  'cron-heartbeat-unstamped',
  'cron-heartbeat-all-clear',
  'pg-cron-watch',
  'pg-cron-watch-all-clear',
  'workflow-dispatch',
  'workflow-schedule',
  'workflow-schedule-all-clear',
  'minute-job-failing',
  'minute-job-failing-all-clear',
  'drain-stall',
  'backup-failure',
  'timeout-config',
  'kill-rate-drift',
  'incident-drain-behind',
  'incident-drain-caught-up',
  // The database.
  'db-unreachable',
  'db-unreachable-all-clear',
  'stored-copy-serving',
  'stored-copy-serving-all-clear',
  'supabase-memory-short',
  'supabase-memory-unreadable',
  'supabase-memory-all-clear',
  'big-table-growth',
  'query-timeout',
  'query-cancelled',
  // Secrets and the Slack connection itself.
  'secret-drift',
  'secret-decrypt',
  'required-secrets',
  'required-env-vars',
  'slack-token-undecryptable',
  'slack-token-undecryptable-all-clear',
  'slack-post-refused-all-clear',
  // Partners and the partners page.
  'partner-reachability-blocked',
  'partner-reachability-unreachable',
  'partner-reachability-control-failing',
  'partner-reachability-probe-broken',
  'partner-reachability-all-clear',
  'partner-page-live-channel',
  'partner-page-live-monitor',
  'partner-page-live-all-clear',
  'partner-page-live-miss',
  // Ops connections.
  'ops-connection-login',
  'ops-connection-login-all-clear',
  'ops-connection-write-back',
  'ops-connection-write-back-all-clear',
  'ops-key-reseal',
  'ops-key-reseal-all-clear',
  'ops-connection-owner',
  'ops-connection-owner-all-clear',
  'http-money-host',
  'http-money-host-all-clear',
] as const

export type SlackAlertKind = (typeof SLACK_ALERT_KINDS)[number]

/** The shape the table accepts for an alert kind. */
export const ALERT_KIND_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The most characters an alert kind may have. */
export const ALERT_KIND_MAX = 60

export interface SlackPostOutcomeLine {
  post_id: string
  outcome: SlackPostOutcome
  /** Slack's error code, for an ok:false answer that carried one. */
  reason: string | null
  /** The HTTP status Slack answered with; null when there was no answer. */
  status: number | null
  /** How a refusal is classed; null for a delivered post. */
  kind: SlackRefusalKind | null
  channel: string
  /** The Retry-After of a refused post, when Slack sent one. */
  retry_after: string | null
  title: string | null
  /** The alert's fixed kind name (#2948). Every sender names one. */
  alert_kind: SlackAlertKind
}

export interface SlackPostOutcomeInput {
  outcome: SlackPostOutcome
  reason?: string | null
  status?: number | null
  channel: string
  retryAfter?: string | null
  title: string | null
  alertKind: SlackAlertKind
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g
/** A phone number written with separators: (555) 123-4567, 555.123.4567, 555-123-4567. */
const PHONE = /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g
/** An SSN written with dashes or spaces. */
const SSN = /\b\d{3}[\s-]\d{2}[\s-]\d{4}\b/g
/** Any run of four or more digits: an unseparated SSN, phone, card, zip or id. */
const DIGITS = /\d{4,}/g

/** A title with anything that could be applicant data replaced, at most TITLE_MAX characters. */
export function redactAlertTitle(text: string): string {
  return text
    .replace(EMAIL, '[redacted]')
    .replace(PHONE, '[redacted]')
    .replace(SSN, '[redacted]')
    .replace(DIGITS, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX)
}

/** The header block's text, redacted, or null when the message has no header with text. */
export function alertTitleOf(blocks: readonly unknown[]): string | null {
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: unknown; text?: { text?: unknown } }
    if (b.type !== 'header') continue
    const text = typeof b.text?.text === 'string' ? redactAlertTitle(b.text.text) : ''
    return text === '' ? null : text
  }
  return null
}

/** The line for one post. */
export function slackPostOutcomeLine(input: SlackPostOutcomeInput): SlackPostOutcomeLine {
  const reason = input.reason ?? null
  const status = input.status ?? null
  const kind = input.outcome === 'delivered'
    ? null
    : classifySlackRefusal(input.outcome === 'no_answer' ? null : reason ?? status).kind
  return {
    post_id: crypto.randomUUID(),
    outcome: input.outcome,
    reason,
    status,
    kind,
    channel: input.channel,
    retry_after: input.retryAfter ?? null,
    title: input.title,
    alert_kind: input.alertKind,
  }
}

/** Write the one outcome line for a post. Never throws. */
export function logSlackPostOutcome(input: SlackPostOutcomeInput): void {
  try {
    console.log(`${SLACK_POST_OUTCOME_PREFIX}${JSON.stringify(slackPostOutcomeLine(input))}`)
  } catch {
    // A line that cannot be written must never change what the post returns or throws.
  }
}
