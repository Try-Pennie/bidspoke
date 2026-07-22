/**
 * Salesforce node
 * Tests: token fetch + cache, each operation type, template resolution, CF secrets
 * merge, 401 evicts cache, non-2xx throws Response, 204 No Content handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeSalesforceNode, SF_QUERY_PAGE_CAP } from '../salesforce'
import { classifyStepError } from '../../error-classifier'
import { stubFetch, type FetchMock } from '../../../__tests__/helpers/fetch-mock'
import type { NodeDefinition, ExecutionContext } from '../../../types'
import type { Env } from '../../../index'

// ── Helpers ───────────────────────────────────────────────────────────────────

const INSTANCE = 'https://trypennie.my.salesforce.com'

function makeNode(config: Record<string, unknown>): NodeDefinition {
  return { id: 'sf1', namespace: 'create_prospect', type: 'salesforce', config }
}

function makeCtx(overrides: { env?: Record<string, string>; steps?: Record<string, unknown>; orgId?: string; executionId?: string | undefined } = {}): ExecutionContext {
  const stepMap: ExecutionContext['steps'] = {}
  for (const [ns, output] of Object.entries(overrides.steps ?? {})) {
    stepMap[ns] = { output, status: 'completed' }
  }
  const executionId = 'executionId' in overrides ? overrides.executionId : 'exec-1'
  const bidspokeLink = executionId ? `https://bidspoke.trypennie.dev/workflows/wf-1?execution=${executionId}` : undefined
  return {
    trigger: {
      payload: { leadUuid: 'lead-123', firstName: 'John' },
      source: 'test',
      workflow_id: 'wf-1',
      org_id: overrides.orgId ?? 'org-1',
      trace_id: 'tr-1',
      execution_id: executionId,
    },
    steps: stepMap,
    env: overrides.env ?? {
      SALESFORCE_CLIENT_ID: 'client-id',
      SALESFORCE_CLIENT_SECRET: 'client-secret',
      SALESFORCE_INSTANCE_URL: INSTANCE,
    },
    execution: { workflow_id: 'wf-1', trace_id: 'tr-1', execution_id: executionId, bidspoke_link: bidspokeLink },
  } as unknown as ExecutionContext
}

function makeEnv(secrets: Record<string, string> = {}): Env {
  return {
    WORKFLOW_CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
    DAILY_CAP: {} as DurableObjectNamespace,
    SALESFORCE_CLIENT_ID: 'client-id',
    SALESFORCE_CLIENT_SECRET: 'client-secret',
    SALESFORCE_INSTANCE_URL: INSTANCE,
    APP_URL: 'https://bidspoke.trypennie.dev',
    ...secrets,
  } as unknown as Env
}

function mockResponse(status: number, body: string) {
  let parsed: unknown = null
  if (body) {
    try { parsed = JSON.parse(body) } catch { parsed = body }
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(parsed),
    headers: new Headers({ 'content-type': 'application/json' }),
  }
}

function mockTokenResponse() {
  return mockResponse(200, JSON.stringify({ access_token: 'sf-token-abc' }))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeSalesforceNode', () => {
  let fetchMock: FetchMock

  beforeEach(() => {
    fetchMock = stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ── Config validation ───────────────────────────────────────────────────────

  it('throws when required Salesforce env vars are missing', async () => {
    const ctx = makeCtx({ env: {} })
    const bareEnv = {
      WORKFLOW_CACHE: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn(),
        delete: vi.fn(),
      } as unknown as KVNamespace,
    } as unknown as Env
    await expect(executeSalesforceNode(makeNode({ operation: 'create', object: 'Prospect__c' }), ctx, bareEnv))
      .rejects.toThrow()
  })

  // #66: a step-level timeout must cancel the Salesforce write (double DML is
  // harmful). With a pre-aborted parent signal, the write fetch's signal is
  // aborted via linkAbort. Reverting that wiring fails this.
  it('cancels the write fetch when the step-level signal aborts (#66)', async () => {
    const signals: (AbortSignal | undefined)[] = []
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined)
      return Promise.resolve(signals.length === 1 ? mockTokenResponse() : mockResponse(201, '{"id":"X"}'))
    })
    const parent = new AbortController()
    parent.abort()
    await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: {} }),
      makeCtx(), makeEnv(), parent.signal
    )
    expect(signals[1]?.aborted).toBe(true) // the write call carries the aborted signal
  })

  // #312: when the Salesforce bulkhead stays at capacity past the wait budget,
  // the node sheds WITHOUT calling the Salesforce operation. Only the token fetch
  // happens; the write is shed. WAIT_MS=0 gives the old one-shot behavior so
  // this test exercises the shed path without real sleeps.
  //
  // The shed is retryable, NOT permanent: a shed request never touched Salesforce
  // (it was refused at our own gate), so withRetry re-entering the gate on a
  // later attempt adds zero SF load and rides out a brief slowdown instead of
  // dropping the lead. It must classify transient and must not look permanent.
  it('sheds with a RETRYABLE (transient, not permanent) error when the bulkhead is at capacity (#312)', async () => {
    fetchMock.mockResolvedValueOnce(mockTokenResponse())
    const acquire = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ allowed: false, inflight: 20, limit: 20 })),
    )
    const env = makeEnv({ SALESFORCE_BULKHEAD_WAIT_MS: '0' })
    ;(env as unknown as { SALESFORCE_BULKHEAD: unknown }).SALESFORCE_BULKHEAD = {
      idFromName: vi.fn().mockReturnValue('id'),
      get: vi.fn().mockReturnValue({ fetch: acquire }),
    }
    let caught: (Error & { permanent?: boolean }) | undefined
    await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: {} }),
      makeCtx(),
      env,
    ).catch((e: Error & { permanent?: boolean }) => { caught = e })

    expect(caught?.message).toMatch(/bulkhead: at capacity/)
    expect(caught?.permanent).toBeUndefined()
    expect(classifyStepError(caught)).toBe('transient')
    expect(acquire).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1) // token fetch only — the write was shed
  })

  // Burst tolerance: a lead arriving during a brief saturation spike waits for a
  // slot instead of dying (16 live leads were shed 2026-07-01..07-03 during
  // bursts that cleared within a minute). Capacity frees on the second poll and
  // the write proceeds normally.
  it('waits out a transient at-capacity burst and completes the call', async () => {
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockResponse(201, '{"id":"SF-001"}'))
    let polls = 0
    const acquire = vi.fn((url: string) => {
      if (new URL(url).pathname === '/acquire') {
        polls++
        const body = polls >= 2
          ? { allowed: true, token: 't-1', inflight: 20, limit: 20 }
          : { allowed: false, inflight: 20, limit: 20 }
        return Promise.resolve(new Response(JSON.stringify(body)))
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true })))
    })
    // Small real budget keeps the test fast; the poll interval clamps below it.
    const env = makeEnv({ SALESFORCE_BULKHEAD_WAIT_MS: '80' })
    ;(env as unknown as { SALESFORCE_BULKHEAD: unknown }).SALESFORCE_BULKHEAD = {
      idFromName: vi.fn().mockReturnValue('id'),
      get: vi.fn().mockReturnValue({ fetch: acquire }),
    }
    const result = await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: {} }),
      makeCtx(),
      env,
    )
    expect(polls).toBeGreaterThanOrEqual(2)
    expect((result.output as { body: { id: string } }).body.id).toBe('SF-001')
    expect(fetchMock).toHaveBeenCalledTimes(2) // token + the write went through
  })

  // ── Token fetch + cache ─────────────────────────────────────────────────────

  it('fetches a new token on cache miss and stores it', async () => {
    const env = makeEnv()
    fetchMock
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockResponse(201, '{"id":"SF-001"}'))

    await executeSalesforceNode(makeNode({ operation: 'create', object: 'Prospect__c', body: {} }), makeCtx(), env)

    const tokenCall = fetchMock.mock.calls[0]
    expect(tokenCall[0]).toContain('/services/oauth2/token')
    // body is a URLSearchParams object; toString() gives query-string format
    expect((tokenCall[1].body as URLSearchParams).get('grant_type')).toBe('client_credentials')
    expect(vi.mocked(env.WORKFLOW_CACHE.put)).toHaveBeenCalledWith(
      'sf-token-org-1',
      'sf-token-abc',
      { expirationTtl: 3500 }
    )
  })

  it('uses cached token without re-fetching', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('cached-token')
    fetchMock.mockResolvedValue(mockResponse(201, '{"id":"SF-001"}'))

    await executeSalesforceNode(makeNode({ operation: 'create', object: 'Prospect__c', body: {} }), makeCtx(), env)

    // Only one fetch (the actual SF call), no token fetch
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('/sobjects/')
  })

  // ── create ──────────────────────────────────────────────────────────────────

  it('create: POSTs to /sobjects/{Object} and returns status + body', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(201, '{"id":"SF-123","success":true}'))

    const { output } = await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: { First_Name__c: 'John' } }),
      makeCtx(),
      env
    )

    expect(fetchMock.mock.calls[0][0]).toBe(`${INSTANCE}/services/data/v60.0/sobjects/Prospect__c`)
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
    expect((output as { status: number }).status).toBe(201)
    expect((output as { body: { id: string } }).body.id).toBe('SF-123')
  })

  // ── update ──────────────────────────────────────────────────────────────────

  it('update: PATCHes to /sobjects/{Object}/{id}', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(204, ''))

    const { output } = await executeSalesforceNode(
      makeNode({ operation: 'update', object: 'Prospect__c', record_id: 'SF-999', body: { Status__c: 'Active' } }),
      makeCtx(),
      env
    )

    expect(fetchMock.mock.calls[0][0]).toBe(`${INSTANCE}/services/data/v60.0/sobjects/Prospect__c/SF-999`)
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH')
    expect((output as { body: null }).body).toBeNull()
  })

  it('update: throws when record_id is missing', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    await expect(
      executeSalesforceNode(makeNode({ operation: 'update', object: 'Prospect__c', body: {} }), makeCtx(), env)
    ).rejects.toThrow('record_id')
  })

  // ── upsert ──────────────────────────────────────────────────────────────────

  it('upsert: PATCHes to /sobjects/{Object}/{extField}/{extValue}', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(201, '{"id":"SF-new","created":true}'))

    await executeSalesforceNode(
      makeNode({ operation: 'upsert', object: 'Prospect__c', external_id_field: 'LeadUUID__c', external_id_value: 'uuid-123', body: {} }),
      makeCtx(),
      env
    )

    expect(fetchMock.mock.calls[0][0]).toBe(`${INSTANCE}/services/data/v60.0/sobjects/Prospect__c/LeadUUID__c/uuid-123`)
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH')
  })

  it('upsert: throws when external_id_field or external_id_value is missing', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    await expect(
      executeSalesforceNode(makeNode({ operation: 'upsert', object: 'Prospect__c', external_id_field: 'LeadUUID__c', body: {} }), makeCtx(), env)
    ).rejects.toThrow('external_id_value')
  })

  // ── query ───────────────────────────────────────────────────────────────────

  it('query: GETs /query?q=... with no request body', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(200, '{"records":[{"Id":"SF-1"}]}'))

    await executeSalesforceNode(
      makeNode({ operation: 'query', soql: 'SELECT Id FROM Prospect__c WHERE LeadUUID__c = \'abc\'' }),
      makeCtx(),
      env
    )

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/query?q=')
    expect(url).toContain(encodeURIComponent('SELECT Id'))
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined()
  })

  it('query: follows nextRecordsUrl and merges every page (#509)', async () => {
    // Salesforce caps a query at ~2000 records and hands back done:false plus a
    // nextRecordsUrl. We used to return page 1 and call it the whole result set:
    // silent truncation, so "no matching record" could just mean "page 2".
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock
      .mockResolvedValueOnce(mockResponse(200, JSON.stringify({
        totalSize: 3, done: false, nextRecordsUrl: '/services/data/v60.0/query/01g-2000',
        records: [{ Id: 'SF-1' }],
      })))
      .mockResolvedValueOnce(mockResponse(200, JSON.stringify({
        totalSize: 3, done: false, nextRecordsUrl: '/services/data/v60.0/query/01g-4000',
        records: [{ Id: 'SF-2' }],
      })))
      .mockResolvedValueOnce(mockResponse(200, JSON.stringify({
        totalSize: 3, done: true, records: [{ Id: 'SF-3' }],
      })))

    const res = await executeSalesforceNode(
      makeNode({ operation: 'query', soql: 'SELECT Id FROM Prospect__c' }),
      makeCtx(),
      env
    )

    const body = (res.output as { body: { records: unknown[]; done: boolean; totalSize: number } }).body
    expect(body.records).toEqual([{ Id: 'SF-1' }, { Id: 'SF-2' }, { Id: 'SF-3' }])
    expect(body.done).toBe(true)
    expect(body.totalSize).toBe(3)
    // Follow-up pages are absolute-ised against the instance URL.
    expect(fetchMock.mock.calls[1][0]).toBe(`${INSTANCE}/services/data/v60.0/query/01g-2000`)
    expect(fetchMock.mock.calls[2][0]).toBe(`${INSTANCE}/services/data/v60.0/query/01g-4000`)
  })

  it('query: does not fetch again when the first page is already done', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(200, JSON.stringify({
      totalSize: 1, done: true, records: [{ Id: 'SF-1' }],
    })))

    await executeSalesforceNode(
      makeNode({ operation: 'query', soql: 'SELECT Id FROM Prospect__c' }),
      makeCtx(),
      env
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('query: stops at the page cap and says so LOUDLY rather than truncating in silence', async () => {
    // The failure this whole fix exists to prevent is a partial result that looks
    // complete. If we bail at the cap we must not pretend the set is whole.
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    // Never-ending pagination: every page says there is another.
    fetchMock.mockResolvedValue(mockResponse(200, JSON.stringify({
      totalSize: 99999, done: false, nextRecordsUrl: '/services/data/v60.0/query/01g-more',
      records: [{ Id: 'SF-x' }],
    })))

    const res = await executeSalesforceNode(
      makeNode({ operation: 'query', soql: 'SELECT Id FROM Prospect__c' }),
      makeCtx(),
      env
    )

    expect(fetchMock.mock.calls.length).toBe(SF_QUERY_PAGE_CAP)
    const body = (res.output as { body: { done: boolean; truncated?: boolean } }).body
    expect(body.done).toBe(false)
    expect(body.truncated).toBe(true)
    // and it must be visible in the step log, not just a console line
    expect(res.logs?.some((l) => l.level === 'warn' && /truncat/i.test(l.message))).toBe(true)
  })

  it('query: a failing follow-up page fails the step instead of returning a partial set', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock
      .mockResolvedValueOnce(mockResponse(200, JSON.stringify({
        totalSize: 2, done: false, nextRecordsUrl: '/services/data/v60.0/query/01g-2000',
        records: [{ Id: 'SF-1' }],
      })))
      .mockResolvedValueOnce(mockResponse(500, '{"message":"boom"}'))

    await expect(
      executeSalesforceNode(
        makeNode({ operation: 'query', soql: 'SELECT Id FROM Prospect__c' }),
        makeCtx(),
        env
      )
    ).rejects.toThrow(/Salesforce/)
  })

  // ── apex ────────────────────────────────────────────────────────────────────

  it('apex: POSTs to the custom apex_path', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(200, '{"ok":true}'))

    await executeSalesforceNode(
      makeNode({ operation: 'apex', apex_path: '/services/apexrest/prospect-trades', body: { prospectId: 'SF-1' } }),
      makeCtx(),
      env
    )

    expect(fetchMock.mock.calls[0][0]).toBe(`${INSTANCE}/services/apexrest/prospect-trades`)
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
  })

  it('apex: GETs with no body when apex_method is "GET", query string included as-is', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(200, '{"IsActive":true}'))

    await executeSalesforceNode(
      makeNode({ operation: 'apex', apex_method: 'GET', apex_path: '/services/apexrest/custommdt/bid?name=Lead_Economy' }),
      makeCtx(),
      env
    )

    expect(fetchMock.mock.calls[0][0]).toBe(`${INSTANCE}/services/apexrest/custommdt/bid?name=Lead_Economy`)
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined()
  })

  // ── Template resolution ─────────────────────────────────────────────────────

  it('resolves {{trigger.payload.*}} in body', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(201, '{"id":"SF-1"}'))

    await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: { uuid: '{{trigger.payload.leadUuid}}' } }),
      makeCtx(),
      env
    )

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sent.uuid).toBe('lead-123')
  })

  it('resolves {{steps.*}} in record_id', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(204, ''))

    const ctx = makeCtx({ steps: { create_prospect: { id: 'SF-from-step' } } })
    await executeSalesforceNode(
      makeNode({ operation: 'update', object: 'Prospect__c', record_id: '{{steps.create_prospect.id}}', body: {} }),
      ctx,
      env
    )

    expect(fetchMock.mock.calls[0][0]).toContain('SF-from-step')
  })

  it('resolves {{env.*}} from CF secret bindings', async () => {
    const env = makeEnv({ TRIPOINT_PROXY_SECRET: 'secret-val' })
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(201, '{"id":"SF-1"}'))

    await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: { secret: '{{env.TRIPOINT_PROXY_SECRET}}' } }),
      makeCtx(),
      env
    )

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sent.secret).toBe('secret-val')
  })

  // #474: platform master secrets must NOT resolve in {{env.*}} templates. A
  // workflow author could otherwise put {{env.SUPABASE_SECRET_KEY}} in a field and
  // exfiltrate a key that bypasses RLS. SF/partner creds (SALESFORCE_*, TRIPOINT_*)
  // are NOT on the blocklist so they still resolve (covered by the test above).
  it('does NOT resolve a blocked master secret into the SF body (#474)', async () => {
    const env = makeEnv({ SECRET_ENCRYPTION_KEY: 'master-secret-value' })
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(201, '{"id":"SF-1"}'))

    await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: { leaked: '{{env.SECRET_ENCRYPTION_KEY}}' } }),
      makeCtx(),
      env
    )

    const sent = fetchMock.mock.calls[0][1]
    expect(JSON.parse(sent.body as string).leaked).not.toBe('master-secret-value')
    expect(JSON.stringify(sent)).not.toContain('master-secret-value')
  })

  // ── 401 token eviction ──────────────────────────────────────────────────────

  it('evicts sf-token-{orgId} from KV cache on 401 response', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('expired-token')
    fetchMock.mockResolvedValue(mockResponse(401, 'Unauthorized'))

    const err = await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: {} }),
      makeCtx(),
      env
    ).catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('401')
    expect((err as Error).message).toContain('Unauthorized')
    expect(vi.mocked(env.WORKFLOW_CACHE.delete as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('sf-token-org-1')
  })

  // ── Non-2xx throws readable Error ───────────────────────────────────────────

  it('throws an Error with status and body on 4xx so the UI can show the real SF error', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(400, '{"message":"Bad request"}'))

    const err = await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: {} }),
      makeCtx(),
      env
    ).catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('400')
    expect((err as Error).message).toContain('Bad request')
  })

  it('throws an Error on 5xx with the response body included', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(503, 'Service Unavailable'))

    const err = await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: {} }),
      makeCtx(),
      env
    ).catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('503')
    expect((err as Error).message).toContain('Service Unavailable')
  })

  it('logs cf-ray + server headers on a 5xx so a 520 is diagnosable (#331)', async () => {
    // A 520 is a Cloudflare-edge timeout; cf-ray/server tell us whether the
    // failure is CF-edge or Salesforce-origin, and give a traceable ray id.
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue({
      ok: false,
      status: 520,
      text: () => Promise.resolve('error code: 520'),
      json: () => Promise.resolve(null),
      headers: new Headers({ 'cf-ray': '8abc123-EWR', server: 'cloudflare' }),
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: {} }),
      makeCtx(),
      env
    ).catch(() => {})
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    logSpy.mockRestore()
    expect(logged).toContain('cf-ray=8abc123-EWR')
    expect(logged).toContain('server=cloudflare')
  })

  // ── Retry classification: permanent vs transient ───────────────────────────

  it.each([400, 401, 403, 404, 422])('marks %i as permanent so the engine skips retry', async (status) => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(status, '{"message":"err"}'))

    const err = await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: {} }),
      makeCtx(),
      env
    ).catch((e) => e)

    expect((err as Error & { permanent?: boolean }).permanent).toBe(true)
  })

  it.each([429, 500, 502, 503, 504])('leaves %i as transient so the engine retries', async (status) => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(status, 'oops'))

    const err = await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: {} }),
      makeCtx(),
      env
    ).catch((e) => e)

    expect((err as Error & { permanent?: boolean }).permanent).toBeUndefined()
  })

  // ── transient_errors: per-node opt-in retry for matching 4xx errors ────────

  it('transient_errors: matching errorCode + message_contains marks 403 as transient', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(403, JSON.stringify([{
      message: 'ConcurrentPerOrgLongTxn Limit exceeded.',
      errorCode: 'REQUEST_LIMIT_EXCEEDED',
    }])))

    const err = await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: {},
        transient_errors: [{ code: 'REQUEST_LIMIT_EXCEEDED', message_contains: 'Concurrent' }],
      }),
      makeCtx(),
      env
    ).catch((e) => e)

    expect((err as Error & { permanent?: boolean }).permanent).toBeUndefined()
  })

  it('transient_errors: errorCode match with no message_contains matches any message', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(403, JSON.stringify([{
      message: 'TotalRequests Limit exceeded.',
      errorCode: 'REQUEST_LIMIT_EXCEEDED',
    }])))

    const err = await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: {},
        transient_errors: [{ code: 'REQUEST_LIMIT_EXCEEDED' }],
      }),
      makeCtx(),
      env
    ).catch((e) => e)

    expect((err as Error & { permanent?: boolean }).permanent).toBeUndefined()
  })

  it('transient_errors: message_contains mismatch keeps the error permanent', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(403, JSON.stringify([{
      message: 'TotalRequests Limit exceeded.',
      errorCode: 'REQUEST_LIMIT_EXCEEDED',
    }])))

    const err = await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: {},
        transient_errors: [{ code: 'REQUEST_LIMIT_EXCEEDED', message_contains: 'Concurrent' }],
      }),
      makeCtx(),
      env
    ).catch((e) => e)

    expect((err as Error & { permanent?: boolean }).permanent).toBe(true)
  })

  it('transient_errors: errorCode mismatch keeps the error permanent', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(400, JSON.stringify([{
      message: 'Something else',
      errorCode: 'INVALID_FIELD',
    }])))

    const err = await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: {},
        transient_errors: [{ code: 'REQUEST_LIMIT_EXCEEDED', message_contains: 'Concurrent' }],
      }),
      makeCtx(),
      env
    ).catch((e) => e)

    expect((err as Error & { permanent?: boolean }).permanent).toBe(true)
  })

  it('transient_errors: empty/unset list preserves default 4xx → permanent behavior', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(403, JSON.stringify([{
      message: 'ConcurrentPerOrgLongTxn Limit exceeded.',
      errorCode: 'REQUEST_LIMIT_EXCEEDED',
    }])))

    const err = await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: {} }),
      makeCtx(),
      env
    ).catch((e) => e)

    // No transient_errors configured → 403 stays permanent (engine-side default
    // is intentionally absent; pre-population lives in the UI mount-effect).
    expect((err as Error & { permanent?: boolean }).permanent).toBe(true)
  })

  // ── expected_errors with custom response shape ─────────────────────────────

  it('expected_error with response_body returns earlyResponse + earlyExit', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    const sfError = JSON.stringify([{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'A Prospect with this Social Security Number was created in the last 60 days. Creation is blocked.' }])
    fetchMock.mockResolvedValue(mockResponse(400, sfError))

    const result = await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: {},
        expected_errors: [{
          code: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
          message_contains: 'Social Security Number was created in the last 60 days',
          response_status: 200,
          response_body: { lead_id: '{{trigger.payload.leadUuid}}', status: 'rejected', reason: 'duplicated lead' },
        }],
      }),
      makeCtx(),
      env
    )

    expect(result.earlyExit).toBe(true)
    expect(result.earlyResponse).toEqual({
      status: 200,
      body: { lead_id: 'lead-123', status: 'rejected', reason: 'duplicated lead' },
    })
  })

  it('expected_error without response_body returns bare earlyExit (legacy behavior)', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    const sfError = JSON.stringify([{ errorCode: 'DUPLICATE_VALUE', message: 'whatever' }])
    fetchMock.mockResolvedValue(mockResponse(400, sfError))

    const result = await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: {},
        expected_errors: [{ code: 'DUPLICATE_VALUE' }],
      }),
      makeCtx(),
      env
    )

    expect(result.earlyExit).toBe(true)
    expect(result.earlyResponse).toBeUndefined()
    expect((result.output as { errorCode: string }).errorCode).toBe('DUPLICATE_VALUE')
  })

  // ── 204 No Content ──────────────────────────────────────────────────────────

  it('returns null body for 204 No Content', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(204, ''))

    const { output } = await executeSalesforceNode(
      makeNode({ operation: 'update', object: 'Prospect__c', record_id: 'SF-1', body: {} }),
      makeCtx(),
      env
    )

    expect((output as { body: null }).body).toBeNull()
    expect((output as { status: number }).status).toBe(204)
  })

  // ── Authorization header ────────────────────────────────────────────────────

  it('sets Bearer authorization header using the fetched token', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('my-sf-token')
    fetchMock.mockResolvedValue(mockResponse(201, '{"id":"SF-1"}'))

    await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: {} }),
      makeCtx(),
      env
    )

    expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe('Bearer my-sf-token')
  })

  // ── injected_fields ─────────────────────────────────────────────────────────

  it('create: merges injected_fields into the body with template resolution', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(201, '{"id":"SF-1"}'))

    await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: { First_Name__c: 'John' },
        injected_fields: {
          ProspectTraceId__c: '{{execution.bidspoke_link}}',
          Source__c: 'Engine',
        },
      }),
      makeCtx(),
      env
    )

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sent.First_Name__c).toBe('John')
    expect(sent.ProspectTraceId__c).toBe('https://bidspoke.trypennie.dev/workflows/wf-1?execution=exec-1')
    expect(sent.Source__c).toBe('Engine')
  })

  it('create: injected_fields override body on key collision', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(201, '{"id":"SF-1"}'))

    await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: { Source__c: 'Body wins?' },
        injected_fields: { Source__c: 'Engine' },
      }),
      makeCtx(),
      env
    )

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sent.Source__c).toBe('Engine')
  })

  it('create: no injected_fields = no merge, body untouched', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(201, '{"id":"SF-1"}'))

    await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: { First_Name__c: 'John' } }),
      makeCtx(),
      env
    )

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sent).toEqual({ First_Name__c: 'John' })
  })

  it('update: applies injected_fields on patch', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(204, ''))

    await executeSalesforceNode(
      makeNode({
        operation: 'update',
        object: 'Prospect__c',
        record_id: 'SF-1',
        body: { Status__c: 'Active' },
        injected_fields: { LastBidspokeRun__c: '{{execution.bidspoke_link}}' },
      }),
      makeCtx(),
      env
    )

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sent.Status__c).toBe('Active')
    expect(sent.LastBidspokeRun__c).toBe('https://bidspoke.trypennie.dev/workflows/wf-1?execution=exec-1')
  })

  it('upsert: applies injected_fields on patch', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(204, ''))

    await executeSalesforceNode(
      makeNode({
        operation: 'upsert',
        object: 'Prospect__c',
        external_id_field: 'LeadUUID__c',
        external_id_value: 'lead-123',
        body: { First_Name__c: 'John' },
        injected_fields: { LastBidspokeRun__c: '{{execution.bidspoke_link}}' },
      }),
      makeCtx(),
      env
    )

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sent.First_Name__c).toBe('John')
    expect(sent.LastBidspokeRun__c).toBe('https://bidspoke.trypennie.dev/workflows/wf-1?execution=exec-1')
  })

  it('execution.bidspoke_link is undefined when execution_id is missing', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(201, '{"id":"SF-1"}'))

    await executeSalesforceNode(
      makeNode({
        operation: 'create',
        object: 'Prospect__c',
        body: { First_Name__c: 'John' },
        injected_fields: { ProspectTraceId__c: '{{execution.bidspoke_link}}' },
      }),
      makeCtx({ executionId: undefined }),
      env
    )

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    // Undefined values get dropped by JSON.stringify — field is omitted entirely.
    expect(sent.ProspectTraceId__c).toBeUndefined()
    expect(sent.First_Name__c).toBe('John')
  })

  // ── X-Trace-Id propagation ──────────────────────────────────────────────────

  it('propagates X-Trace-Id header on outbound SF call', async () => {
    const env = makeEnv()
    vi.mocked(env.WORKFLOW_CACHE.get as ReturnType<typeof vi.fn>).mockResolvedValue('tok')
    fetchMock.mockResolvedValue(mockResponse(201, '{"id":"SF-1"}'))

    await executeSalesforceNode(
      makeNode({ operation: 'create', object: 'Prospect__c', body: {} }),
      makeCtx(),
      env
    )

    expect(fetchMock.mock.calls[0][1].headers['X-Trace-Id']).toBe('tr-1')
  })
})
