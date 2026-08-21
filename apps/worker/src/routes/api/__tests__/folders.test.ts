/**
 * Folder routes: #595 (the false-404 write class).
 * PATCH /:id ends its write in .update().select().single(). PostgREST answers a
 * zero-row match there with PGRST116, which must become a 404, not a 500. The
 * cycle-trigger branch runs before the not-found check and must still return 400,
 * and a genuine DB error must still surface as a retryable 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { makeSupabase } from './_supabase-mock'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function patch(app: { request: Function }, path: string, body: unknown) {
  return app.request(
    path,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify(body) },
    testEnv,
    mockCtx
  )
}

describe('PATCH /folders/:id: zero-row 404, cycle 400, real DB error 500 (#595)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const existing = { id: 'f-1', name: 'Old', parent_id: null }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('returns 404 (not 500) and skips the audit log when the update matches zero rows', async () => {
    // Existence read finds the folder, then the UPDATE touches nothing (raced
    // away or another org). That zero-row write must read as not-found.
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        folders: [{ single: existing }, { single: null }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await patch(app, '/folders/f-1', { name: 'New' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'folder not found' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 400 when the cycle trigger fires (this branch runs before the not-found check)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        folders: [{ single: existing }, { updateError: { message: 'folder cycle detected' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await patch(app, '/folders/f-1', { parent_id: null, name: 'New' })
    expect(res.status).toBe(400)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 500 (not a false 404) when the update hits a real DB error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        folders: [{ single: existing }, { updateError: { code: '42P01', message: 'relation missing' } }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await patch(app, '/folders/f-1', { name: 'New' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 200 with the updated row on the happy path', async () => {
    const updated = { id: 'f-1', organization_id: 'org-abc', parent_id: null, name: 'New', created_at: 't', updated_at: 't' }
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        folders: [{ single: existing }, { updateResult: updated }],
      }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await patch(app, '/folders/f-1', { name: 'New' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(updated)
  })
})

/**
 * DELETE /folders/:id and the emptiness test it gates on (#877 Phase B0).
 *
 * Two defects in one pair of counts:
 *
 * The child-workflow count had no `deleted_at` filter, and `workflows` has been
 * soft-deleted for a long time. So a folder whose only remaining contents are
 * workflows somebody already deleted could never be deleted: the page said
 * "folder not empty" about a folder that looked empty on screen. Nothing is
 * blocked by this in production today (0 of the 33 soft-deleted workflows carry
 * a folder_id, measured 2026-08-21), which is why it stayed invisible. The
 * sibling child-folder count inherits the same bug the moment folders gain the
 * column.
 *
 * And both counts discarded their errors. `count` comes back null on a failed
 * query and `?? 0` turns that into "no children", so a folder with contents got
 * DELETED because the query that would have found them failed. A destructive
 * action must fail closed (L42), and an error state is not an empty state (L10).
 */
describe('DELETE /folders/:id', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const folder = { id: 'f-1', name: 'Partner flows' }

  const del = (a: Awaited<ReturnType<typeof makeApp>>) =>
    a.request('/folders/f-1', { method: 'DELETE', headers: { Authorization: 'Bearer tok' } }, testEnv, mockCtx)

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(writeAuditLog).mockResolvedValue(undefined)
    app = await makeApp()
  })

  it('deletes a folder whose only remaining workflows are soft-deleted', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        // The existence lookup, then the child-folder count.
        folders: [{ single: folder }, { count: 0 }, { writeRows: [{ id: 'f-1' }] }],
        // The live count is what the route must ask for. A route that counted
        // tombstones would see the soft-deleted rows this table holds.
        workflows: { count: 0 },
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )

    const res = await del(app)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  // The filter itself, asserted on the query the route actually sent rather than
  // on the outcome, because a count of 0 is reached by both a correct filter and
  // an empty table (L159).
  it('asks for live workflows only, not tombstoned ones', async () => {
    const supabase = makeSupabase({
      users: { single: testUser },
      folders: [{ single: folder }, { count: 0 }, { writeRows: [{ id: 'f-1' }] }],
      workflows: { count: 0 },
    })
    vi.mocked(createSupabaseClient).mockReturnValue(supabase as unknown as ReturnType<typeof createSupabaseClient>)

    await del(app)

    const workflowCalls = supabase.calls['workflows'] ?? []
    const filteredDeletedAt = workflowCalls.some(
      ([method, args]) => method === 'is' && args[0] === 'deleted_at' && args[1] === null,
    )
    expect(
      filteredDeletedAt,
      'the child-workflow count must exclude soft-deleted workflows, or a folder whose workflows were ' +
        'already deleted can never be deleted itself',
    ).toBe(true)
  })

  it('still refuses a folder that holds a live workflow', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        folders: [{ single: folder }, { count: 0 }],
        workflows: { count: 2 },
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )

    const res = await del(app)

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'folder not empty', child_workflows: 2 })
  })

  it('still refuses a folder that holds a child folder', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        folders: [{ single: folder }, { count: 3 }],
        workflows: { count: 0 },
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )

    const res = await del(app)

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ child_folders: 3 })
  })

  // Fail closed. Each count gets its own case, because one boundary answering
  // for the other is exactly how half of a guard goes missing (L73).
  it('refuses to delete when the child-workflow count fails', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        folders: [{ single: folder }, { count: 0 }],
        workflows: { listError: { message: 'statement timeout', code: '57014' } },
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )

    const res = await del(app)

    expect(res.status).toBeGreaterThanOrEqual(500)
    // Names the real cause. "folder not empty" would be a lie, and a bare 500
    // would leave the operator unable to tell a failed count from a failed
    // delete (L11).
    expect(JSON.stringify(await res.json())).toMatch(/count/i)
  })

  it('refuses to delete when the child-folder count fails', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        folders: [{ single: folder }, { listError: { message: 'statement timeout', code: '57014' } }],
        workflows: { count: 0 },
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )

    const res = await del(app)

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(JSON.stringify(await res.json())).toMatch(/count/i)
  })
})
