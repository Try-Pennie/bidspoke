/**
 * Field coverage manifest + silence API (#423). jwtAuth; every handler verifies
 * the :workflowId belongs to the caller's org (404 otherwise). The manifest is
 * read-only and exposes presence rates + booleans, never resolved field values.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
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
const mockCtx = recordingContext()

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
      alias_only_nodes: string[]
      silences: Array<{ field_path: string }>
    }
    expect(body.workflow_id).toBe('wf-1')
    expect(body.fields).toEqual([
      {
        path: 'x.final',
        source: 'structured',
        health: { latest_day: '2026-06-29', ran: 100, present: 100, rate: 1, drought: false, dead: false, wrong_path: false, empty_by_design: false },
      },
    ])
    expect(body.unreadable_nodes).toEqual([])
    expect(body.alias_only_nodes).toEqual([])
    expect(body.silences).toEqual([{ field_path: 'y.skip', reason: 'always empty', created_at: '2026-06-29T00:00:00Z' }])
  })

  // #2018: the manifest gives the same verdict the alert does, from the same
  // classifier and window. A field whose key appears but never carries a value is
  // empty by design, not dead, and a key that never appears is a wrong path.
  it('GET reports a field empty by design apart from dead, and a missing key as a wrong path', async () => {
    const days = ['2026-10-11', '2026-10-12', '2026-10-13']
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { maybeSingle: { id: 'wf-1' } },
        field_presence_daily: {
          list: [
            ...days.map((day) => ({ workflow_id: 'wf-1', field_path: 'x.final', day, ran_count: 100, present_count: 0, key_present_count: 100, key_measured_count: 100 })),
            ...days.map((day) => ({ workflow_id: 'wf-1', field_path: 'x.typo', day, ran_count: 100, present_count: 0, key_present_count: 0, key_measured_count: 100 })),
          ],
        },
        field_presence_silences: { list: [] },
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )
    vi.mocked(loadWorkflowDefinition).mockResolvedValue({
      definition: { ...DEFINITION, nodes: [{ id: 'n1', namespace: 'r', type: 'response', config: { body: '{{steps.x.output.final}} {{steps.x.output.typo}}' } }] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    const res = await request(app, 'GET', '/field-coverage/wf-1')
    const body = (await res.json()) as { fields: Array<{ path: string; health: Record<string, unknown> }> }
    const health = (path: string) => body.fields.find((f) => f.path === path)?.health
    expect(health('x.final')).toMatchObject({ dead: false, wrong_path: false, empty_by_design: true })
    expect(health('x.typo')).toMatchObject({ dead: false, wrong_path: true, empty_by_design: false })
  })

  it('GET names a node whose steps alias could not be followed (#435)', async () => {
    // The manifest has to say where its own coverage is incomplete, or a clean
    // field list reads as proof that everything a workflow depends on is
    // watched. `r` is reassigned, so its reads cannot be attributed.
    vi.mocked(loadWorkflowDefinition).mockResolvedValue({
      definition: {
        ...DEFINITION,
        nodes: [
          ...DEFINITION.nodes,
          {
            id: 'n2',
            namespace: 'build_response',
            type: 'code',
            config: { script: 'let r = steps.a.x; r = other; return r.final' },
          },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { maybeSingle: { id: 'wf-1' } },
        field_presence_daily: { list: [] },
        field_presence_silences: { list: [] },
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )
    const res = await request(app, 'GET', '/field-coverage/wf-1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { alias_only_nodes: string[]; unreadable_nodes: string[] }
    expect(body.alias_only_nodes).toEqual(['build_response'])
    // Milder than unreadable: the node IS scanned, some reads just cannot be
    // attributed, so it must not be reported as both.
    expect(body.unreadable_nodes).toEqual([])
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
        health: { latest_day: '2026-06-29', ran: 5, present: 5, rate: 1, drought: false, dead: false, wrong_path: false, empty_by_design: false },
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
        field_presence_silences: { writeRows: [{ field_path: 'x.final' }] },
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

  it('DELETE silence still returns 200 but writes no audit log when the clear matches zero rows (#588)', async () => {
    // Clearing a silence that was never set is an idempotent no-op (200); the
    // audit line is gated on the row actually removed, so it must not fire here.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { maybeSingle: { id: 'wf-1' } },
        field_presence_silences: { writeRows: [] },
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )
    const res = await jsonRequest(app, 'DELETE', '/field-coverage/wf-1/silence', { field: 'x.final' })
    expect(res.status).toBe(200)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('DELETE silence returns 500 (not a false 200/404) when the delete hits a real DB error (#588)', async () => {
    // A transient write failure must surface as a retryable 500, not be swallowed
    // into the no-op 200 path.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflows: { maybeSingle: { id: 'wf-1' } },
        field_presence_silences: { deleteError: { code: '42P01', message: 'relation missing' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )
    const res = await jsonRequest(app, 'DELETE', '/field-coverage/wf-1/silence', { field: 'x.final' })
    expect(res.status).toBe(500)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})
