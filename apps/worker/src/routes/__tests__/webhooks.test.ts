/**
 * Webhook route — PRD Section 1.2
 * Tests the POST /webhooks/:workflow_id hot path:
 * auth, JSON parsing, engine delegation, response headers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../index'

// ── Mocks (hoisted before imports) ───────────────────────────────────────────

vi.mock('../../engine/index', async () => {
  const actual = await vi.importActual<typeof import('../../engine/index')>('../../engine/index')
  return { ...actual, executeWorkflow: vi.fn() }
})
vi.mock('../../lib/supabase')

import { executeWorkflow, SourceNotAuthorizedError, SourceAuthUnavailableError } from '../../engine/index'
import { WorkflowNotFoundError } from '../../engine/definition-loader'
import { createSupabaseClient } from '../../lib/supabase'
import webhooks from '../webhooks'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const KEY_MAP = JSON.stringify({ 'sk_test_key': 'website_form' })

const testEnv = {
  API_KEY_MAP: KEY_MAP,
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_ANON_KEY: 'fake-anon-key',
} as unknown as Env

function request(
  workflowId: string,
  opts: {
    apiKey?: string
    body?: unknown
    rawBody?: string
    idempotencyKey?: string
  } = {}
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.apiKey !== undefined) headers['X-API-Key'] = opts.apiKey
  if (opts.idempotencyKey) headers['X-Idempotency-Key'] = opts.idempotencyKey

  const body = opts.rawBody !== undefined
    ? opts.rawBody
    : JSON.stringify(opts.body ?? { test: true })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
  return webhooks.request(
    `/${workflowId}`,
    { method: 'POST', headers, body },
    testEnv,
    mockCtx
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /webhooks/:workflow_id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createSupabaseClient).mockReturnValue({} as ReturnType<typeof createSupabaseClient>)
  })

  describe('API key authentication', () => {
    it('returns 401 when X-API-Key header is missing', async () => {
      const res = await request('wf-1')
      expect(res.status).toBe(401)
    })

    it('returns 401 for an unrecognized API key', async () => {
      const res = await request('wf-1', { apiKey: 'sk_wrong_key' })
      expect(res.status).toBe(401)
    })

    it('proceeds past auth with a valid API key', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        response: { ok: true },
        status: 200,
        executionId: 'exec-test', traceId: 'trace-abc',
        idempotentReplay: false,
      })
      const res = await request('wf-1', { apiKey: 'sk_test_key' })
      expect(res.status).toBe(200)
    })
  })

  describe('request body parsing', () => {
    it('returns 400 for invalid JSON', async () => {
      const res = await request('wf-1', { apiKey: 'sk_test_key', rawBody: 'not-json{' })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/invalid json/i)
    })
  })

  describe('workflow not found / inactive (#107)', () => {
    it('returns 404 with a generic message for WorkflowNotFoundError', async () => {
      vi.mocked(executeWorkflow).mockRejectedValue(new WorkflowNotFoundError('wf-missing', true))
      const res = await request('wf-missing', { apiKey: 'sk_test_key' })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'Workflow not found' })
    })

    // The old code mapped any error whose text contained "not found"/"inactive"
    // to 404 by substring; an internal error must NOT be miscued as 404 now.
    it('returns 500 (not 404) for an internal error whose message contains "not found"', async () => {
      vi.mocked(executeWorkflow).mockRejectedValue(new Error('partner_bid_config not found: abc'))
      const res = await request('wf-1', { apiKey: 'sk_test_key' })
      expect(res.status).toBe(500)
    })

    it('returns a generic 500 body, never echoing the raw error message', async () => {
      vi.mocked(executeWorkflow).mockRejectedValue(new Error('Database connection failed at 10.0.0.5:5432'))
      const res = await request('wf-1', { apiKey: 'sk_test_key' })
      expect(res.status).toBe(500)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Internal error')
      expect(body.error).not.toContain('Database')
      expect(body.error).not.toContain('10.0.0.5')
    })

    it('returns 503 with a generic message when source auth verification fails', async () => {
      vi.mocked(executeWorkflow).mockRejectedValue(new SourceAuthUnavailableError('website_form', 'pg: connection refused at db-host'))
      const res = await request('wf-1', { apiKey: 'sk_test_key' })
      expect(res.status).toBe(503)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Service temporarily unavailable')
      expect(body.error).not.toContain('pg:')
      expect(body.error).not.toContain('db-host')
    })
  })

  describe('source-to-workflow assignment', () => {
    it('passes enforceSourceAssignment: true to the engine', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        executionId: 'exec-test', response: {}, status: 200, traceId: 'trace-1', idempotentReplay: false,
      })
      await request('wf-1', { apiKey: 'sk_test_key' })
      expect(vi.mocked(executeWorkflow)).toHaveBeenCalledWith(
        expect.objectContaining({ enforceSourceAssignment: true }),
        expect.anything(), expect.anything(), expect.anything()
      )
    })

    it('returns 403 when the source is not authorized for this workflow', async () => {
      vi.mocked(executeWorkflow).mockRejectedValue(
        new SourceNotAuthorizedError('website_form', 'wf-1')
      )
      const res = await request('wf-1', { apiKey: 'sk_test_key' })
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      // Generic message (#107) — does not echo the source name or workflow id.
      expect(body.error).toBe('Source not authorized for this workflow')
      expect(body.error).not.toContain('website_form')
      expect(body.error).not.toContain('wf-1')
    })

    it('returns a retryable 503 (fails closed) when the assignment lookup errors (#65)', async () => {
      vi.mocked(executeWorkflow).mockRejectedValue(
        new SourceAuthUnavailableError('engine', 'connection reset')
      )
      const res = await request('wf-1', { apiKey: 'sk_test_key' })
      expect(res.status).toBe(503)
    })
  })

  describe('successful execution', () => {
    it('returns the engine response with status 200', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        response: { accepted: true, id: 'lead-123' },
        status: 200,
        executionId: 'exec-test', traceId: 'trace-xyz',
        idempotentReplay: false,
      })
      const res = await request('wf-1', { apiKey: 'sk_test_key', body: { lead: 'data' } })
      expect(res.status).toBe(200)
      const body = await res.json() as { accepted: boolean }
      expect(body.accepted).toBe(true)
    })

    it('sets X-Trace-Id header on the response', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        response: {},
        status: 200,
        executionId: 'exec-test', traceId: 'trace-abc123',
        idempotentReplay: false,
      })
      const res = await request('wf-1', { apiKey: 'sk_test_key' })
      expect(res.headers.get('X-Trace-Id')).toBe('trace-abc123')
    })

    it('sets X-Idempotent-Replay header when engine signals a replay', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        response: { cached: true },
        status: 200,
        executionId: 'exec-test', traceId: 'trace-replay',
        idempotentReplay: true,
      })
      const res = await request('wf-1', {
        apiKey: 'sk_test_key',
        idempotencyKey: 'idem-key-abc',
      })
      expect(res.headers.get('X-Idempotent-Replay')).toBe('true')
    })

    it('does not set X-Idempotent-Replay when idempotentReplay is false', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        response: {},
        status: 200,
        executionId: 'exec-test', traceId: 'trace-1',
        idempotentReplay: false,
      })
      const res = await request('wf-1', { apiKey: 'sk_test_key' })
      expect(res.headers.get('X-Idempotent-Replay')).toBeNull()
    })

    it('passes the source name from the API key map to executeWorkflow', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        response: {},
        status: 200,
        executionId: 'exec-test', traceId: 'trace-1',
        idempotentReplay: false,
      })
      await request('wf-1', { apiKey: 'sk_test_key', body: { x: 1 } })
      expect(vi.mocked(executeWorkflow)).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'website_form', workflowId: 'wf-1' }),
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
    })

    it('passes the trigger payload to executeWorkflow', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        response: {},
        status: 200,
        executionId: 'exec-test', traceId: 'trace-1',
        idempotentReplay: false,
      })
      const payload = { lead_id: 'L42', score: 750 }
      await request('wf-1', { apiKey: 'sk_test_key', body: payload })
      expect(vi.mocked(executeWorkflow)).toHaveBeenCalledWith(
        expect.objectContaining({ payload }),
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
    })
  })

  // The engine answers a duplicate that is still in flight with 409 rather than
  // re-running partner bids. That status has to survive the route: a 200 here
  // tells the source its duplicate was accepted, a 500 makes it retry the lead.
  // Engine-side behavior lives in engine/__tests__/idempotency-engine.test.ts;
  // these cover the route's status pass-through (#482).
  describe('in-flight duplicate returns 409 (#482)', () => {
    const duplicate = {
      response: { error: 'Duplicate request in progress' },
      status: 409,
      executionId: 'exec-dup',
      traceId: 'trace-dup',
    }

    it('returns 409 with the engine body when the duplicate is still in flight', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue(duplicate)
      const res = await request('wf-1', { apiKey: 'sk_test_key', idempotencyKey: 'idem-dup' })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'Duplicate request in progress' })
    })

    it('still sets X-Trace-Id on the 409 so the rejected duplicate is traceable', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue(duplicate)
      const res = await request('wf-1', { apiKey: 'sk_test_key', idempotencyKey: 'idem-dup' })
      expect(res.headers.get('X-Trace-Id')).toBe('trace-dup')
    })

    // A 409 is a rejection, not a replay of a stored response. Tagging it as a
    // replay would tell the source it already received this result.
    it('does not set X-Idempotent-Replay on the 409', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue(duplicate)
      const res = await request('wf-1', { apiKey: 'sk_test_key', idempotencyKey: 'idem-dup' })
      expect(res.headers.get('X-Idempotent-Replay')).toBeNull()
    })

    // A workflow whose Response node sets a non-JSON Content-Type takes the
    // c.body() branch instead of c.json(); the status must carry through there too.
    it('returns 409 through the non-JSON Content-Type branch', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        ...duplicate,
        response: '<error>duplicate</error>',
        responseHeaders: { 'Content-Type': 'application/xml' },
      })
      const res = await request('wf-1', { apiKey: 'sk_test_key', idempotencyKey: 'idem-dup' })
      expect(res.status).toBe(409)
      expect(res.headers.get('Content-Type')).toBe('application/xml')
      expect(await res.text()).toBe('<error>duplicate</error>')
    })
  })
})
