/**
 * POST /api/admin/nobody-told-page/drill: send ONE drill page to Better Stack
 * on demand (#1303), so the stored URL and token and the alert they feed can be
 * proven before an outage needs them.
 *
 * Three things matter here. It goes through the same send the real outage
 * uses, with the worker's own secrets. It answers what actually happened, never
 * a blanket ok. And it never touches the IDEMPOTENCY record a real page dedupes
 * on: a drill that wrote `nobody-told-page:all` would hold back a real outage's
 * page for the next hour as already sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/audit')>()
  return { ...actual, writeAuditLog: vi.fn().mockResolvedValue(undefined) }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { BETTER_STACK_ALERT_NAME, NOBODY_TOLD_LINE, NOBODY_TOLD_PAGE_DEADLINE_MS, createNobodyToldPager } from '../../../lib/nobody-told-page'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const URL_ = 'https://s9.us-east-9.betterstackdata.com'
const TOKEN = 'outage-source-token-for-tests'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

/** A KV binding that records every call made on it, whatever the method. */
function recordingKv() {
  const store = new Map<string, string>()
  const calls: string[] = []
  const kv = {
    get: (key: string) => { calls.push(`get ${key}`); return Promise.resolve(store.get(key) ?? null) },
    put: (key: string, value: string) => { calls.push(`put ${key}`); store.set(key, value); return Promise.resolve() },
    delete: (key: string) => { calls.push(`delete ${key}`); store.delete(key); return Promise.resolve() },
    list: () => { calls.push('list'); return Promise.resolve({ keys: [], list_complete: true, cacheStatus: null }) },
    getWithMetadata: (key: string) => { calls.push(`getWithMetadata ${key}`); return Promise.resolve({ value: store.get(key) ?? null, metadata: null, cacheStatus: null }) },
  }
  return { kv, calls, store }
}

function env(overrides: Partial<Env> = {}, kv = recordingKv().kv) {
  return {
    SUPABASE_JWKS_URL: 'https://fake.jwks',
    BETTERSTACK_OUTAGE_TOKEN: TOKEN,
    BETTERSTACK_OUTAGE_URL: URL_,
    IDEMPOTENCY: kv,
    ...overrides,
  } as unknown as Env
}

interface Sent { url: string; body: Record<string, unknown>; auth: string | null }

function stubFetch(mode: number | 'throw' | 'stall') {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, auth: new Headers(init.headers).get('Authorization') })
    if (mode === 'throw') return Promise.reject(new TypeError('fetch failed'))
    if (mode === 'stall') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    return Promise.resolve(new Response(null, { status: mode }))
  })
  return sent
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

describe('POST /admin/nobody-told-page/drill', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: () => ({}),
      rpc: (name: string) =>
        name === 'auth_user_with_allowlist'
          ? Promise.resolve({ data: [{ ...testUser, allowed: true }], error: null })
          : Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } }),
    } as unknown as ReturnType<typeof createSupabaseClient>)
    app = await makeApp()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const post = (e: Env, headers: Record<string, string> = { Authorization: 'Bearer tok' }) =>
    app.request('/admin/nobody-told-page/drill', { method: 'POST', headers }, e, mockCtx)

  it('refuses a caller with no token, sending nothing', async () => {
    const sent = stubFetch(202)
    const res = await post(env(), {})
    expect(res.status).toBe(401)
    expect(sent).toEqual([])
  })

  it('refuses a caller who is not on the access allowlist, sending nothing', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: () => ({}),
      rpc: () => Promise.resolve({ data: [{ ...testUser, allowed: false }], error: null }),
    } as unknown as ReturnType<typeof createSupabaseClient>)
    const sent = stubFetch(202)
    const res = await post(env())
    expect(res.status).toBe(403)
    expect(sent).toEqual([])
  })

  it('sends one drill page with the worker\'s own secrets, carrying the line the alert matches on', async () => {
    const sent = stubFetch(202)
    const res = await post(env())
    expect(res.status).toBe(200)
    expect(await res.json()).toStrictEqual({ ok: true, outcome: 'sent', status: 202, alert: BETTER_STACK_ALERT_NAME })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(URL_)
    expect(sent[0].auth).toBe(`Bearer ${TOKEN}`)
    expect(sent[0].body.message).toBe(NOBODY_TOLD_LINE)
    expect(sent[0].body.reason).toBe('drill')
    expect(sent[0].body.organization_id).toBeNull()
  })

  it('never reads or writes the IDEMPOTENCY record, so a real outage in the next hour still pages', async () => {
    const k = recordingKv()
    stubFetch(202)
    const res = await post(env({}, k.kv), { Authorization: 'Bearer tok' })
    expect(res.status).toBe(200)
    expect(k.calls).toEqual([])

    // The real pager over the same binding, as the next scheduled tick builds it.
    const realSends = stubFetch(202)
    const pager = createNobodyToldPager({ token: TOKEN, url: URL_, kv: k.kv, now: () => 0, delay: () => new Promise<void>(() => {}) })
    await pager.page(null, 'no_copy')
    expect(realSends).toHaveLength(1)
    expect(realSends[0].body.reason).toBe('no_copy')
    // The positive control (L1): the same recorder DOES see the real page's
    // dedupe read and record, on the key a drill's null organization would share.
    expect(k.calls).toEqual(['get nobody-told-page:all', 'put nobody-told-page:all'])
  })

  it('answers refused with Better Stack\'s status', async () => {
    stubFetch(401)
    const res = await post(env())
    expect(res.status).toBe(502)
    expect(await res.json()).toStrictEqual({ ok: false, outcome: 'refused', status: 401, alert: BETTER_STACK_ALERT_NAME })
  })

  it('answers threw with the failure when the send throws', async () => {
    stubFetch('throw')
    const res = await post(env())
    expect(res.status).toBe(502)
    expect(await res.json()).toStrictEqual({ ok: false, outcome: 'threw', error: 'fetch failed', alert: BETTER_STACK_ALERT_NAME })
  })

  it('answers no answer when Better Stack does not answer within the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubFetch('stall')
    const pending = post(env())
    await vi.advanceTimersByTimeAsync(NOBODY_TOLD_PAGE_DEADLINE_MS)
    const res = await pending
    expect(res.status).toBe(504)
    expect(await res.json()).toStrictEqual({ ok: false, outcome: 'no_answer', deadline_ms: NOBODY_TOLD_PAGE_DEADLINE_MS, alert: BETTER_STACK_ALERT_NAME })
  })

  it('answers not configured, naming the unset secret and sending nothing', async () => {
    const sent = stubFetch(202)
    const res = await post(env({ BETTERSTACK_OUTAGE_URL: undefined }))
    expect(res.status).toBe(503)
    expect(await res.json()).toStrictEqual({ ok: false, outcome: 'not_configured', missing: ['BETTERSTACK_OUTAGE_URL'], alert: BETTER_STACK_ALERT_NAME })
    expect(sent).toEqual([])
  })

  it('audits who ran the drill and what came of it, scoped to their organization', async () => {
    stubFetch(401)
    await post(env())
    expect(writeAuditLog).toHaveBeenCalledTimes(1)
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      'org-abc',
      'outage_page',
      BETTER_STACK_ALERT_NAME,
      'outage_page_drilled',
      'dan@pennie.com',
      { outcome: 'refused', status: 401 },
    )
  })

  it('audits a drill that sent nothing because a secret is unset', async () => {
    stubFetch(202)
    await post(env({ BETTERSTACK_OUTAGE_TOKEN: undefined, BETTERSTACK_OUTAGE_URL: undefined }))
    expect(vi.mocked(writeAuditLog).mock.calls[0][6]).toStrictEqual({ outcome: 'not_configured', missing: ['BETTERSTACK_OUTAGE_TOKEN', 'BETTERSTACK_OUTAGE_URL'] })
  })
})
