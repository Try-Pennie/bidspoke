import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { stubFetch, type FetchMock } from '../../__tests__/helpers/fetch-mock'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'
import { sendThreadReply } from '../slack'

/**
 * sendThreadReply posts through createSlackClient (#2331 phase 1b). Its rule is
 * its own, and differs from deliverMessage's (F123): it catches every failure
 * and NEVER throws, a network failure included. Its one caller
 * (execution-alerts) posts the drafted summary under an alert that has already
 * gone out, and a failed summary must not fail that caller. It returns nothing;
 * the only trace of a failure is the log line, so each case pins its exact line.
 *
 * Every case below except the two marked as new held against the hand written
 * fetch this replaced. The two new ones: a 429 now logs its Retry-After, and a
 * 2xx other than 200 is now logged as an HTTP error (the library treats only
 * 200 as an answer) where the old fetch parsed it and logged nothing.
 */

const TOKEN = 'canary-bot-token-2331-thread'
const HANDLE = { channel: 'C0ALERTS', ts: '1760700000.000100', bot_token: TOKEN }

function slackResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

describe('sendThreadReply through the Slack client (#2331, F123)', () => {
  let fetchMock: FetchMock
  let error: MockInstance<(...args: unknown[]) => void>
  const lines = () => error.mock.calls.map((args) => args.map(String).join(' '))

  beforeEach(() => {
    fetchMock = stubFetch()
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('posts the text under the parent message (channel, thread_ts, unfurl_links false, the bearer token) and logs nothing', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: true, ts: '1760700001.000200' }))
    await expect(sendThreadReply(HANDLE, 'Summary: the credit pull timed out')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const post = await slackPostOf(fetchMock.mock.calls[0])
    expect(post.url).toBe('https://slack.com/api/chat.postMessage')
    expect(post.token).toBe(TOKEN)
    expect(post.channel).toBe('C0ALERTS')
    expect(post.thread_ts).toBe('1760700000.000100')
    expect(post.text).toBe('Summary: the credit pull timed out')
    expect(post.unfurl_links).toBe(false)
    expect(post.blocks).toBeUndefined()
    expect(error).not.toHaveBeenCalled()
  })

  it('posts through the Slack client, as one Request', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: true, ts: '1.1' }))
    await sendThreadReply(HANDLE, 'hi')
    expect(fetchMock.mock.calls[0]).toHaveLength(1)
    expect(fetchMock.mock.calls[0][0]).toBeInstanceOf(Request)
  })

  it('resolves, and logs the Slack error code, when Slack answers ok:false', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'thread_not_found' }))
    await expect(sendThreadReply(HANDLE, 'hi')).resolves.toBeUndefined()
    expect(lines()).toEqual(['[slack] thread reply API error: thread_not_found'])
  })

  it('resolves, and logs the same line as before, when Slack answers ok:false with no error code', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false }))
    await expect(sendThreadReply(HANDLE, 'hi')).resolves.toBeUndefined()
    expect(lines()).toEqual(['[slack] thread reply API error: undefined'])
  })

  it('resolves on a 429 in one request with no timer (never slept on), and logs it', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'ratelimited' }, 429))
    await expect(sendThreadReply(HANDLE, 'hi')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(timer).not.toHaveBeenCalled()
    expect(lines()).toEqual(['[slack] thread reply HTTP error 429'])
  })

  // New in #2331: the Retry-After is logged, as deliverMessage's line does.
  it('logs the Retry-After of a 429, not waited for', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '30' }))
    await expect(sendThreadReply(HANDLE, 'hi')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(timer).not.toHaveBeenCalled()
    expect(lines()).toEqual(['[slack] thread reply HTTP error 429, Retry-After 30 s, not waited for'])
  })

  it('resolves, and logs the status, on a 500', async () => {
    fetchMock.mockImplementation(async () => new Response('upstream down', { status: 500 }))
    await expect(sendThreadReply(HANDLE, 'hi')).resolves.toBeUndefined()
    expect(lines()).toEqual(['[slack] thread reply HTTP error 500'])
  })

  it('resolves, never throws, on a network failure, and logs the error the fetch threw (the same object)', async () => {
    const down = new TypeError('fetch failed')
    fetchMock.mockImplementation(() => Promise.reject(down))
    await expect(sendThreadReply(HANDLE, 'hi')).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]).toHaveLength(2)
    expect(error.mock.calls[0][0]).toBe('[slack] thread reply failed:')
    expect(error.mock.calls[0][1]).toBe(down)
  })

  it('resolves, never throws, when a 200 answer is not JSON, and logs the SyntaxError', async () => {
    fetchMock.mockImplementation(async () => new Response('<html>edge</html>', { status: 200 }))
    await expect(sendThreadReply(HANDLE, 'hi')).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toBe('[slack] thread reply failed:')
    expect(error.mock.calls[0][1]).toBeInstanceOf(SyntaxError)
  })

  // The one answer whose result changed in #2331: the old fetch took any 2xx as
  // res.ok and parsed it, so a 201 saying ok:true logged nothing. The library
  // treats only 200 as an answer, so it is now logged as an HTTP error. It still
  // resolves, and the function returns nothing either way. Slack answers
  // chat.postMessage with 200, so this is an edge.
  it('resolves and logs an HTTP error for a 2xx other than 200, even when its body says ok:true', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: true, ts: '1.1' }, 201))
    await expect(sendThreadReply(HANDLE, 'hi')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lines()).toEqual(['[slack] thread reply HTTP error 201'])
  })

  it('never puts the token in a log line', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'invalid_auth' }, 429, { 'Retry-After': '5' }))
    await sendThreadReply(HANDLE, 'hi')
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'invalid_auth' }))
    await sendThreadReply(HANDLE, 'hi')
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    await sendThreadReply(HANDLE, 'hi')
    expect(error).toHaveBeenCalledTimes(3)
    expect(lines().join('\n')).not.toContain(TOKEN)
  })
})
