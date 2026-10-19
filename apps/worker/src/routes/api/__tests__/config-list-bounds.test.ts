/**
 * Every organization config list a route reads is read whole or refused (#1437 P6).
 *
 * Each list used to be a bare read, so past PostgREST's 1,000 row cap it came back
 * cut and the page showed a list missing rows that exist, looking complete. Now
 * each goes through fetchUpTo with its bound from config-list-bounds.ts: it asks
 * for one row more than the bound, and a list holding more than the bound answers
 * 500 with an api_error log line naming the read, never the first rows. A list at
 * its bound is answered whole. That refusal is a behaviour change, tested here
 * route by route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../engine/definition-loader')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { loadWorkflowDefinition } from '../../../engine/definition-loader'
import { CONFIG_LIST_BOUNDS } from '../../../lib/config-list-bounds'
import { makeSupabase, type TableConfig } from './_supabase-mock'

const testUser = { id: 'user-1', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {} } as unknown as Env
const mockCtx = recordingContext()

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function request(app: { request: Function }, method: string, path: string, body?: unknown) {
  return app.request(
    path,
    { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: body === undefined ? undefined : JSON.stringify(body) },
    testEnv,
    mockCtx,
  )
}

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `n${i}`, key: `k${i}`, workflow_id: `wf-${i}`, source_name: 's', is_secret: false }))

interface ListCase {
  route: string
  table: string
  bound: number
  /** Other tables the route reads on its way, configured to answer. */
  extra?: Record<string, TableConfig>
}

const CASES: ListCase[] = [
  { route: '/workflows', table: 'workflows', bound: CONFIG_LIST_BOUNDS.workflows },
  { route: '/executions', table: 'workflows', bound: CONFIG_LIST_BOUNDS.workflows },
  { route: '/env', table: 'environment_variables', bound: CONFIG_LIST_BOUNDS.environmentVariables },
  { route: '/env-folders', table: 'env_var_folders', bound: CONFIG_LIST_BOUNDS.envVarFolders },
  { route: '/folders', table: 'folders', bound: CONFIG_LIST_BOUNDS.folders },
  { route: '/endpoints', table: 'webhook_endpoints', bound: CONFIG_LIST_BOUNDS.webhookEndpoints },
  { route: '/partner-bid-configs', table: 'partner_bid_configs', bound: CONFIG_LIST_BOUNDS.partnerBidConfigs },
  { route: '/partner-uuids', table: 'partner_uuid_map', bound: CONFIG_LIST_BOUNDS.partnerUuids },
  { route: '/partners', table: 'partner_configs', bound: CONFIG_LIST_BOUNDS.partnerConfigs },
  { route: '/service-presets', table: 'service_presets', bound: CONFIG_LIST_BOUNDS.servicePresets },
  { route: '/sources', table: 'api_sources', bound: CONFIG_LIST_BOUNDS.apiSources },
  { route: '/sources/assignments', table: 'source_workflow_assignments', bound: CONFIG_LIST_BOUNDS.sourceAssignments },
  { route: '/sources/s/workflows', table: 'source_workflow_assignments', bound: CONFIG_LIST_BOUNDS.sourceAssignments },
  { route: '/access', table: 'user_allowlist', bound: CONFIG_LIST_BOUNDS.allowlist },
  {
    route: '/workflows/wf-1/rename-impact?old=a&new=b',
    table: 'partner_configs',
    bound: CONFIG_LIST_BOUNDS.partnerConfigs,
    extra: { workflows: { single: { id: 'wf-1' } } },
  },
]

describe('organization config lists are read whole or refused (#1437 P6)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  let logged: string[]

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    logged = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
    app = await makeApp()
  })
  afterEach(() => vi.restoreAllMocks())

  function serve(c: ListCase, rows: number) {
    const sb = makeSupabase({ users: { single: testUser }, ...c.extra, [c.table]: { list: rowsOf(rows) } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    return sb
  }

  it.each(CASES)('GET $route asks $table for one row past its bound and refuses a list holding more', async (c) => {
    const sb = serve(c, c.bound + 1)
    const res = await request(app, 'GET', c.route)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
    expect(sb.calls[c.table]).toContainEqual(['limit', [c.bound + 1]])
    // The log line names the read and its bound, so the refusal can be traced to the list that outgrew it.
    expect(logged.some((l) => l.includes('api_error') && l.includes(`holds more than ${c.bound} rows`))).toBe(true)
  })

  it.each(CASES)('GET $route answers a list at its bound whole', async (c) => {
    serve(c, c.bound)
    const res = await request(app, 'GET', c.route)
    expect(res.status).toBe(200)
  })
})

describe('the buyer profile read of the other offer buyers is bounded (#1437 P6)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    app = await makeApp()
  })
  afterEach(() => vi.restoreAllMocks())

  const partnerRow = { id: 'p-1', slug: 'tripoint', is_active: true, accept_signals: [], click_url: null, external_routing_code: 2, organization_id: 'org-abc' }
  const offerRow = (i: number) => ({ partner_id: `p-${i + 2}`, priority: 1, partner_configs: { name: `B${i}`, is_active: true } })

  function serve(rows: number) {
    const sb = makeSupabase(
      { users: { single: testUser }, partner_configs: { single: partnerRow }, workflows: { list: [] }, buyer_profiles: { list: Array.from({ length: rows }, (_, i) => offerRow(i)) } },
      { rpc: async () => ({ data: null, error: null }) },
    )
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    return sb
  }

  it('refuses rather than naming where this buyer stands among a cut list', async () => {
    const sb = serve(CONFIG_LIST_BOUNDS.buyerProfiles + 1)
    const res = await request(app, 'GET', '/partners/p-1/buyer-profile')
    expect(res.status).toBe(500)
    expect(sb.calls.buyer_profiles).toContainEqual(['limit', [CONFIG_LIST_BOUNDS.buyerProfiles + 1]])
  })

  it('answers a list at its bound', async () => {
    serve(CONFIG_LIST_BOUNDS.buyerProfiles)
    const res = await request(app, 'GET', '/partners/p-1/buyer-profile')
    expect(res.status).toBe(200)
  })
})

describe('the field coverage silences are bounded, and a failed read is no longer read as no silences (#1437 P6)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  const DEFINITION = {
    id: 'wf-1',
    name: 'wf',
    trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } },
    nodes: [{ id: 'n1', namespace: 'r', type: 'response', config: { body: '{{steps.x.output.final}}' } }],
    edges: [],
  }
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(loadWorkflowDefinition).mockResolvedValue({ definition: DEFINITION } as any)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    app = await makeApp()
  })
  afterEach(() => vi.restoreAllMocks())

  function serve(silences: TableConfig) {
    const sb = makeSupabase({
      users: { single: testUser },
      workflows: { maybeSingle: { id: 'wf-1' } },
      field_presence_daily: { list: [] },
      field_presence_silences: silences,
    })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    return sb
  }
  const silence = (i: number) => ({ field_path: `f${i}`, reason: 'r', created_at: '2026-10-19T00:00:00Z' })

  it('refuses a workflow holding more silences than its bound', async () => {
    const sb = serve({ list: Array.from({ length: CONFIG_LIST_BOUNDS.fieldSilences + 1 }, (_, i) => silence(i)) })
    const res = await request(app, 'GET', '/field-coverage/wf-1')
    expect(res.status).toBe(500)
    expect(sb.calls.field_presence_silences).toContainEqual(['limit', [CONFIG_LIST_BOUNDS.fieldSilences + 1]])
  })

  it('answers 500 on a failed silences read, rather than showing every field as unsilenced', async () => {
    serve({ listError: { message: 'boom' } })
    const res = await request(app, 'GET', '/field-coverage/wf-1')
    expect(res.status).toBe(500)
  })

  it('answers silences at the bound', async () => {
    serve({ list: Array.from({ length: CONFIG_LIST_BOUNDS.fieldSilences }, (_, i) => silence(i)) })
    const res = await request(app, 'GET', '/field-coverage/wf-1')
    expect(res.status).toBe(200)
  })
})

// The rename's partner ids come straight from the request body. Before #1437 P6
// any number was accepted and the read of them was cut at the row cap, so a body
// naming more than 1,000 ids renamed only some. The request is now refused past
// the bound, before anything is read or written.
describe('POST /workflows/:id/rename-apply bounds partner_ids (#1437 P6)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    app = await makeApp()
  })
  afterEach(() => vi.restoreAllMocks())

  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p-${i}`)
  function serve() {
    const sb = makeSupabase({ users: { single: testUser }, workflows: { single: { id: 'wf-1' } }, partner_configs: { list: [] } })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    return sb
  }

  it('refuses a body naming more partners than the bound with a 400, reading nothing', async () => {
    const sb = serve()
    const res = await request(app, 'POST', '/workflows/wf-1/rename-apply', { old: 'a', new: 'b', partner_ids: ids(CONFIG_LIST_BOUNDS.partnerConfigs + 1) })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: `partner_ids may name at most ${CONFIG_LIST_BOUNDS.partnerConfigs} partners` })
    expect(sb.calls.partner_configs).toBeUndefined()
  })

  it('reads the named partners, at most the bound, when the body is within it', async () => {
    const sb = serve()
    const res = await request(app, 'POST', '/workflows/wf-1/rename-apply', { old: 'a', new: 'b', partner_ids: ids(CONFIG_LIST_BOUNDS.partnerConfigs) })
    expect(res.status).toBe(200)
    expect(sb.calls.partner_configs).toContainEqual(['limit', [CONFIG_LIST_BOUNDS.partnerConfigs + 1]])
  })
})
