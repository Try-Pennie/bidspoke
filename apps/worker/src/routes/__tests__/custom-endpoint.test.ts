/**
 * Custom endpoint route error handling (#107): map known errors by type, and
 * return generic messages to external callers instead of echoing raw err.message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { Env } from '../../index'

// executeWorkflow is the only engine call to replace; the runtime helper and the
// error classes stay real so the route's mapping is tested against them.
vi.mock('../../engine/index', async () => {
  const actual = await vi.importActual<typeof import('../../engine/index')>('../../engine/index')
  return { ...actual, executeWorkflow: vi.fn() }
})
vi.mock('../../lib/supabase')

import { executeWorkflow } from '../../engine/index'
import { createSupabaseClient } from '../../lib/supabase'
import { WorkflowNotFoundError } from '../../engine/definition-loader'
import { WorkflowLaneError } from '../../engine/lane'
import { handleCustomEndpoint } from '../custom-endpoint'
import { STORED_COPY_MAX_AGE_MS } from '../../lib/stored-copy-age'

// Empty KV so the handler falls through to the DB lookup.
function makeUncachedEnv(): Env {
  return {
    WORKFLOW_CACHE: { get: async () => null, getWithMetadata: async () => ({ value: null, metadata: null }), put: async () => {}, delete: async () => {} },
    API_KEY_MAP: '{}',
  } as unknown as Env
}

// A Supabase client whose endpoint `.single()` resolves to the given result.
// The query carries retry and abortSignal as the real one does, because the
// route reads the endpoint through leadRead (#1844).
function makeSupabaseReturning(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    single: () => {
      const query = Promise.resolve(result)
      return Object.assign(query, { retry: () => query, abortSignal: () => query })
    },
  }
  return { from: () => chain } as unknown as ReturnType<typeof createSupabaseClient>
}

function postUncached() {
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} }
  return makeApp().request(
    'http://hook.trypennie.dev/tripoint/bidding',
    { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
    makeUncachedEnv(),
    executionCtx as unknown as ExecutionContext
  )
}

// Endpoint seeded into KV so the handler skips the DB lookup; auth_method 'none'
// skips the API-key check.
function makeEnv(): Env {
  const ep = JSON.stringify({ id: 'e1', workflow_id: 'wf-1', source_name: 'tripoint', is_active: true, auth_method: 'none' })
  const store = new Map<string, string>([['ep:tripoint:/bidding', ep]])
  return {
    WORKFLOW_CACHE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async () => {},
      delete: async () => {},
    },
  } as unknown as Env
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>()
  app.all('*', (c) => handleCustomEndpoint(c))
  return app
}

function post() {
  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} }
  return makeApp().request(
    'http://hook.trypennie.dev/tripoint/bidding',
    { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
    makeEnv(),
    executionCtx as unknown as ExecutionContext
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // The route makes its lead client before it knows whether it needs the
  // database, so every test has one; tests that read set their own.
  vi.mocked(createSupabaseClient).mockReturnValue(makeSupabaseReturning({ data: null, error: null }))
})

describe('custom endpoint error mapping (#107)', () => {
  it('returns 404 with a generic message for WorkflowNotFoundError', async () => {
    vi.mocked(executeWorkflow).mockRejectedValue(new WorkflowNotFoundError('wf-1', true))
    const res = await post()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Workflow not found' })
  })

  it('returns 421 for a workflow stored under another lane (#1707)', async () => {
    vi.mocked(executeWorkflow).mockRejectedValue(new WorkflowLaneError('wf-1', 'ops', 'money'))
    const res = await post()
    expect(res.status).toBe(421)
    expect(await res.json()).toEqual({ error: 'Workflow is not served on this host' })
  })

  it('returns 500 (not 404) for an internal error whose message contains "not found"', async () => {
    vi.mocked(executeWorkflow).mockRejectedValue(new Error('partner_bid_config not found: abc'))
    const res = await post()
    expect(res.status).toBe(500)
  })

  it('returns a generic 500 body, never echoing the raw error message', async () => {
    vi.mocked(executeWorkflow).mockRejectedValue(new Error('Database error at 10.0.0.5:5432'))
    const res = await post()
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Internal error')
    expect(body.error).not.toContain('10.0.0.5')
  })
})

// Same 409 pass-through as the generic webhook route (#482). Custom endpoints
// carry live partner traffic, so a duplicate the engine is still processing
// must be rejected with 409, not accepted as 200, and not 500'd into a retry.
describe('custom endpoint in-flight duplicate returns 409 (#482)', () => {
  const duplicate = {
    response: { error: 'Duplicate request in progress' },
    status: 409,
    executionId: 'exec-dup',
    traceId: 'trace-dup',
  }

  it('returns 409 with the engine body when the duplicate is still in flight', async () => {
    vi.mocked(executeWorkflow).mockResolvedValue(duplicate)
    const res = await post()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Duplicate request in progress' })
  })

  it('still sets X-Trace-Id on the 409 so the rejected duplicate is traceable', async () => {
    vi.mocked(executeWorkflow).mockResolvedValue(duplicate)
    const res = await post()
    expect(res.headers.get('X-Trace-Id')).toBe('trace-dup')
  })

  it('does not set X-Idempotent-Replay on the 409', async () => {
    vi.mocked(executeWorkflow).mockResolvedValue(duplicate)
    const res = await post()
    expect(res.headers.get('X-Idempotent-Replay')).toBeNull()
  })
})

describe('custom endpoint lookup failure handling (#303)', () => {
  it('returns 503 (retryable), not 404, on a real DB error during endpoint lookup', async () => {
    // A 404 tells the lead source the endpoint is gone, so it stops retrying and
    // the lead is dropped. A transient DB error must be retryable.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabaseReturning({ data: null, error: { code: '57P01', message: 'db connection lost' } })
    )
    const res = await postUncached()
    expect(res.status).toBe(503)
  })

  it('returns 404 when the endpoint genuinely does not exist (PGRST116 no-rows)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabaseReturning({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    )
    const res = await postUncached()
    expect(res.status).toBe(404)
  })
})

// Lock the remaining lead-facing gates on this custom-endpoint door (#316). A
// corrupt cache or a disabled/unauthorized endpoint must resolve to the right
// status — never silently drop or misroute a live lead.
describe('custom endpoint cache + gate handling (#316)', () => {
  // KV returns the given value for the endpoint cache key; DB lookup is mocked.
  function envWithCache(cachedValue: string | null): Env {
    return {
      WORKFLOW_CACHE: { get: async () => cachedValue, put: async () => {}, delete: async () => {} },
      API_KEY_MAP: '{}',
    } as unknown as Env
  }
  function postTo(env: Env, headers: Record<string, string> = {}) {
    const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} }
    return makeApp().request(
      'http://hook.trypennie.dev/tripoint/bidding',
      { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', ...headers } },
      env,
      executionCtx as unknown as ExecutionContext
    )
  }
  const activeEndpoint = {
    data: {
      id: 'e1', workflow_id: 'wf-1', source_name: 'tripoint', is_active: true,
      workflows: { definition: { trigger: { config: { auth_method: 'none' } } } },
    },
    error: null,
  }

  it('falls through to the DB when the cache entry is corrupt — never fails the lead', async () => {
    // A stale/corrupt KV entry must not error the request; it falls through to
    // the DB and executes normally. Otherwise a bad cache write drops live leads.
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabaseReturning(activeEndpoint))
    vi.mocked(executeWorkflow).mockResolvedValue({
      executionId: 'x', response: { ok: true }, status: 200, traceId: 't', idempotentReplay: false,
    } as Awaited<ReturnType<typeof executeWorkflow>>)
    const res = await postTo(envWithCache('{corrupt-not-json'))
    expect(res.status).toBe(200)
    expect(executeWorkflow).toHaveBeenCalledTimes(1)
  })

  it('returns 404 for a disabled endpoint (permanent — intentionally off)', async () => {
    const ep = JSON.stringify({ id: 'e1', workflow_id: 'wf-1', source_name: 'tripoint', is_active: false, auth_method: 'none' })
    const res = await postTo(envWithCache(ep))
    expect(res.status).toBe(404)
    expect(executeWorkflow).not.toHaveBeenCalled()
  })

  it('returns 401 when an api_key endpoint is hit without an X-API-Key header', async () => {
    const ep = JSON.stringify({ id: 'e1', workflow_id: 'wf-1', source_name: 'tripoint', is_active: true, auth_method: 'api_key' })
    const res = await postTo(envWithCache(ep))
    expect(res.status).toBe(401)
    expect(executeWorkflow).not.toHaveBeenCalled()
  })

  // #1702: the key map is a plain object, so a bracket lookup also finds the
  // members every object inherits. Each of these names passed auth on a live
  // partner endpoint and ran its workflow without any real key.
  describe('a key that only exists on Object.prototype is refused (#1702)', () => {
    const apiKeyEndpoint = JSON.stringify({ id: 'e1', workflow_id: 'wf-1', source_name: 'tripoint', is_active: true, auth_method: 'api_key' })
    function envWithKeys(): Env {
      return { ...envWithCache(apiKeyEndpoint), API_KEY_MAP: JSON.stringify({ sk_real_key: 'tripoint' }) } as unknown as Env
    }

    it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'])(
      'answers 401 and runs nothing for X-API-Key: %s',
      async (name) => {
        const res = await postTo(envWithKeys(), { 'X-API-Key': name })
        expect(res.status).toBe(401)
        expect(await res.json()).toEqual({ error: 'Invalid API key' })
        expect(executeWorkflow).not.toHaveBeenCalled()
      }
    )

    it('still accepts a key the map really holds', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        executionId: 'x', response: { ok: true }, status: 200, traceId: 't', idempotentReplay: false,
      } as Awaited<ReturnType<typeof executeWorkflow>>)
      const res = await postTo(envWithKeys(), { 'X-API-Key': 'sk_real_key' })
      expect(res.status).toBe(200)
      expect(executeWorkflow).toHaveBeenCalledTimes(1)
    })
  })
})

// A database outage must not refuse leads whose endpoint record we have already
// seen (#1296). On 2026-09-10 Supabase was unresponsive for ten minutes; the
// 60 second cache expired within a minute and every Engine lead got a 503 while
// the workflow definition and env vars were sitting in KV the whole time.
describe('custom endpoint serves the last-good record during a DB outage (#1296)', () => {
  const dbDown = { data: null, error: { code: '57P01', message: 'db connection lost' } }
  const activeEndpoint = {
    data: {
      id: 'e1', workflow_id: 'wf-1', source_name: 'tripoint', is_active: true,
      workflows: { definition: { trigger: { config: { auth_method: 'none' } } } },
    },
    error: null,
  }

  // A KV double that records every put, including its options, so the test can
  // assert which key carried a TTL and which did not.
  // A seed is a bare value (a copy written before #1847, with no confirmation)
  // or a value with the metadata its put carried.
  type Seed = string | { value: string; metadata: unknown }
  function recordingKv(seed: Record<string, Seed> = {}) {
    const store = new Map<string, { value: string; metadata: unknown }>(
      Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? { value: v, metadata: null } : v]),
    )
    const puts: { key: string; value: string; opts?: { expirationTtl?: number; metadata?: unknown } }[] = []
    const deletes: string[] = []
    return {
      puts,
      deletes,
      kv: {
        get: async (k: string) => store.get(k)?.value ?? null,
        getWithMetadata: async (k: string) => store.get(k) ?? { value: null, metadata: null },
        put: async (k: string, v: string, opts?: { expirationTtl?: number; metadata?: unknown }) => { store.set(k, { value: v, metadata: opts?.metadata ?? null }); puts.push({ key: k, value: v, opts }) },
        delete: async (k: string) => { store.delete(k); deletes.push(k) },
      },
    }
  }
  /** The copy as a healthy lookup `ageMs` ago left it. */
  const confirmedCopy = (ageMs = 0): Seed => ({ value: lastGood, metadata: { confirmed_at: new Date(Date.now() - ageMs).toISOString() } })
  function postWith(kv: unknown) {
    const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} }
    return makeApp().request(
      'http://hook.trypennie.dev/tripoint/bidding',
      { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
      { WORKFLOW_CACHE: kv, API_KEY_MAP: '{}' } as unknown as Env,
      executionCtx as unknown as ExecutionContext
    )
  }
  const lastGood = JSON.stringify({ id: 'e1', workflow_id: 'wf-1', source_name: 'tripoint', is_active: true, auth_method: 'none' })

  it('executes the workflow from the last-good record when the DB lookup fails', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabaseReturning(dbDown))
    vi.mocked(executeWorkflow).mockResolvedValue({
      executionId: 'x', response: { ok: true }, status: 200, traceId: 't', idempotentReplay: false,
    } as Awaited<ReturnType<typeof executeWorkflow>>)
    const { kv } = recordingKv({ 'ep-lastgood:tripoint:/bidding': confirmedCopy(60_000) })
    const res = await postWith(kv)
    expect(res.status).toBe(200)
    expect(executeWorkflow).toHaveBeenCalledTimes(1)
    expect(vi.mocked(executeWorkflow).mock.calls[0][0]).toMatchObject({ workflowId: 'wf-1', source: 'tripoint' })
  })

  it('still answers 503 when the DB lookup fails and there is no last-good record', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabaseReturning(dbDown))
    const { kv } = recordingKv()
    const res = await postWith(kv)
    expect(res.status).toBe(503)
    expect(executeWorkflow).not.toHaveBeenCalled()
  })

  // #1847: a copy is served for at most thirty minutes after a healthy lookup
  // last confirmed it, and a copy that cannot say when that was is refused too.
  it.each([
    ['last confirmed more than thirty minutes ago', () => confirmedCopy(STORED_COPY_MAX_AGE_MS + 1_000), 'copy_too_old'],
    ['written before copies carried a confirmation time', () => lastGood, 'copy_age_unknown'],
  ] as const)('answers 503 and names the refusal when the copy was %s', async (_label, seed, reason) => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')) })
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabaseReturning(dbDown))
    const { kv } = recordingKv({ 'ep-lastgood:tripoint:/bidding': seed() })
    const res = await postWith(kv)
    expect(res.status).toBe(503)
    expect(executeWorkflow).not.toHaveBeenCalled()
    const refused = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.event === 'stored_copy_refused')
    expect(refused).toEqual([expect.objectContaining({ copy: 'custom_endpoint', subject: 'tripoint/bidding', reason })])
  })

  it('answers 503, not 500, when KV fails too while reading the copy', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')) })
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabaseReturning(dbDown))
    const { kv } = recordingKv()
    const res = await postWith({ ...kv, getWithMetadata: async () => { throw new Error('kv unavailable') } })
    expect(res.status).toBe(503)
    expect(lines.join('\n')).toContain('could not be read: kv unavailable')
  })

  it('does not serve a last-good record for a genuinely missing endpoint (PGRST116 stays 404)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabaseReturning({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    )
    const { kv } = recordingKv({ 'ep-lastgood:tripoint:/bidding': lastGood })
    const res = await postWith(kv)
    expect(res.status).toBe(404)
    expect(executeWorkflow).not.toHaveBeenCalled()
  })

  // #1846. The endpoint routes retire this copy after their write lands, but a
  // lead that read the row just BEFORE a delete can write the copy just AFTER the
  // retire. Nothing would ever rewrite it, because a missing endpoint is never
  // looked up successfully again, so the first lookup that finds it gone removes it.
  it('removes a copy that outlived its endpoint when the lookup finds the endpoint gone', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabaseReturning({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    )
    const { kv } = recordingKv({ 'ep-lastgood:tripoint:/bidding': lastGood })
    const res = await postWith(kv)
    expect(res.status).toBe(404)
    expect(await kv.get('ep-lastgood:tripoint:/bidding')).toBeNull()
  })

  // The removal is a tidy up beside the answer: KV failing there must not turn
  // a truthful 404 into a 500 that tells the source to retry.
  it('still answers 404 when KV fails while removing the copy of a missing endpoint', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabaseReturning({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    )
    // The hot copy read before the lookup succeeds (a miss); the removal is what fails.
    const kv = {
      get: async (k: string) => {
        if (k.startsWith('ep-lastgood:')) throw new Error('kv unavailable')
        return null
      },
      put: async () => {},
      delete: async () => { throw new Error('kv unavailable') },
    }
    const res = await postWith(kv)
    expect(res.status).toBe(404)
    expect(errSpy.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining('could not remove the last-good copy of missing endpoint tripoint/bidding'))
  })

  // Anyone can probe a made up path, so a lookup that finds nothing must not
  // spend a KV write when there is no copy to remove.
  it('spends no KV write on a missing endpoint that never had a copy', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabaseReturning({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    )
    const { kv, puts, deletes } = recordingKv()
    const res = await postWith(kv)
    expect(res.status).toBe(404)
    expect(puts).toEqual([])
    expect(deletes).toEqual([])
  })

  it('writes the last-good copy without a TTL on every successful DB lookup, beside the 60s hot copy', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(makeSupabaseReturning(activeEndpoint))
    vi.mocked(executeWorkflow).mockResolvedValue({
      executionId: 'x', response: { ok: true }, status: 200, traceId: 't', idempotentReplay: false,
    } as Awaited<ReturnType<typeof executeWorkflow>>)
    const { kv, puts } = recordingKv()
    const res = await postWith(kv)
    expect(res.status).toBe(200)
    const hot = puts.find((p) => p.key === 'ep:tripoint:/bidding')
    const durable = puts.find((p) => p.key === 'ep-lastgood:tripoint:/bidding')
    expect(hot?.opts?.expirationTtl).toBe(60)
    expect(durable).toBeDefined()
    expect(durable?.opts?.expirationTtl).toBeUndefined()
    // Stamped as confirmed now, so an outage can tell how old it is (#1847).
    const stamp = Date.parse((durable?.opts?.metadata as { confirmed_at?: string } | undefined)?.confirmed_at ?? '')
    expect(Math.abs(Date.now() - stamp)).toBeLessThan(5_000)
    expect(JSON.parse(durable!.value)).toMatchObject({ workflow_id: 'wf-1', source_name: 'tripoint', is_active: true })
  })
})
