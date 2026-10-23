/**
 * The Slack token alerts send their reader to where the token is fixed (#2338,
 * build PR 14): the Integrations page is retired, so they link to the Slack
 * alerts login on the Connections page (SLACK_ALERT_LOGIN_LINK), where
 * Reconnect saves a token sealed under the current key, and never to
 * /integrations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SLACK_ALERT_LOGIN_LINK } from '@bidspoke/service-catalogue/schema'
import { sendSlackTokenReadableAlert, sendSlackTokenUnreadableAlert } from '../slack'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'

const APP = 'https://bidspoke.trypennie.dev'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, ts: '1.1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

async function textOf(): Promise<string> {
  const post = await slackPostOf(fetchMock.mock.calls[0])
  return JSON.stringify(post.blocks)
}

describe('the Slack token alerts link to the Slack alerts login on the Connections page', () => {
  it('the unreadable token alert says to reconnect there, and links to it', async () => {
    expect(SLACK_ALERT_LOGIN_LINK).toBe('/connections?connection=slack-alerts')
    await sendSlackTokenUnreadableAlert({ bot_token: 'canary-token' }, '#alerts', { reason: 'slack_token_undecryptable', appUrl: APP })
    const text = await textOf()
    expect(text).toContain('reconnect Bidspoke Alerts on the Connections page')
    expect(text).toContain(`<${APP}${SLACK_ALERT_LOGIN_LINK}|Open Bidspoke Alerts>`)
    expect(text).not.toMatch(/\/integrations|Integrations/)
  })

  it('its all-clear links there too', async () => {
    await sendSlackTokenReadableAlert({ bot_token: 'canary-token' }, '#alerts', { alertedAt: '2026-10-21T12:00:00Z', endedAt: '2026-10-21T13:00:00Z', appUrl: APP }, Date.parse('2026-10-21T13:05:00Z'))
    const text = await textOf()
    expect(text).toContain(`<${APP}${SLACK_ALERT_LOGIN_LINK}|Open Bidspoke Alerts>`)
    expect(text).not.toMatch(/\/integrations|Integrations/)
  })
})
