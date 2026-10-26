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
 * (the record's key, so a line copied twice is one row) and the alert's title.
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
}

export interface SlackPostOutcomeInput {
  outcome: SlackPostOutcome
  reason?: string | null
  status?: number | null
  channel: string
  retryAfter?: string | null
  title: string | null
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
