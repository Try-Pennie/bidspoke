/**
 * postToPartner (#1411): the one outbound POST to a partner, shared by the bid
 * resolver's API call and the buyer_select node's sale attempt. The credential
 * rule, the trace header and the body are the resolver's; the timeout is the
 * caller's. No network here: the fetch is injected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../index'
import { PartnerApiError } from '../../engine/partner-bid-error'
import { noAnswerOf, postToPartner } from '../post-to-partner'
import { stepTimeoutMarkerOf } from '../../engine/step-timeout'
import { PAST_THE_LIMIT, tricklingFetch } from './_trickling-fetch'

const TARGET = { slug: 'tripoint', api_endpoint: 'https://tripoint-proxy.trypennie.dev/leads/create', cf_secret_key: 'TRIPOINT_PROXY_SECRET' }
const env = { TRIPOINT_PROXY_SECRET: 'secret-value' } as unknown as Env

function fetchReturning(status: number, body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(body, { status, headers })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

describe('postToPartner', () => {
  it('posts the body as JSON with the trace header and the bearer credential, and returns status, text, json and headers', async () => {
    const { fetchImpl, calls } = fetchReturning(200, '{"ok":true,"data":{"createLead":{"id":"L1","resultCode":1000}}}')
    const result = await postToPartner(TARGET, { leadUuid: 'lead-1' }, env, { traceId: 'trace-1', timeoutMs: 20_000, fetchImpl })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(TARGET.api_endpoint)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Trace-Id': 'trace-1', Authorization: 'Bearer secret-value' })
    expect(calls[0].init.body).toBe('{"leadUuid":"lead-1"}')
    expect(result).toEqual({
      status: 200,
      text: '{"ok":true,"data":{"createLead":{"id":"L1","resultCode":1000}}}',
      json: { ok: true, data: { createLead: { id: 'L1', resultCode: 1000 } } },
      isHtml: false,
      headers: { 'content-type': 'application/json' },
    })
  })

  it('never sends the credential header when the partner has no credential configured', async () => {
    const { fetchImpl, calls } = fetchReturning(200, '{}')
    await postToPartner({ ...TARGET, cf_secret_key: null }, {}, env, { traceId: 't', timeoutMs: 1000, fetchImpl })
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Trace-Id': 't' })
  })

  it('a configured credential that is missing or blank is a permanent config error and the call is never made (#411, #417)', async () => {
    const { fetchImpl, calls } = fetchReturning(200, '{}')
    const err = await postToPartner(TARGET, {}, {} as Env, { traceId: 't', timeoutMs: 1000, fetchImpl }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PartnerApiError)
    expect((err as PartnerApiError).errorType).toBe('permanent')
    expect((err as PartnerApiError).isConfigError).toBe(true)
    expect((err as Error).message).toBe("Partner tripoint requires credential 'TRIPOINT_PROXY_SECRET' but it is missing or blank")
    expect(calls).toHaveLength(0)
  })

  it('a partner with no endpoint is a permanent config error, named', async () => {
    const { fetchImpl } = fetchReturning(200, '{}')
    const err = await postToPartner({ ...TARGET, api_endpoint: null }, {}, env, { traceId: 't', timeoutMs: 1000, fetchImpl }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PartnerApiError)
    expect((err as Error).message).toBe('Partner tripoint has no api_endpoint configured')
  })

  it('an HTML answer is flagged, whatever its status, and an unparseable body gives json null', async () => {
    const { fetchImpl } = fetchReturning(403, '<!DOCTYPE html><html><body>blocked</body></html>', { 'content-type': 'text/html' })
    const result = await postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 1000, fetchImpl })
    expect(result.status).toBe(403)
    expect(result.isHtml).toBe(true)
    expect(result.json).toBeNull()
  })

  it('aborts the call at the timeout, so a silent partner surfaces as a thrown abort rather than a hang (L110)', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
    ) as unknown as typeof fetch
    await expect(postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 5, fetchImpl })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

/**
 * #3075: the call's own timer marks the abort it causes as the buyer call's
 * deadline, so the buyer select attempt row it cut short can say so. The error
 * itself is exactly the platform's abort, so the node's outcome_unknown
 * handling, the breaker and every send are unchanged. Only the abort this timer
 * caused is marked: never one from the step's signal, never one that merely
 * says the same words.
 */
describe('postToPartner marks the abort its own timer caused (#3075)', () => {
  afterEach(() => { vi.useRealTimers() })

  const platformAbort = () => new DOMException('The operation was aborted.', 'AbortError')
  const hanging = () => vi.fn((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) return reject(platformAbort())
      init?.signal?.addEventListener('abort', () => reject(platformAbort()), { once: true })
    })
  ) as unknown as typeof fetch

  it('its own timer firing: the same AbortError, marked buyer_call at the call\'s length', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const run = postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, fetchImpl: hanging() }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(20_000)
    const err = await run
    expect(err).toBeInstanceOf(DOMException)
    expect(err).toMatchObject({ name: 'AbortError', message: 'The operation was aborted.' })
    expect(stepTimeoutMarkerOf(err)).toEqual({ timeout_kind: 'buyer_call', timed_out_after_ms: 20_000 })
  })

  it('an abort from the step signal first is not the call\'s timer: unmarked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const step = new AbortController()
    const run = postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, signal: step.signal, fetchImpl: hanging() }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1)
    step.abort()
    const err = await run
    await vi.advanceTimersByTimeAsync(20_000)
    expect(err).toMatchObject({ name: 'AbortError' })
    expect(stepTimeoutMarkerOf(err)).toBeNull()
  })

  it('an abort nobody here caused, with the same words, is unmarked', async () => {
    const fetchImpl = vi.fn(async () => { throw platformAbort() }) as unknown as typeof fetch
    const err = await postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, fetchImpl }).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'AbortError' })
    expect(stepTimeoutMarkerOf(err)).toBeNull()
  })

  it('a dropped connection is a failure, never a timeout', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const err = await postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, fetchImpl }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TypeError)
    expect(stepTimeoutMarkerOf(err)).toBeNull()
  })
})

/**
 * #3080: a call that threw got no answer, and the buyer select attempt says
 * why where the call knows it. Decided from what happened here (our timer
 * fired, our signal was aborted, the fetch itself failed), never from the
 * error's message. The error thrown is the same one, so every caller's
 * handling of it is unchanged.
 */
describe('postToPartner records why a call that threw got no answer (#3080)', () => {
  afterEach(() => { vi.useRealTimers() })

  const platformAbort = () => new DOMException('The operation was aborted.', 'AbortError')
  const hanging = () => vi.fn((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) return reject(platformAbort())
      init?.signal?.addEventListener('abort', () => reject(platformAbort()), { once: true })
    })
  ) as unknown as typeof fetch

  it('its own timer firing: our timer, at the call\'s length', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const run = postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, fetchImpl: hanging() }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(noAnswerOf(await run)).toEqual({ cause: 'our_timer', after_ms: 20_000 })
  })

  it('an abort from the step signal: cancelled, not our timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const step = new AbortController()
    const run = postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, signal: step.signal, fetchImpl: hanging() }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1)
    step.abort()
    const err = await run
    await vi.advanceTimersByTimeAsync(20_000)
    expect(noAnswerOf(err)).toEqual({ cause: 'cancelled' })
  })

  it('an abort from the step signal is a cancel however the fetch reports it, never the connection', async () => {
    const step = new AbortController()
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new TypeError('fetch failed')), { once: true })
    })) as unknown as typeof fetch
    const run = postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, signal: step.signal, fetchImpl }).catch((e: unknown) => e)
    step.abort()
    expect(noAnswerOf(await run)).toEqual({ cause: 'cancelled' })
  })

  it('an abort nobody here caused: cancelled, never a connection failure', async () => {
    const abort = platformAbort()
    const fetchImpl = vi.fn(async () => { throw abort }) as unknown as typeof fetch
    const err = await postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, fetchImpl }).catch((e: unknown) => e)
    expect(err).toBe(abort)
    expect(noAnswerOf(err)).toEqual({ cause: 'cancelled' })
  })

  it('a connection reset: the fetch failed with nothing aborted, so the connection, and the same error is thrown', async () => {
    const reset = new TypeError('fetch failed')
    const fetchImpl = vi.fn(async () => { throw reset }) as unknown as typeof fetch
    const err = await postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, fetchImpl }).catch((e: unknown) => e)
    expect(err).toBe(reset)
    expect(noAnswerOf(err)).toEqual({ cause: 'connection' })
  })

  it('a reset whose message reads like a timeout is still the connection: the words decide nothing', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('The operation timed out') }) as unknown as typeof fetch
    const err = await postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, fetchImpl }).catch((e: unknown) => e)
    expect(noAnswerOf(err)).toEqual({ cause: 'connection' })
  })

  it('a body that cannot be written never reaches the fetch and claims no cause', async () => {
    const { fetchImpl, calls } = fetchReturning(200, '{}')
    const err = await postToPartner(TARGET, { amount: BigInt(1) }, env, { traceId: 't', timeoutMs: 20_000, fetchImpl }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TypeError)
    expect(calls).toHaveLength(0)
    expect(noAnswerOf(err)).toBeNull()
  })

  it('an error postToPartner never saw, or a thrown value that is not an object, has no cause', () => {
    expect(noAnswerOf(new Error('connection reset by peer'))).toBeNull()
    expect(noAnswerOf(platformAbort())).toBeNull()
    expect(noAnswerOf('reset')).toBeNull()
    expect(noAnswerOf(null)).toBeNull()
  })
})

/**
 * #3089: the call's own timer runs until the body is read, so its limit covers
 * the whole answer, connect to last byte. Before, it stopped when the headers
 * arrived, and a buyer that sent headers and then trickled its body was bounded
 * only by whatever the caller wrapped around the call (nothing, for buyer
 * select's live buyer call). A body our timer cuts off is no complete answer:
 * the call throws the abort, marked buyer_call exactly as a timeout before the
 * headers is, so every caller handles it as it already handles that. Every other
 * ending of the body read is what it was.
 */
describe('postToPartner keeps its own timer running until the body is read (#3089)', () => {
  afterEach(() => { vi.useRealTimers() })

  it.each([
    ['a body that honours the abort', true],
    ['a body that ignores the abort', false],
  ] as const)('%s, trickling past the limit, is cut off at it: the abort, marked buyer_call, and no answer by our timer', async (_label, honoursAbort) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { fetchImpl, signals } = tricklingFetch(PAST_THE_LIMIT, 5_000, honoursAbort)
    let settled = false
    const run = postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, fetchImpl }).then(
      (value) => { settled = true; return value },
      (e: unknown) => { settled = true; return e },
    )
    await vi.advanceTimersByTimeAsync(19_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    const err = await run
    expect(err).toMatchObject({ name: 'AbortError' })
    expect(stepTimeoutMarkerOf(err)).toEqual({ timeout_kind: 'buyer_call', timed_out_after_ms: 20_000 })
    expect(noAnswerOf(err)).toEqual({ cause: 'our_timer', after_ms: 20_000 })
    expect(signals[0].aborted).toBe(true)
  })

  it('a body that finishes just inside the limit is the answer, unmarked, and the call is never aborted afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // Four chunks 4,999.75 ms apart: the last byte arrives at 19,999 ms.
    const { fetchImpl, signals } = tricklingFetch(['{"ok"', ':true', ',"id":', '"L1"}'], 4_999.75, true)
    const run = postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, fetchImpl }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(19_999)
    const result = await run
    expect(result).toEqual({ status: 200, text: '{"ok":true,"id":"L1"}', json: { ok: true, id: 'L1' }, isHtml: false, headers: { 'content-type': 'application/json' } })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(signals[0].aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an abort from the step signal during the body read is not our timer: unmarked, and the body read ends as it did before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const step = new AbortController()
    const { fetchImpl } = tricklingFetch(PAST_THE_LIMIT, 5_000, true)
    const run = postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, signal: step.signal, fetchImpl }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(7_000)
    step.abort()
    const result = await run
    await vi.advanceTimersByTimeAsync(30_000)
    // A body read that ends for any reason but our timer leaves the text empty,
    // as it always has: #3089 changes only what our timer cuts off.
    expect(result).toEqual({ status: 200, text: '', json: null, isHtml: false, headers: { 'content-type': 'application/json' } })
    expect(stepTimeoutMarkerOf(result)).toBeNull()
    expect(noAnswerOf(result)).toBeNull()
  })

  it('an abort from the step signal ends a body that ignores it too, never waiting out the trickle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const step = new AbortController()
    const { fetchImpl } = tricklingFetch(PAST_THE_LIMIT, 5_000, false)
    let settled = false
    const run = postToPartner(TARGET, {}, env, { traceId: 't', timeoutMs: 20_000, signal: step.signal, fetchImpl }).then(
      (value) => { settled = true; return value },
      (e: unknown) => { settled = true; return e },
    )
    await vi.advanceTimersByTimeAsync(7_000)
    step.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
    const result = await run
    expect(result).toMatchObject({ status: 200, text: '' })
    expect(stepTimeoutMarkerOf(result)).toBeNull()
  })
})
