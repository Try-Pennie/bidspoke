/**
 * The parity routes (#1413, Phase 6): GET reads the org's rows and nothing
 * else, POST refresh writes counts for the caller's workflows only, and POST
 * sign off records a person's approval against the counts hash they saw, with
 * the function's refusals surfaced by name (L11).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/partner-constants-loader')
vi.mock('../../../lib/buyer-profile-loader')
vi.mock('../../../lib/buyer-select-parity', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/buyer-select-parity')>('../../../lib/buyer-select-parity')
  return { ...actual, runBuyerSelectParityRefreshForEnv: vi.fn() }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { runBuyerSelectParityRefreshForEnv } from '../../../lib/buyer-select-parity'
import { makeSupabase, type TableConfig } from './_supabase-mock'

const testUser = { id: '22222222-2222-4222-8222-222222222222', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: testUser.id, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, IDEMPOTENCY: {} } as unknown as Env
const mockCtx = recordingContext()

const WF = '44444444-4444-4444-8444-444444444444'
const HASH = 'a'.repeat(64)
const row = { workflow_id: WF, et_day: '2027-09-19', organization_id: 'org-abc', sell_off_agree: 10, sell_off_disagree: 0, counts_hash: HASH, window_complete: true, signed_off_at: null, unmeasured: [] }

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function request(app: { request: Function }, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, testEnv, mockCtx)
}

function supabaseWith(tables: Record<string, TableConfig | TableConfig[]>, rpc?: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>) {
  const sb = makeSupabase({ users: { single: testUser }, ...tables }, rpc ? { rpc } : undefined)
  vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
  return sb
}

let app: Awaited<ReturnType<typeof makeApp>>
beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  app = await makeApp()
})

describe('GET /admin/buyer-select/parity', () => {
  it('lists the rows of the caller’s organisation, newest day first, and reads nothing else', async () => {
    const sb = supabaseWith({ buyer_select_parity_days: { list: [row] } })
    const res = await request(app, 'GET', '/admin/buyer-select/parity')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: [row] })
    expect(sb.calls.buyer_select_parity_days).toContainEqual(['eq', ['organization_id', 'org-abc']])
    expect(runBuyerSelectParityRefreshForEnv).not.toHaveBeenCalled()
  })

  it('refuses a workflow_id that is not a uuid by name', async () => {
    supabaseWith({ buyer_select_parity_days: { list: [] } })
    const res = await request(app, 'GET', '/admin/buyer-select/parity?workflow_id=engine')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'workflow_id_invalid' })
  })

  it('a table read that fails is a database error, never an empty list (L10)', async () => {
    supabaseWith({ buyer_select_parity_days: { listError: { message: 'statement timeout', code: '57014' } } })
    const res = await request(app, 'GET', '/admin/buyer-select/parity')
    expect(res.status).toBeGreaterThanOrEqual(500)
  })
})

describe('POST /admin/buyer-select/parity/refresh', () => {
  it('refreshes every one of the caller\'s workflows and days with an empty body, and no other organisation\'s, and returns the summary', async () => {
    supabaseWith({})
    vi.mocked(runBuyerSelectParityRefreshForEnv).mockResolvedValue({ days: ['2027-09-20', '2027-09-19'], rows_written: 2, errors: [], kept_final: [] })
    const res = await request(app, 'POST', '/admin/buyer-select/parity/refresh', {})
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ rows_written: 2 })
    expect(runBuyerSelectParityRefreshForEnv).toHaveBeenCalledWith(expect.anything(), testEnv, { organizationId: 'org-abc' })
  })

  it('a refresh of a named workflow is scoped to the caller’s organisation: another org’s workflow is not found', async () => {
    supabaseWith({ workflows: { maybeSingle: null } })
    const res = await request(app, 'POST', '/admin/buyer-select/parity/refresh', { workflow_id: WF })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'workflow_not_found' })
    expect(runBuyerSelectParityRefreshForEnv).not.toHaveBeenCalled()
  })

  it('passes the named workflow and day through, and answers 207 when a day could not be written', async () => {
    supabaseWith({ workflows: { maybeSingle: { id: WF } } })
    vi.mocked(runBuyerSelectParityRefreshForEnv).mockResolvedValue({ days: ['2027-09-19'], rows_written: 0, errors: [`${WF} 2027-09-19: execution_steps: statement timeout`], kept_final: [] })
    const res = await request(app, 'POST', '/admin/buyer-select/parity/refresh', { workflow_id: WF, day: '2027-09-19' })
    expect(res.status).toBe(207)
    expect(runBuyerSelectParityRefreshForEnv).toHaveBeenCalledWith(expect.anything(), testEnv, { organizationId: 'org-abc', workflowId: WF, day: '2027-09-19' })
  })

  it('refuses a day that is not a calendar date by name', async () => {
    supabaseWith({})
    const res = await request(app, 'POST', '/admin/buyer-select/parity/refresh', { day: 'yesterday' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'day_invalid' })
  })
})

describe('POST /admin/buyer-select/parity/:workflow_id/:day/sign-off', () => {
  it('records the sign off through the function with the caller as actor and the hash they saw', async () => {
    const rpc = vi.fn(async () => ({ data: { ...row, signed_off_at: '2027-09-20T16:00:00Z', signed_off_by: testUser.id, sign_off_counts_hash: HASH }, error: null }))
    supabaseWith({}, rpc)
    const res = await request(app, 'POST', `/admin/buyer-select/parity/${WF}/2027-09-19/sign-off`, { counts_hash: HASH, note: 'one replayed lead, explained' })
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('sign_off_buyer_select_parity_day', { p_workflow: WF, p_day: '2027-09-19', p_org: 'org-abc', p_actor: testUser.id, p_counts_hash: HASH, p_note: 'one replayed lead, explained' })
    expect(await res.json()).toMatchObject({ row: { signed_off_by: testUser.id } })
  })

  it('a hash that moved is a 409 carrying the current hash, so the person re-reads before approving (L641)', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'BP409', message: 'counts_changed', details: 'b'.repeat(64) } }))
    supabaseWith({}, rpc)
    const res = await request(app, 'POST', `/admin/buyer-select/parity/${WF}/2027-09-19/sign-off`, { counts_hash: HASH })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'counts_changed', current_counts_hash: 'b'.repeat(64) })
  })

  it('a day with no row is a 404 by name, and a missing or malformed hash is refused before the function is called', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'P0002', message: 'parity_day_not_found' } }))
    supabaseWith({}, rpc)
    const missing = await request(app, 'POST', `/admin/buyer-select/parity/${WF}/2027-01-01/sign-off`, { counts_hash: HASH })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'parity_day_not_found' })
    const bad = await request(app, 'POST', `/admin/buyer-select/parity/${WF}/2027-09-19/sign-off`, { counts_hash: 'not-a-hash' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'counts_hash_required' })
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
