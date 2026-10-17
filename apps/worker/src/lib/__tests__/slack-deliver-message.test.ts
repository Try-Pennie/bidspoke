import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubFetch, type FetchMock } from '../../__tests__/helpers/fetch-mock'
import { postMessage, sendDatabaseRecoveredAlert } from '../slack'

/**
 * deliverMessage posts through createSlackClient (#2331 phase 1b), and every
 * alert reaches Slack through it (postMessage, and the database owner's private
 * path). The rule kept from the hand written fetch it replaced (F123): Slack
 * ANSWERING with a failure (ok:false, a 429, a 500) returns null, as before, so
 * a sender gating a cooldown on it treats it as not delivered; NO answer (a
 * network failure) throws as before, with the same error the fetch threw. So no
 * alert path changes whether it throws. A 429 is logged with its Retry-After
 * and never waited out inside the request.
 */

const TOKEN = 'canary-bot-token-2331'

function slackResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

describe('postMessage through the Slack client (#2331)', () => {
  let fetchMock: FetchMock
  let errors: string[]
  beforeEach(() => {
    fetchMock = stubFetch()
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns the ts of a delivered message and posts the channel, text, blocks and unfurl_links false', async () => {
    const seen: Request[] = []
    fetchMock.mockImplementation(async (input: Request) => {
      seen.push(input)
      return slackResponse({ ok: true, ts: '171.99' })
    })
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'body' } }]
    expect(await postMessage(TOKEN, '#alerts', blocks, 'fallback')).toBe('171.99')
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('https://slack.com/api/chat.postMessage')
    expect(seen[0].headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    const form = new URLSearchParams(await seen[0].text())
    expect(form.get('channel')).toBe('#alerts')
    expect(form.get('text')).toBe('fallback')
    expect(JSON.parse(form.get('blocks') ?? 'null')).toEqual(blocks)
    expect(form.get('unfurl_links')).toBe('false')
  })

  it('returns null, not a throw, when Slack answers ok:false, and logs the Slack error code', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'channel_not_found' }))
    expect(await postMessage(TOKEN, '#c', [], 'hi')).toBeNull()
    expect(errors.join('\n')).toContain('channel_not_found')
  })

  it('returns null when Slack answers ok:false with no error code', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false }))
    expect(await postMessage(TOKEN, '#c', [], 'hi')).toBeNull()
  })

  it('returns null when Slack answers ok:true with no ts', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: true }))
    expect(await postMessage(TOKEN, '#c', [], 'hi')).toBeNull()
  })

  it('returns null on a 429, in one request with no timer, and logs the Retry-After', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '30' }))
    expect(await postMessage(TOKEN, '#c', [], 'hi')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(timer).not.toHaveBeenCalled()
    expect(errors.join('\n')).toMatch(/HTTP error 429.*Retry-After 30/)
  })

  it('returns null on a 500', async () => {
    fetchMock.mockImplementation(async () => new Response('upstream down', { status: 500 }))
    expect(await postMessage(TOKEN, '#c', [], 'hi')).toBeNull()
    expect(errors.join('\n')).toContain('HTTP error 500')
  })

  it('throws the same error the fetch threw when there is no answer at all (a network failure), as before', async () => {
    const down = new TypeError('fetch failed')
    fetchMock.mockImplementation(() => Promise.reject(down))
    await expect(postMessage(TOKEN, '#c', [], 'hi')).rejects.toBe(down)
  })

  it('throws, as before, when a 200 answer is not JSON', async () => {
    fetchMock.mockImplementation(async () => new Response('<html>edge</html>', { status: 200 }))
    await expect(postMessage(TOKEN, '#c', [], 'hi')).rejects.toBeInstanceOf(SyntaxError)
  })

  it('never puts the token in a log line', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'invalid_auth' }, 429, { 'Retry-After': '5' }))
    await postMessage(TOKEN, '#c', [], 'hi')
    expect(errors.join('\n')).not.toContain(TOKEN)
  })
})

describe("the database owner's own path through the Slack client (#2331)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reports not delivered on a 429 instead of throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async () => slackResponse({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '1' })))
    const payload = { alertedAt: '2026-10-17T12:00:00.000Z', endedAt: '2026-10-17T12:05:00.000Z', measured: 'Reads succeed again.', appUrl: 'https://app.example' }
    expect(await sendDatabaseRecoveredAlert({ bot_token: TOKEN }, '#c', payload, Date.parse('2026-10-17T12:06:00.000Z'))).toBe(false)
  })

  it('still throws on a network failure, as before', async () => {
    const down = new TypeError('fetch failed')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(down)))
    const payload = { alertedAt: '2026-10-17T12:00:00.000Z', endedAt: null, measured: 'Reads succeed again.', appUrl: 'https://app.example' }
    await expect(sendDatabaseRecoveredAlert({ bot_token: TOKEN }, '#c', payload)).rejects.toBe(down)
  })
})
