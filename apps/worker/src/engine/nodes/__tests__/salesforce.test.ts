/**
 * Salesforce node
 * Tests: token fetch + cache, each operation type, template resolution, CF secrets
 * merge, 401 evicts cache, non-2xx throws Response, 204 No Content handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeSalesforceNode } from '../salesforce'
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
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
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
