import { describe, expect, it } from 'vitest'
import { classifySlackRefusal, DESTINATION_REASONS, slackRefusalLabel } from '../slack-refusal'

/**
 * Which Slack refusals page at once and which only after a run (#2364, Dan's
 * decisions 1 and 2 of 2026-10-26).
 *
 * A destination refusal says the bot cannot post where it is pointed (its token
 * is dead, it is not in the channel, the channel is gone), which no amount of
 * waiting repairs, so the first one pages. Everything else (a rate limit, a
 * Slack 5xx, no answer at all, or a reason nobody has seen before) is treated
 * as temporary, and pages only after a run of them.
 */
describe('classifySlackRefusal', () => {
  it('names exactly the thirteen destination reasons Dan listed', () => {
    expect([...DESTINATION_REASONS].sort()).toEqual([
      'account_inactive',
      'channel_not_found',
      'ekm_access_denied',
      'invalid_auth',
      'is_archived',
      'missing_scope',
      'no_permission',
      'not_authed',
      'not_in_channel',
      'restricted_action',
      'team_access_not_granted',
      'token_expired',
      'token_revoked',
    ])
  })

  it.each([...DESTINATION_REASONS])('%s is a destination refusal, known', (reason) => {
    expect(classifySlackRefusal(reason)).toEqual({ kind: 'destination', known: true })
  })

  it.each(['ratelimited', 'service_unavailable', 'internal_error', 'fatal_error', 'request_timeout'])('%s is transient, known', (reason) => {
    expect(classifySlackRefusal(reason)).toEqual({ kind: 'transient', known: true })
  })

  it('a 429 and every 5xx are transient, known', () => {
    expect(classifySlackRefusal(429)).toEqual({ kind: 'transient', known: true })
    for (const status of [500, 502, 503, 504, 599]) expect(classifySlackRefusal(status)).toEqual({ kind: 'transient', known: true })
  })

  it('a post with no answer is transient, known', () => {
    expect(classifySlackRefusal(null)).toEqual({ kind: 'transient', known: true })
  })

  it('an unknown reason or status is transient and marked unknown, so the page can name it', () => {
    expect(classifySlackRefusal('some_new_slack_error')).toEqual({ kind: 'transient', known: false })
    expect(classifySlackRefusal(201)).toEqual({ kind: 'transient', known: false })
    expect(classifySlackRefusal(404)).toEqual({ kind: 'transient', known: false })
  })

  it('labels a refusal by its reason, its status, or as no answer', () => {
    expect(slackRefusalLabel('not_in_channel', 200)).toBe('not_in_channel')
    expect(slackRefusalLabel(null, 429)).toBe('HTTP 429')
    expect(slackRefusalLabel(null, null)).toBe('no answer')
  })
})
