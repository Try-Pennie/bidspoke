/**
 * Which Slack refusals page at once and which only after a run (#2364, Dan's
 * decisions 1 and 2 of 2026-10-26).
 *
 * A DESTINATION refusal says the bot cannot post where it is pointed: its token
 * is dead or was never granted, it is not in the channel, or the channel is
 * gone. Waiting never repairs one, so the first pages. The 2026-10-23 to 26
 * outage was one of these: a Reconnect saved a bot token that was not in
 * #statuspage, and about 3,400 posts were refused with not_in_channel.
 *
 * Everything else is TRANSIENT: a 429 or `ratelimited`, a Slack 5xx or one of
 * its own server errors, a post with no answer at all, and any reason or status
 * not named here. An unknown reason is transient because nobody has seen it
 * yet, and is marked unknown so the page names it rather than a category.
 *
 * Message faults (invalid_blocks, msg_too_long) lose one kind of alert while
 * Slack works; they are recorded but not paged, a follow up of #2364.
 *
 * Pure, with no I/O, so deliverMessage can classify every post inline.
 */

/** The reasons Dan listed on 2026-10-26 as paging on the first refusal. */
export const DESTINATION_REASONS = [
  'invalid_auth',
  'token_revoked',
  'account_inactive',
  'token_expired',
  'not_authed',
  'not_in_channel',
  'channel_not_found',
  'is_archived',
  'missing_scope',
  'no_permission',
  'restricted_action',
  'team_access_not_granted',
  'ekm_access_denied',
] as const

/** Slack's own names for a temporary failure, answered with ok:false. */
const TRANSIENT_REASONS: ReadonlySet<string> = new Set(['ratelimited', 'service_unavailable', 'internal_error', 'fatal_error', 'request_timeout'])

const DESTINATION: ReadonlySet<string> = new Set(DESTINATION_REASONS)

export type SlackRefusalKind = 'destination' | 'transient'

export interface SlackRefusalClass {
  kind: SlackRefusalKind
  /** False for a reason or status this module does not name, which the page then names as it came. */
  known: boolean
}

/**
 * Classify one refused post: by Slack's error code when it gave one, by HTTP
 * status when it did not, and `null` for a post that got no answer.
 */
export function classifySlackRefusal(reasonOrStatus: string | number | null): SlackRefusalClass {
  if (reasonOrStatus === null) return { kind: 'transient', known: true }
  if (typeof reasonOrStatus === 'number') {
    const known = reasonOrStatus === 429 || (reasonOrStatus >= 500 && reasonOrStatus <= 599)
    return { kind: 'transient', known }
  }
  if (DESTINATION.has(reasonOrStatus)) return { kind: 'destination', known: true }
  return { kind: 'transient', known: TRANSIENT_REASONS.has(reasonOrStatus) }
}

/**
 * The name a refusal is counted and paged under: Slack's error code when it
 * gave one, otherwise `HTTP <status>`, otherwise `no answer`.
 */
export function slackRefusalLabel(reason: string | null, status: number | null): string {
  if (reason !== null) return reason
  if (status !== null) return `HTTP ${status}`
  return 'no answer'
}
