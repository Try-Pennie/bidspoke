/**
 * Field coverage manifest + silence API (#423). jwtAuth; every handler verifies
 * the :workflowId belongs to the caller's org (404 otherwise). The manifest is
 * read-only and exposes presence rates + booleans, never resolved field values.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../engine/definition-loader')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { loadWorkflowDefinition } from '../../../engine/definition-loader'
import { makeSupabase } from './_supabase-mock'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {} } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

const DEFINITION = {
  id: 'wf-1',
  name: 'wf',
  trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } },
  nodes: [{ id: 'n1', namespace: 'r', type: 'response', config: { body: '{{steps.x.output.final}}' } }],
  edges: [],
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function request(app: { request: Function }, method: string, path: string) {
  return app.request(path, { method, headers: { Authorization: 'Bearer tok' } }, testEnv, mockCtx)
}

function jsonRequest(app: { request: Function }, method: string, path: string, body: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    testEnv,
    mockCtx,
  )
}

describe('field-coverage routes (#423)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(loadWorkflowDefinition).mockResolvedValue({ definition: DEFINITION } as any)
    app = await makeApp()
  })

  it('GET returns 404 when the workflow is not in the caller org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { maybeSingle: null } }) as unknown as ReturnType<typeof createSupabaseClient>,
    )
    const res = await request(app, 'GET', '/field-coverage/wf-x')
    expect(res.status).toBe(404)
  })

  it('GET returns the manifest shape for an owned workflow', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { maybeSingle: { id: 'wf-1' } },
        field_presence_daily: {
          list: [{ workflow_id: 'wf-1', field_path: 'x.final', day: '2026-06-29', ran_count: 100, present_count: 100 }],
        },
        field_presence_silences: { list: [{ field_path: 'y.skip', reason: 'always empty', created_at: '2026-06-29T00:00:00Z' }] },
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )
    const res = await request(app, 'GET', '/field-coverage/wf-1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      workflow_id: string
      fields: Array<{ path: string; source: string; health: unknown }>
      unreadable_nodes: string[]
      silences: Array<{ field_path: string }>
    }
    expect(body.workflow_id).toBe('wf-1')
    expect(body.fields).toEqual([
      {
        path: 'x.final',
        source: 'structured',
        health: { latest_day: '2026-06-29', ran: 100, present: 100, rate: 1, drought: false, dead: false },
      },
    ])
    expect(body.unreadable_nodes).toEqual([])
    expect(body.silences).toEqual([{ field_path: 'y.skip', reason: 'always empty', created_at: '2026-06-29T00:00:00Z' }])
  })

  it('GET pages past a 1,000-row field_presence_daily response instead of truncating', async () => {
    // field_presence_daily is a known big table (#488): a bare, unpaginated read
    // would silently drop anything past PostgREST's 1,000-row cap. Page 1 is a
    // full 1,000-row page for an unwatched field (so it carries no signal by
    // itself); page 2 has the single row for the watched field 'x.final'. If the
    // route ever regresses to a single unpaginated/capped read, only page 1 is
    // fetched and 'x.final' never shows up in the response.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({
      workflow_id: 'wf-1',
      field_path: 'x.other',
      day: `2026-06-${String((i % 20) + 1).padStart(2, '0')}`,
      ran_count: 10,
      present_count: 10,
    }))
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { maybeSingle: { id: 'wf-1' } },
        field_presence_daily: [
          { list: fullPage },
          { list: [{ workflow_id: 'wf-1', field_path: 'x.final', day: '2026-06-29', ran_count: 5, present_count: 5 }] },
        ],
        field_presence_silences: { list: [] },
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )
    const res = await request(app, 'GET', '/field-coverage/wf-1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { fields: Array<{ path: string; health: unknown }> }
    expect(body.fields).toEqual([
      {
        path: 'x.final',
        source: 'structured',
        health: { latest_day: '2026-06-29', ran: 5, present: 5, rate: 1, drought: false, dead: false },
      },
    ])
  })

  it('POST silence returns 404 when the workflow is not in the caller org', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { maybeSingle: null } }) as unknown as ReturnType<typeof createSupabaseClient>,
    )
    const res = await jsonRequest(app, 'POST', '/field-coverage/wf-x/silence', { field: 'x.final', reason: 'r' })
    expect(res.status).toBe(404)
  })

  it('POST silence requires a reason (400 without)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { maybeSingle: { id: 'wf-1' } } }) as unknown as ReturnType<typeof createSupabaseClient>,
    )
    const res = await jsonRequest(app, 'POST', '/field-coverage/wf-1/silence', { field: 'x.final' })
    expect(res.status).toBe(400)
  })

  it('POST silence upserts with field + reason for an owned workflow', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { maybeSingle: { id: 'wf-1' } },
        field_presence_silences: { upsertResult: null },
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )
    const res = await jsonRequest(app, 'POST', '/field-coverage/wf-1/silence', {
      field: 'x.final',
      reason: 'always empty for FDR leads',
    })
    expect(res.status).toBe(200)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(),
      'org-abc',
      'field_presence_silence',
      'wf-1:x.final',
      'field_silence_set',
      'user-1',
      expect.objectContaining({ reason: 'always empty for FDR leads' }),
    )
  })

  it('DELETE silence requires a field (400 without)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser }, workflows: { maybeSingle: { id: 'wf-1' } } }) as unknown as ReturnType<typeof createSupabaseClient>,
    )
    const res = await jsonRequest(app, 'DELETE', '/field-coverage/wf-1/silence', {})
    expect(res.status).toBe(400)
  })

  it('DELETE silence removes the silence for an owned workflow', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { maybeSingle: { id: 'wf-1' } },
        field_presence_silences: {},
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )
    const res = await jsonRequest(app, 'DELETE', '/field-coverage/wf-1/silence', { field: 'x.final' })
    expect(res.status).toBe(200)
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(
      expect.anything(),
      'org-abc',
      'field_presence_silence',
      'wf-1:x.final',
      'field_silence_cleared',
      'user-1',
      expect.anything(),
    )
  })
})
