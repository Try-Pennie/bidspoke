import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { SlackAPIConnectionError, SlackAPIError } from 'slack-web-api-client'
import { createSlackClient, slackBodyOf, slackCallFailure, slackNetworkCause } from '../index'

/**
 * The one place a Slack Web API client is built (#2331 phase 1b, #1689 D3),
 * moved with its factory from the Worker into this package (#2337), so the
 * guard below covers every caller: the Worker's alerts and Settings routes
 * today, and the service catalogue's ops Slack actions when they arrive.
 *
 * The guard: the client createSlackClient builds has the library's rate limit
 * retry handler OFF and its debug logging OFF. Left on, the retry handler
 * sleeps for whatever Retry-After says inside the request, with no cap and no
 * clock a test can move (L365, L524), and debug logging prints every request
 * body, which for oauth.v2.access holds the client secret and refresh token.
 * Both are asserted by what the client DOES (no second request, no timer, no
 * console output), not only by the option passed, because the library keeps
 * its log level in a private field nothing outside can read.
 *
 * Seen red: with `retryHandlers: []` removed from the factory, the 429 tests
 * fail (two requests and a setTimeout); with `logLevel: 'DEBUG'`, the logging
 * tests fail (the request body and the response are printed).
 */

/** The global fetch, replaced. The Worker's typed helper does not reach this package, so this is its few lines. */
type FetchMock = Mock<(input: Request) => Promise<Response>>
function stubFetch(): FetchMock {
  const mock = vi.fn<(input: Request) => Promise<Response>>()
  vi.stubGlobal('fetch', mock)
  return mock
}

const TOKEN = 'canary-bot-token-2331'
const SECRET_IN_BODY = 'canary-request-body-2331'

function slackResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

describe('createSlackClient: the retry handler is off (#2331)', () => {
  let fetchMock: FetchMock
  beforeEach(() => {
    fetchMock = stubFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('carries no retry handler at all', () => {
    expect(createSlackClient({ bot_token: TOKEN }).retryHandlers).toEqual([])
  })

  it('gives each client its own empty list, so pushing a handler onto one cannot arm another', () => {
    const first = createSlackClient({ bot_token: TOKEN })
    const second = createSlackClient({ bot_token: TOKEN })
    expect(first.retryHandlers).not.toBe(second.retryHandlers)
  })

  it('makes one request on a 429 and never sets a timer to wait out Retry-After', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '0.001' }))
    const error: unknown = await createSlackClient({ bot_token: TOKEN }).chat.postMessage({ channel: '#c', text: 'hi' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SlackAPIConnectionError)
    expect((error as SlackAPIConnectionError).status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(timer).not.toHaveBeenCalled()
  })

  it('makes one request on a 500 and on a network failure', async () => {
    fetchMock.mockImplementationOnce(async () => slackResponse({}, 500))
    await expect(createSlackClient({ bot_token: TOKEN }).chat.postMessage({ channel: '#c', text: 'hi' })).rejects.toBeInstanceOf(SlackAPIConnectionError)
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError('network down')))
    await expect(createSlackClient({ bot_token: TOKEN }).chat.postMessage({ channel: '#c', text: 'hi' })).rejects.toBeInstanceOf(SlackAPIConnectionError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('createSlackClient: debug logging is off (#2331)', () => {
  let fetchMock: FetchMock
  let printed: string[]
  beforeEach(() => {
    fetchMock = stubFetch()
    printed = []
    for (const method of ['log', 'debug', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(' '))
      })
    }
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('prints nothing for a delivered call, so neither the body nor the response reaches the logs', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: true, ts: '1.2' }))
    await createSlackClient({ bot_token: TOKEN }).chat.postMessage({ channel: '#c', text: SECRET_IN_BODY })
    expect(printed).toEqual([])
  })

  it('prints nothing for a refused call either', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'invalid_auth' }))
    await createSlackClient({ bot_token: TOKEN }).chat.postMessage({ channel: '#c', text: SECRET_IN_BODY }).catch(() => undefined)
    expect(printed).toEqual([])
  })
})

describe('createSlackClient: what it sends (#2331)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts to the Slack Web API with the connection token as a bearer token, and nowhere in the body', async () => {
    const seen: Request[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: Request) => {
      seen.push(input)
      return slackResponse({ ok: true, ts: '1.2' })
    }))
    await createSlackClient({ bot_token: TOKEN }).chat.postMessage({ channel: '#c', text: 'hi' })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('https://slack.com/api/chat.postMessage')
    expect(seen[0].headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(await seen[0].text()).not.toContain(TOKEN)
  })
})

describe('slackCallFailure: which thrown errors are a Slack answer rather than no answer (#2331)', () => {
  it('reads an ok:false refusal as its Slack error code', () => {
    const refusal = { ok: false, error: 'channel_not_found', headers: new Headers() }
    expect(slackCallFailure(new SlackAPIError('chat.postMessage', 'channel_not_found', refusal))).toEqual({
      kind: 'api',
      error: 'channel_not_found',
    })
  })

  it('reads an HTTP status as that status, with Retry-After when Slack sent one', () => {
    const headers = new Headers({ 'Retry-After': '30' })
    expect(slackCallFailure(new SlackAPIConnectionError('chat.postMessage', 429, '', headers, undefined))).toEqual({
      kind: 'http',
      status: 429,
      retryAfter: '30',
    })
    expect(slackCallFailure(new SlackAPIConnectionError('chat.postMessage', 500, 'oops', new Headers(), undefined))).toEqual({
      kind: 'http',
      status: 500,
      retryAfter: null,
    })
  })

  it('does not read a network failure, or anything else, as a Slack answer', () => {
    const cause = new TypeError('network down')
    expect(slackCallFailure(new SlackAPIConnectionError('chat.postMessage', -1, '', undefined, cause))).toBeNull()
    expect(slackCallFailure(new SyntaxError('Unexpected token <'))).toBeNull()
    expect(slackCallFailure('a string')).toBeNull()
  })

  it('hands back the original fetch error for a network failure, and anything else unchanged', () => {
    const cause = new TypeError('network down')
    expect(slackNetworkCause(new SlackAPIConnectionError('chat.postMessage', -1, '', undefined, cause))).toBe(cause)
    const other = new SyntaxError('Unexpected token <')
    expect(slackNetworkCause(other)).toBe(other)
  })
})

describe('slackBodyOf: the body of any answer is the answer, as the Settings routes read Slack before the client (#2331)', () => {
  let fetchMock: FetchMock
  let warned: string[]
  beforeEach(() => {
    fetchMock = stubFetch()
    warned = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push(args.map(String).join(' '))
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const list = () => slackBodyOf('conversations.list', () => createSlackClient({ bot_token: TOKEN }).conversations.list({ limit: 1 }))

  it('returns a success as returned', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: true, channels: [] }))
    expect(await list()).toMatchObject({ ok: true, channels: [] })
  })

  it('returns the body of an ok:false refusal rather than throwing', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'invalid_auth' }))
    expect(await list()).toMatchObject({ ok: false, error: 'invalid_auth' })
  })

  it('returns the JSON body of a 429 at once, never waiting, and logs its Retry-After', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '30' }))
    expect(await list()).toEqual({ ok: false, error: 'ratelimited' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(timer).not.toHaveBeenCalled()
    expect(warned).toEqual(['[slack] conversations.list HTTP error 429, Retry-After 30 s, not waited for'])
  })

  it('throws SyntaxError for an error status whose body is not JSON', async () => {
    fetchMock.mockImplementation(async () => new Response('<html>bad gateway</html>', { status: 502 }))
    await expect(list()).rejects.toBeInstanceOf(SyntaxError)
  })

  it('rethrows the fetch error itself when there was no answer', async () => {
    const cause = new TypeError('network down')
    fetchMock.mockImplementation(() => Promise.reject(cause))
    await expect(list()).rejects.toBe(cause)
  })
})
