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

import { executeWorkflow, SourceNotAuthorizedError } from '../../engine/index'
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
        traceId: 'trace-abc',
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

  describe('workflow not found / inactive', () => {
    it('returns 404 when executeWorkflow throws "not found"', async () => {
      vi.mocked(executeWorkflow).mockRejectedValue(new Error('Workflow not found'))
      const res = await request('wf-missing', { apiKey: 'sk_test_key' })
      expect(res.status).toBe(404)
    })

    it('returns 404 when executeWorkflow throws "inactive"', async () => {
      vi.mocked(executeWorkflow).mockRejectedValue(new Error('Workflow is inactive'))
      const res = await request('wf-inactive', { apiKey: 'sk_test_key' })
      expect(res.status).toBe(404)
    })

    it('returns 500 for unexpected errors', async () => {
      vi.mocked(executeWorkflow).mockRejectedValue(new Error('Database connection failed'))
      const res = await request('wf-1', { apiKey: 'sk_test_key' })
      expect(res.status).toBe(500)
    })
  })

  describe('source-to-workflow assignment', () => {
    it('passes enforceSourceAssignment: true to the engine', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        response: {}, status: 200, traceId: 'trace-1', idempotentReplay: false,
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
      expect(body.error).toMatch(/not authorized/i)
    })
  })

  describe('successful execution', () => {
    it('returns the engine response with status 200', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        response: { accepted: true, id: 'lead-123' },
        status: 200,
        traceId: 'trace-xyz',
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
        traceId: 'trace-abc123',
        idempotentReplay: false,
      })
      const res = await request('wf-1', { apiKey: 'sk_test_key' })
      expect(res.headers.get('X-Trace-Id')).toBe('trace-abc123')
    })

    it('sets X-Idempotent-Replay header when engine signals a replay', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        response: { cached: true },
        status: 200,
        traceId: 'trace-replay',
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
        traceId: 'trace-1',
        idempotentReplay: false,
      })
      const res = await request('wf-1', { apiKey: 'sk_test_key' })
      expect(res.headers.get('X-Idempotent-Replay')).toBeNull()
    })

    it('passes the source name from the API key map to executeWorkflow', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        response: {},
        status: 200,
        traceId: 'trace-1',
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
        traceId: 'trace-1',
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
})
