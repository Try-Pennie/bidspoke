/**
 * GET /api/partners/:id/workflow-values (#2142): every value the Constants node
 * emits for the partner, with the workflows that read it. JWT and organization
 * scoped; the Worker is service_role, so the route filters the organization.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { makeSupabase, type TableConfig } from './_supabase-mock'
import { PARTNER_CONSTANT_KINDS, PARTNER_CONSTANT_MAPS } from '../../../engine/nodes/constants'

const ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {} } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

const tripoint = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'tripoint',
  sell_off_offer_title: null,
  sell_off_offer_details: null,
  click_url: 'https://trypennie.com/portal/tpl',
  is_active: true,
  sub_account_min_bids: { 'uuid-1': 4 },
}

const wfRow = (id: string, nodes: unknown[], over: Record<string, unknown> = {}) => ({
  id,
  name: `Workflow ${id}`,
  is_active: true,
  definition: { nodes, edges: [] },
  organization_id: ORG,
  deleted_at: null,
  ...over,
})
const constantsNode = { id: 'c', namespace: 'constants', type: 'constants', config: { data: {} } }
const reads = (script: string) => [constantsNode, { id: 'r', namespace: 'reader', type: 'code', config: { script } }]

function supabaseWith(tables: Record<string, TableConfig | TableConfig[]>) {
  const sb = makeSupabase({ users: { single: testUser }, ...tables })
  vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
  return sb
}

async function get(path: string) {
  const { default: api } = await import('../index')
  return api.request(path, { method: 'GET', headers: { Authorization: 'Bearer tok' } }, testEnv, mockCtx)
}

interface Answer {
  partner: { id: string; slug: string }
  values: Array<{ constant_name: string; kind: string; emitted: boolean; value: unknown; readers: Array<{ workflow_id: string; is_active: boolean; reads: string }>; readers_outside_workflows: Array<{ reader: string }> }>
  searched: { workflows: number; with_constants_node: number }
}

beforeEach(() => {
  vi.mocked(verifyJwt).mockResolvedValue(validPayload as Awaited<ReturnType<typeof verifyJwt>>)
})
afterEach(() => vi.clearAllMocks())

describe('GET /api/partners/:id/workflow-values', () => {
  it('requires a signed in caller', async () => {
    const { default: api } = await import('../index')
    const res = await api.request('/partners/11111111-1111-4111-8111-111111111111/workflow-values', { method: 'GET' }, testEnv, mockCtx)
    expect(res.status).toBe(401)
  })

  it("is a 404 for another organization's partner id, read by id and organization", async () => {
    const sb = supabaseWith({ partner_configs: { single: null } })
    const res = await get('/partners/22222222-2222-4222-8222-222222222222/workflow-values')
    expect(res.status).toBe(404)
    expect(sb.eqCalls.partner_configs).toEqual(expect.arrayContaining([['id', '22222222-2222-4222-8222-222222222222'], ['organization_id', ORG]]))
  })

  it('answers every value the Constants node can emit for the partner, with its value as emitted now', async () => {
    supabaseWith({
      partner_configs: { single: tripoint },
      partner_uuid_map: { list: [{ uuid: 'uuid-1', partner_slug: 'tripoint' }] },
      workflows: { list: [] },
    })
    const res = await get('/partners/11111111-1111-4111-8111-111111111111/workflow-values')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Answer
    expect(body.partner).toEqual({ id: '11111111-1111-4111-8111-111111111111', slug: 'tripoint' })
    expect(body.values.map((v) => v.kind)).toEqual([...PARTNER_CONSTANT_KINDS, ...PARTNER_CONSTANT_MAPS])
    const byKey = Object.fromEntries(body.values.map((v) => [v.constant_name, v]))
    expect(byKey.TripointClickUrl).toMatchObject({ emitted: true, value: 'https://trypennie.com/portal/tpl' })
    expect(byKey.TripointSellOffOfferTitle).toMatchObject({ emitted: false, value: null })
    expect(byKey.TripointSubAccountMinBids).toMatchObject({ emitted: true, value: { 'uuid-1': 4 } })
    expect(byKey.activeBidding).toMatchObject({ emitted: true, value: true })
    expect(byKey.subAccountIdsMap).toMatchObject({ emitted: true, value: { 'uuid-1': 'tripoint' } })
    expect(byKey.TripointClickUrl.readers_outside_workflows.map((r) => r.reader)).toEqual(['buyer_select', 'buyer_click_check', 'click_alert'])
    expect(byKey.TripointSellOffOfferTitle.readers_outside_workflows).toEqual([])
    expect(body.searched).toEqual({ workflows: 0, with_constants_node: 0 })
  })

  it("reads the partner's sub-account ids by organization and slug", async () => {
    const sb = supabaseWith({ partner_configs: { single: tripoint }, partner_uuid_map: { list: [] }, workflows: { list: [] } })
    await get('/partners/11111111-1111-4111-8111-111111111111/workflow-values')
    expect(sb.eqCalls.partner_uuid_map).toEqual([['org_id', ORG], ['partner_slug', 'tripoint']])
  })

  it('lists the reading workflows, inactive ones included and marked, and counts what was searched', async () => {
    supabaseWith({
      partner_configs: { single: tripoint },
      partner_uuid_map: { list: [] },
      workflows: {
        list: [
          wfRow('live', reads('return constants.TripointClickUrl')),
          wfRow('draft', reads('return steps.constants.output.TripointClickUrl'), { is_active: false }),
          wfRow('other', [{ id: 'x', namespace: 'x', type: 'code', config: { script: 'constants.TripointClickUrl' } }]),
        ],
      },
    })
    const body = (await (await get('/partners/11111111-1111-4111-8111-111111111111/workflow-values')).json()) as Answer
    const click = body.values.find((v) => v.constant_name === 'TripointClickUrl')
    expect(click?.readers.map((r) => [r.workflow_id, r.is_active, r.reads])).toEqual([['live', true, 'by_name'], ['draft', false, 'by_name']])
    expect(body.searched).toEqual({ workflows: 3, with_constants_node: 2 })
  })

  it('never counts a soft deleted workflow or one of another organization', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sb = supabaseWith({
      partner_configs: { single: tripoint },
      partner_uuid_map: { list: [] },
      workflows: {
        list: [
          wfRow('gone', reads('constants.TripointClickUrl'), { deleted_at: '2026-10-01T00:00:00Z' }),
          wfRow('theirs', reads('constants.TripointClickUrl'), { organization_id: 'org-other' }),
        ],
      },
    })
    const body = (await (await get('/partners/11111111-1111-4111-8111-111111111111/workflow-values')).json()) as Answer
    expect(body.values.flatMap((v) => v.readers)).toEqual([])
    expect(body.searched.workflows).toBe(0)
    expect(sb.calls.workflows).toEqual(expect.arrayContaining([['eq', ['organization_id', ORG]], ['is', ['deleted_at', null]]]))
  })

  it('reads past the 1,000 row cap of workflows', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => wfRow(`w${String(i).padStart(4, '0')}`, []))
    supabaseWith({
      partner_configs: { single: tripoint },
      partner_uuid_map: { list: [] },
      workflows: [{ list: page1 }, { list: [wfRow('last', reads('constants.TripointClickUrl'))] }],
    })
    const body = (await (await get('/partners/11111111-1111-4111-8111-111111111111/workflow-values')).json()) as Answer
    expect(body.searched.workflows).toBe(1001)
    expect(body.values.find((v) => v.constant_name === 'TripointClickUrl')?.readers.map((r) => r.workflow_id)).toEqual(['last'])
  })

  it('a failed workflows read is a failed answer, never an empty list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ partner_configs: { single: tripoint }, partner_uuid_map: { list: [] }, workflows: { listError: { message: 'timeout' } } })
    const res = await get('/partners/11111111-1111-4111-8111-111111111111/workflow-values')
    expect(res.status).toBe(500)
  })

  it('a failed sub-account read is a failed answer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ partner_configs: { single: tripoint }, partner_uuid_map: { listError: { message: 'timeout' } }, workflows: { list: [] } })
    const res = await get('/partners/11111111-1111-4111-8111-111111111111/workflow-values')
    expect(res.status).toBe(500)
  })

  it('an id that is not a uuid is a 404, and nothing is read (as the usage route answers it)', async () => {
    const sb = supabaseWith({ partner_configs: { single: tripoint }, workflows: { list: [] } })
    const res = await get('/partners/not-a-uuid/workflow-values')
    expect(res.status).toBe(404)
    expect(sb.calls.partner_configs ?? []).toEqual([])
    expect(sb.calls.workflows ?? []).toEqual([])
  })

  it('a failed partner read is a 500, not a 404', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ partner_configs: { singleError: { message: 'connection reset' } } })
    const res = await get('/partners/11111111-1111-4111-8111-111111111111/workflow-values')
    expect(res.status).toBe(500)
  })
})
