import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareWithSlackAlertBot } from '../slack-alert-bot'
import { sealedSlackRow, SLACK_TEST_KEY } from '../../__tests__/helpers/sealed-slack-row'

/**
 * Dan's decision 6 (#2337): an ops Slack connection is a separate Slack app's
 * bot, never the bot that posts Bidspoke's alerts. Ops never holds the alerts
 * login, so the bidding Worker, which does, compares the bot ops verify
 * measured (auth.test's bot_id) against the alerts bot, asked of Slack with
 * the alert row's token through verifySlackToken.
 */

const ENV = { SECRET_ENCRYPTION_KEY: SLACK_TEST_KEY }
const ALERT_TOKEN = 'canary-alert-bot-token-2337'
// The alert row as stored (#2331's contract release): the token sealed, no plaintext.
const alertRow = await sealedSlackRow({ bot_token: ALERT_TOKEN, default_channel: 'C0ALERTS' })
const read = (data: unknown, error: unknown = null) => () => Promise.resolve({ data, error })

function slackAnswers(...bodies: unknown[]) {
  const seen: Request[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: Request) => {
    seen.push(input)
    const next = bodies.shift()
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return seen
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('compareWithSlackAlertBot', () => {
  it('is the alerts bot when the alert token authenticates as the bot ops measured', async () => {
    const seen = slackAnswers({ ok: true, team_id: 'T0PENNIE', user_id: 'U0ALERTS', bot_id: 'B0SAME', user: 'bidspoke_alerts', team: 'Pennie' })
    expect(await compareWithSlackAlertBot(read([alertRow]), ENV, 'org-1', 'B0SAME')).toEqual({ kind: 'alert_bot' })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('https://slack.com/api/auth.test')
    expect(seen[0].headers.get('Authorization')).toBe(`Bearer ${ALERT_TOKEN}`)
  })

  it('is another bot when the alerts bot is a different one', async () => {
    slackAnswers({ ok: true, team_id: 'T0PENNIE', user_id: 'U0ALERTS', bot_id: 'B0ALERTS' })
    expect(await compareWithSlackAlertBot(read([alertRow]), ENV, 'org-1', 'B0OPS')).toEqual({ kind: 'other' })
  })

  it('has nothing to compare when there is no alert login, or Slack refuses its token: neither is a bot that could post', async () => {
    slackAnswers()
    expect(await compareWithSlackAlertBot(read([]), ENV, 'org-1', 'B0OPS')).toEqual({ kind: 'other' })
    slackAnswers({ ok: false, error: 'token_revoked' })
    expect(await compareWithSlackAlertBot(read([alertRow]), ENV, 'org-1', 'B0OPS')).toEqual({ kind: 'other' })
  })

  it('cannot tell, and says so, when the row cannot be read, is ambiguous, its sealed token opens with no key, or Slack does not answer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    slackAnswers()
    expect(await compareWithSlackAlertBot(read(null, { message: 'timeout' }), ENV, 'org-1', 'B0OPS')).toMatchObject({ kind: 'unreadable' })
    expect(await compareWithSlackAlertBot(read([alertRow, alertRow]), ENV, 'org-1', 'B0OPS')).toMatchObject({ kind: 'unreadable' })
    expect(await compareWithSlackAlertBot(read([{ config: { default_channel: 'C0ALERTS' }, credential_enc: 'not-a-sealed-value' }]), ENV, 'org-1', 'B0OPS')).toMatchObject({ kind: 'unreadable' })
    slackAnswers(new TypeError('network down'))
    expect(await compareWithSlackAlertBot(read([alertRow]), ENV, 'org-1', 'B0OPS')).toMatchObject({ kind: 'unreadable' })
  })

  it('never puts the alert token in what it answers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    slackAnswers(new TypeError(`network down near ${ALERT_TOKEN}`))
    const answer = await compareWithSlackAlertBot(read([alertRow]), ENV, 'org-1', 'B0OPS')
    expect(JSON.stringify(answer)).not.toContain(ALERT_TOKEN)
  })
})
