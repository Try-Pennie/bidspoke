/**
 * GET /partners/:id/usage (#2137): which of the organization's workflows name a
 * partner, per node kind, so the partners page shows the Bid Group tab and the
 * confirmation window only where they apply. Drafts and switched off workflows
 * count (a workflow switched on again calls the partner at once); soft deleted
 * ones and other organizations' never do. The Worker is service_role, so the
 * route's own filters are the scoping.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { makeSupabase, type TableConfig } from './_supabase-mock'

const ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const env = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

const partner = { id: 'p-1', organization_id: ORG }
const wf = (id: string, nodes: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  id, name: `Workflow ${id}`, is_active: true, organization_id: ORG, deleted_at: null, definition: { nodes }, ...over,
})

let api: Awaited<typeof import('../index')>['default']
beforeAll(async () => { api = (await import('../index')).default }, 60_000)

function supabaseWith(tables: Record<string, TableConfig | TableConfig[]>) {
  const sb = makeSupabase({ users: { single: testUser }, ...tables })
  vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
  return sb
}

const get = (id = 'p-1') => api.request(`/partners/${id}/usage`, { headers: { Authorization: 'Bearer tok' } }, env, mockCtx)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
})

describe('GET /partners/:id/usage', () => {
  it('answers each node kind from its own predicate, drafts included', async () => {
    supabaseWith({
      partner_configs: { single: partner },
      workflows: { list: [
        wf('main', [{ id: 'n1', type: 'bid_group', config: { mode: 'highest_bid', partner_ids: ['p-1', 'p-2'] } }]),
        wf('draft', [{ id: 'n2', type: 'bid_group', config: { mode: 'cascade', partner_ids: ['p-3'], fallback_partner_id: 'p-1' } }], { is_active: false }),
        wf('le', [{ id: 'n3', type: 'partner_bid', config: { partner_id: 'p-1' } }, { id: 'n4', type: 'latency_gate', config: { mode: 'check', partner_id: 'p-1' } }]),
        wf('other', [{ id: 'n5', type: 'bid_group', config: { partner_ids: ['p-2'] } }, { id: 'n6', type: 'latency_gate', config: { partner_id: 'p-2' } }]),
      ] },
    })
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      bid_group: [
        { workflow_id: 'main', workflow_name: 'Workflow main', is_active: true, node_id: 'n1', mode: 'highest_bid', partner_ids: ['p-1', 'p-2'] },
        { workflow_id: 'draft', workflow_name: 'Workflow draft', is_active: false, node_id: 'n2', mode: 'cascade', partner_ids: ['p-3', 'p-1'] },
      ],
      partner_bid: [{ workflow_id: 'le', workflow_name: 'Workflow le', is_active: true, node_id: 'n3' }],
      latency_gate: [{ workflow_id: 'le', workflow_name: 'Workflow le', is_active: true, node_id: 'n4' }],
    })
  })

  it('a partner named only by a partner_bid node is in partner_bid alone', async () => {
    supabaseWith({ partner_configs: { single: partner }, workflows: { list: [wf('le', [{ id: 'n', type: 'partner_bid', config: { partner_id: 'p-1' } }])] } })
    const body = await (await get()).json() as Record<string, unknown[]>
    expect([body.bid_group.length, body.partner_bid.length, body.latency_gate.length]).toEqual([0, 1, 0])
  })

  it('a partner named only by a Latency Gate is in latency_gate alone', async () => {
    supabaseWith({ partner_configs: { single: partner }, workflows: { list: [wf('gate', [{ id: 'n', type: 'latency_gate', config: { mode: 'check', partner_id: 'p-1' } }])] } })
    const body = await (await get()).json() as Record<string, unknown[]>
    expect([body.bid_group.length, body.partner_bid.length, body.latency_gate.length]).toEqual([0, 0, 1])
  })

  it('reads the workflows through the organization and deleted_at scoped read, and a soft deleted workflow is not counted', async () => {
    const sb = supabaseWith({
      partner_configs: { single: partner },
      workflows: { list: [wf('gone', [{ id: 'n', type: 'bid_group', config: { partner_ids: ['p-1'] } }], { deleted_at: '2026-10-01T00:00:00Z' })] },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = await (await get()).json() as Record<string, unknown[]>
    expect(body).toEqual({ bid_group: [], partner_bid: [], latency_gate: [] })
    expect(sb.calls.workflows).toContainEqual(['eq', ['organization_id', ORG]])
    expect(sb.calls.partner_configs).toContainEqual(['eq', ['organization_id', ORG]])
  })

  it('another organization\'s workflows are not counted, even if the read let one through', async () => {
    supabaseWith({
      partner_configs: { single: partner },
      workflows: { list: [wf('theirs', [{ id: 'n', type: 'bid_group', config: { partner_ids: ['p-1'] } }], { organization_id: 'org-other' })] },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await (await get()).json()).toEqual({ bid_group: [], partner_bid: [], latency_gate: [] })
  })

  it('another organization\'s partner id is a 404, and no workflow is read', async () => {
    const sb = supabaseWith({ partner_configs: { single: null }, workflows: { list: [wf('main', [{ id: 'n', type: 'bid_group', config: { partner_ids: ['p-9'] } }])] } })
    const res = await get('p-9')
    expect(res.status).toBe(404)
    expect(sb.calls.workflows ?? []).toEqual([])
  })

  it('a failed read is an error, never an empty answer (L10)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ partner_configs: { single: partner }, workflows: { listError: { message: 'timeout', code: '57014' } } })
    expect((await get()).status).toBeGreaterThanOrEqual(500)
    supabaseWith({ partner_configs: { singleError: { message: 'timeout', code: '57014' } } })
    expect((await get()).status).toBeGreaterThanOrEqual(500)
  })

  it('is refused without a token', async () => {
    vi.mocked(verifyJwt).mockRejectedValue(new Error('bad token'))
    supabaseWith({ partner_configs: { single: partner } })
    expect((await get()).status).toBe(401)
  })
})
