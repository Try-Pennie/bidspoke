/**
 * postToPartner (#1411): the one outbound POST to a partner, shared by the bid
 * resolver's API call and the buyer_select node's sale attempt. The credential
 * rule, the trace header and the body are the resolver's; the timeout is the
 * caller's. No network here: the fetch is injected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../index'
import { PartnerApiError } from '../../engine/partner-bid-error'
import { postToPartner } from '../post-to-partner'
import { stepTimeoutMarkerOf } from '../../engine/step-timeout'

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
