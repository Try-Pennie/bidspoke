import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlackAPIConnectionError, SlackAPIError } from 'slack-web-api-client'
import { createSlackClient, slackCallFailure, type SlackFetch } from '../index'

/**
 * A client bound to a connection's fetch (#2337): what the ops Slack actions
 * and the ops Slack verify build, through the same factory as every alert, so
 * there is still one place a Slack client is made and its two guards (no
 * retry handler, no debug logging) cover the ops calls too.
 *
 * The library sends through the global fetch and has no option to send any
 * other way, but an ops request must go through connectionFetch, which applies
 * the login itself and refuses any host the connection did not declare. So the
 * bound client builds the request exactly as the library does and hands it to
 * the fetch it was given. What that fetch throws (a refusal, a requeue, a
 * timeout) reaches the caller unchanged, because an ops action leaves those to
 * the executor; an answer is read as the library reads one.
 */

const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

interface Sent {
  url: string
  init: RequestInit | undefined
}

function boundFetch(...answers: Array<Response | (() => Promise<Response>)>): { fetch: SlackFetch; sent: Sent[] } {
  const sent: Sent[] = []
  const fetch: SlackFetch = async (url, init) => {
    sent.push({ url, init })
    const next = answers.shift()
    if (next === undefined) throw new Error('no answer queued')
    return typeof next === 'function' ? next() : next
  }
  return { fetch, sent }
}

describe('createSlackClient bound to a connection fetch (#2337)', () => {
  let globalFetch: ReturnType<typeof vi.fn>
  let printed: string[]
  beforeEach(() => {
    globalFetch = vi.fn(async () => {
      throw new Error('the global fetch must never be reached by a bound client')
    })
    vi.stubGlobal('fetch', globalFetch)
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

  it('sends through the given fetch, never the global one, as the library builds the request, with no Authorization of its own', async () => {
    const f = boundFetch(answer({ ok: true, channel: 'C1', ts: '1.2' }))
    const result = await createSlackClient({ fetch: f.fetch }).chat.postMessage({ channel: 'C1', text: 'hi there', unfurl_links: false, blocks: [{ type: 'divider' }] })
    expect(result).toMatchObject({ ok: true, channel: 'C1', ts: '1.2' })
    expect(globalFetch).not.toHaveBeenCalled()
    expect(f.sent).toHaveLength(1)
    const [{ url, init }] = f.sent
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(headers.get('authorization')).toBeNull()
    const body = new URLSearchParams(init?.body as string)
    expect(Object.fromEntries(body)).toEqual({ channel: 'C1', text: 'hi there', unfurl_links: 'false', blocks: '[{"type":"divider"}]' })
  })

  it('passes the signal it was given on every request', async () => {
    const controller = new AbortController()
    const f = boundFetch(answer({ ok: true }))
    await createSlackClient({ fetch: f.fetch, signal: controller.signal }).auth.test()
    expect(f.sent[0].init?.signal).toBe(controller.signal)
  })

  it('refuses a token in the parameters before anything is sent: the connection applies the login, never the caller', async () => {
    const f = boundFetch(answer({ ok: true }))
    await expect(createSlackClient({ fetch: f.fetch }).chat.postMessage({ channel: 'C1', text: 'x', token: 'canary-smuggled-token-2337' })).rejects.toThrow(/token/)
    expect(f.sent).toEqual([])
  })

  it('throws an ok:false answer as the library does, so slackCallFailure reads its Slack code', async () => {
    const f = boundFetch(answer({ ok: false, error: 'not_in_channel' }))
    const error: unknown = await createSlackClient({ fetch: f.fetch }).chat.postMessage({ channel: 'C1', text: 'x' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SlackAPIError)
    expect(slackCallFailure(error)).toEqual({ kind: 'api', error: 'not_in_channel' })
  })

  it('throws any status but 200 as the library does, makes one request on a 429 and never sets a timer', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const f = boundFetch(answer({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '7' }))
    const error: unknown = await createSlackClient({ fetch: f.fetch }).chat.postMessage({ channel: 'C1', text: 'x' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SlackAPIConnectionError)
    expect(slackCallFailure(error)).toEqual({ kind: 'http', status: 429, retryAfter: '7' })
    expect(f.sent).toHaveLength(1)
    expect(timer).not.toHaveBeenCalled()
  })

  it('passes what the fetch throws on unchanged, never wrapped, so a refusal or a requeue reaches the caller as itself', async () => {
    // connectionFetch's RequeueAt is not an Error, so a plain object stands in for it.
    const requeue = { kind: 'requeue_at', notBefore: new Date(0) }
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const f = boundFetch(() => Promise.reject(requeue))
    await expect(createSlackClient({ fetch: f.fetch }).chat.postMessage({ channel: 'C1', text: 'x' })).rejects.toBe(requeue)
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    const g = boundFetch(() => Promise.reject(timeout))
    await expect(createSlackClient({ fetch: g.fetch }).chat.postMessage({ channel: 'C1', text: 'x' })).rejects.toBe(timeout)
  })

  it('carries no retry handler and prints nothing, delivered or refused', async () => {
    const client = createSlackClient({ fetch: boundFetch().fetch })
    expect(client.retryHandlers).toEqual([])
    const f = boundFetch(answer({ ok: true }), answer({ ok: false, error: 'invalid_auth' }))
    const bound = createSlackClient({ fetch: f.fetch })
    await bound.chat.postMessage({ channel: 'C1', text: 'canary-body-2337' })
    await bound.chat.postMessage({ channel: 'C1', text: 'canary-body-2337' }).catch(() => undefined)
    expect(printed).toEqual([])
  })

  it('refuses the two upload methods, which the library sends through the global fetch', async () => {
    const f = boundFetch()
    const client = createSlackClient({ fetch: f.fetch })
    await expect(client.files.upload({ channels: 'C1', content: 'x' })).rejects.toThrow(/files\.upload/)
    await expect(client.files.uploadV2({ channel_id: 'C1', file: new Blob(['x']), filename: 'x.txt' })).rejects.toThrow(/files\.uploadV2/)
    expect(f.sent).toEqual([])
    expect(globalFetch).not.toHaveBeenCalled()
  })
})
