/**
 * Integration node — PRD Section 5.5
 * Tests: URL/body/header template resolution, CF secrets merge, auth header
 * construction (bearer/basic/api_key), GET omits body, HTTP error throws Response,
 * JSON + non-JSON response parsing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeIntegrationNode } from '../integration'
import type { NodeDefinition, ExecutionContext } from '../../../types'
import type { Env } from '../../../index'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(config: Record<string, unknown>): NodeDefinition {
  return { id: 'int_1', namespace: 'call_equifax', type: 'webhook', config }
}

function makeCtx(overrides: { env?: Record<string, string>; steps?: Record<string, unknown> } = {}): ExecutionContext {
  const stepMap: ExecutionContext['steps'] = {}
  for (const [ns, output] of Object.entries(overrides.steps ?? {})) {
    stepMap[ns] = { output, status: 'completed' }
  }
  return {
    trigger: { payload: { ssn: '123-45-6789', amount: 10000 }, source: 'test', workflow_id: 'wf-1', org_id: '', trace_id: 'tr-1' },
    steps: stepMap,
    env: overrides.env ?? {},
  } as unknown as ExecutionContext
}

// Env that exposes string-valued CF secrets plus non-string bindings that must be ignored
function makeEnv(secrets: Record<string, string> = {}): Env {
  return {
    // These non-string bindings should NOT be merged into ctx.env
    WORKFLOW_CACHE: { get: vi.fn() } as unknown as KVNamespace,
    DAILY_CAP: {} as DurableObjectNamespace,
    ...secrets,
  } as unknown as Env
}

// Build a mock Response-like object that fetch resolves to
function mockResponse(status: number, body: string, headers: Record<string, string> = {}) {
  const hdrs = new Headers({ 'content-type': 'application/json', ...headers })
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    headers: hdrs,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeIntegrationNode', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ── Config validation ───────────────────────────────────────────────────────

  it('throws when url is missing', async () => {
    const node = makeNode({ service: 'custom' })  // no url
    await expect(executeIntegrationNode(node, makeCtx(), makeEnv()))
      .rejects.toThrow('requires config.url')
  })

  it('throws when url resolves to empty string', async () => {
    const node = makeNode({ url: '{{env.MISSING_VAR}}' })
    await expect(executeIntegrationNode(node, makeCtx(), makeEnv()))
      .rejects.toThrow('resolved to empty string')
  })

  // ── Basic HTTP call ─────────────────────────────────────────────────────────

  it('makes a POST request and returns parsed JSON body', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{"score":720}'))
    const node = makeNode({ url: 'https://api.example.com/credit', method: 'POST' })
    const { output } = await executeIntegrationNode(node, makeCtx(), makeEnv())
    expect((output as { status: number }).status).toBe(200)
    expect((output as { body: { score: number } }).body).toEqual({ score: 720 })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/credit',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('returns raw string body when response is not JSON', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, 'OK plain text'))
    const node = makeNode({ url: 'https://api.example.com/ping' })
    const { output } = await executeIntegrationNode(node, makeCtx(), makeEnv())
    expect((output as { body: unknown }).body).toBe('OK plain text')
  })

  it('defaults to POST when method is not set', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({ url: 'https://api.example.com/data' })
    await executeIntegrationNode(node, makeCtx(), makeEnv())
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
  })

  // ── Template resolution ─────────────────────────────────────────────────────

  it('resolves {{env.KEY}} in URL from ctx.env', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({ url: '{{env.SERVICE_URL}}/v1/report' })
    const ctx = makeCtx({ env: { SERVICE_URL: 'https://equifax.example.com' } })
    await executeIntegrationNode(node, ctx, makeEnv())
    expect(fetchMock.mock.calls[0][0]).toBe('https://equifax.example.com/v1/report')
  })

  it('resolves {{trigger.payload.*}} in body', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({
      url: 'https://api.example.com/check',
      body: { ssn: '{{trigger.payload.ssn}}', amount: '{{trigger.payload.amount}}' },
    })
    await executeIntegrationNode(node, makeCtx(), makeEnv())
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sentBody.ssn).toBe('123-45-6789')
    // {{trigger.payload.amount}} resolves to the numeric value 10000, not a string
    expect(sentBody.amount).toBe(10000)
  })

  it('resolves {{steps.ns.field}} in body', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({
      url: 'https://api.example.com/enrich',
      body: { credit_score: '{{steps.credit.score}}' },
    })
    const ctx = makeCtx({ steps: { credit: { score: 700 } } })
    await executeIntegrationNode(node, ctx, makeEnv())
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    // {{steps.credit.score}} resolves to the numeric value 700, not a string
    expect(sentBody.credit_score).toBe(700)
  })

  it('resolves templates in custom headers', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({
      url: 'https://api.example.com/data',
      headers: { 'X-Request-Id': '{{trigger.payload.ssn}}' },
    })
    await executeIntegrationNode(node, makeCtx(), makeEnv())
    expect(fetchMock.mock.calls[0][1].headers['X-Request-Id']).toBe('123-45-6789')
  })

  // ── CF secrets merge ────────────────────────────────────────────────────────

  it('resolves {{env.KEY}} from CF secret bindings (not in ctx.env)', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({
      url: 'https://api.example.com/report',
      auth: { type: 'bearer', token: '{{env.MY_CF_SECRET}}' },
    })
    // MY_CF_SECRET is a CF secret (not in ctx.env), passed via env bindings
    const env = makeEnv({ MY_CF_SECRET: 'super-secret-token' })
    await executeIntegrationNode(node, makeCtx(), env)
    expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe('Bearer super-secret-token')
  })

  it('ignores non-string CF bindings (KV, DO, etc.)', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({ url: 'https://api.example.com/data' })
    // WORKFLOW_CACHE and DAILY_CAP are non-string in makeEnv — they must not crash the merge
    await expect(executeIntegrationNode(node, makeCtx(), makeEnv())).resolves.toBeTruthy()
  })

  // ── Auth headers ────────────────────────────────────────────────────────────

  it('sets Bearer authorization header', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({
      url: 'https://api.example.com/data',
      auth: { type: 'bearer', token: '{{env.API_TOKEN}}' },
    })
    const ctx = makeCtx({ env: { API_TOKEN: 'tok-abc123' } })
    await executeIntegrationNode(node, ctx, makeEnv())
    expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe('Bearer tok-abc123')
  })

  it('sets Basic authorization header with base64 encoding', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({
      url: 'https://api.example.com/data',
      auth: { type: 'basic', username: '{{env.EQ_USER}}', password: '{{env.EQ_PASS}}' },
    })
    const ctx = makeCtx({ env: { EQ_USER: 'myuser', EQ_PASS: 'mypass' } })
    await executeIntegrationNode(node, ctx, makeEnv())
    const expected = `Basic ${btoa('myuser:mypass')}`
    expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe(expected)
  })

  it('sets API key in custom header', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({
      url: 'https://api.example.com/data',
      auth: { type: 'api_key', header: 'X-Scout-Key', key: '{{env.SCOUT_KEY}}' },
    })
    const ctx = makeCtx({ env: { SCOUT_KEY: 'sk-xyz' } })
    await executeIntegrationNode(node, ctx, makeEnv())
    expect(fetchMock.mock.calls[0][1].headers['X-Scout-Key']).toBe('sk-xyz')
  })

  it('defaults API key header to X-API-Key', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({
      url: 'https://api.example.com/data',
      auth: { type: 'api_key', key: '{{env.KEY}}' },
    })
    const ctx = makeCtx({ env: { KEY: 'mykey' } })
    await executeIntegrationNode(node, ctx, makeEnv())
    expect(fetchMock.mock.calls[0][1].headers['X-API-Key']).toBe('mykey')
  })

  // ── Logged headers are masked (#73) ───────────────────────────────────────────

  it('masks the Authorization value in resolvedInput while sending the real token', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({
      url: 'https://api.example.com/data',
      auth: { type: 'bearer', token: '{{env.API_TOKEN}}' },
    })
    const ctx = makeCtx({ env: { API_TOKEN: 'tok-abc123' } })
    const result = await executeIntegrationNode(node, ctx, makeEnv())
    // Wire gets the real token…
    expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe('Bearer tok-abc123')
    // …but the persisted/displayed copy is redacted.
    const logged = (result.resolvedInput!.resolved as { headers: Record<string, string> }).headers
    expect(logged['Authorization']).toBe('[redacted]')
    expect(JSON.stringify(result.resolvedInput)).not.toContain('tok-abc123')
  })

  it('masks a custom api_key header in resolvedInput', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({
      url: 'https://api.example.com/data',
      auth: { type: 'api_key', header: 'X-Scout-Key', key: '{{env.SCOUT_KEY}}' },
    })
    const ctx = makeCtx({ env: { SCOUT_KEY: 'sk-xyz' } })
    const result = await executeIntegrationNode(node, ctx, makeEnv())
    expect(fetchMock.mock.calls[0][1].headers['X-Scout-Key']).toBe('sk-xyz')
    const logged = (result.resolvedInput!.resolved as { headers: Record<string, string> }).headers
    expect(logged['X-Scout-Key']).toBe('[redacted]')
  })

  it('leaves non-sensitive headers visible in resolvedInput', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({
      url: 'https://api.example.com/data',
      headers: { 'X-Request-Id': '{{trigger.payload.ssn}}' },
      auth: { type: 'bearer', token: '{{env.API_TOKEN}}' },
    })
    const ctx = makeCtx({ env: { API_TOKEN: 'tok-abc123' } })
    const result = await executeIntegrationNode(node, ctx, makeEnv())
    const logged = (result.resolvedInput!.resolved as { headers: Record<string, string> }).headers
    expect(logged['X-Request-Id']).toBe('123-45-6789') // non-sensitive — preserved for debugging
    expect(logged['Authorization']).toBe('[redacted]')
  })

  it('masks the Authorization value on the error path too (thrown Response resolvedInput)', async () => {
    fetchMock.mockResolvedValue(mockResponse(403, 'forbidden'))
    const node = makeNode({
      url: 'https://api.example.com/data',
      auth: { type: 'bearer', token: '{{env.API_TOKEN}}' },
    })
    const ctx = makeCtx({ env: { API_TOKEN: 'tok-abc123' } })
    try {
      await executeIntegrationNode(node, ctx, makeEnv())
      throw new Error('expected throw')
    } catch (err) {
      const ri = (err as { resolvedInput?: { resolved: { headers: Record<string, string> } } }).resolvedInput
      expect(ri?.resolved.headers['Authorization']).toBe('[redacted]')
    }
  })

  it('sets no Authorization header when auth type is none', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}'))
    const node = makeNode({ url: 'https://api.example.com/data', auth: { type: 'none' } })
    await executeIntegrationNode(node, makeCtx(), makeEnv())
    expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBeUndefined()
  })

  // ── GET requests ────────────────────────────────────────────────────────────

  it('omits body for GET requests', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{"ok":true}'))
    const node = makeNode({
      url: 'https://api.example.com/status',
      method: 'GET',
      body: { should: 'not be sent' },
    })
    await executeIntegrationNode(node, makeCtx(), makeEnv())
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined()
  })

  it('omits body for HEAD requests', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, ''))
    const node = makeNode({ url: 'https://api.example.com/check', method: 'HEAD', body: { x: 1 } })
    await executeIntegrationNode(node, makeCtx(), makeEnv())
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined()
  })

  // ── HTTP errors ─────────────────────────────────────────────────────────────

  it('throws a Response instance on 4xx so the engine can classify it', async () => {
    fetchMock.mockResolvedValue(mockResponse(400, '{"error":"bad request"}'))
    const node = makeNode({ url: 'https://api.example.com/data' })
    const err = await executeIntegrationNode(node, makeCtx(), makeEnv()).catch((e) => e)
    expect(err).toBeInstanceOf(Response)
    expect((err as Response).status).toBe(400)
  })

  it('throws a Response instance on 5xx', async () => {
    fetchMock.mockResolvedValue(mockResponse(503, 'Service Unavailable'))
    const node = makeNode({ url: 'https://api.example.com/data' })
    const err = await executeIntegrationNode(node, makeCtx(), makeEnv()).catch((e) => e)
    expect(err).toBeInstanceOf(Response)
    expect((err as Response).status).toBe(503)
  })

  // ── Response headers ────────────────────────────────────────────────────────

  it('returns response headers in output', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, '{}', { 'x-request-id': 'req-123' }))
    const node = makeNode({ url: 'https://api.example.com/data' })
    const { output } = await executeIntegrationNode(node, makeCtx(), makeEnv())
    expect((output as { headers: Record<string, string> }).headers['x-request-id']).toBe('req-123')
  })
})
