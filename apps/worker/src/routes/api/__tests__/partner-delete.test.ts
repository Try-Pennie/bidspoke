/**
 * The partner delete routes (#2140): GET /partners/:id/delete-check and
 * DELETE /partners/:id, against a fake Supabase and fake Durable Objects that
 * keep their state, so a reset can be seen to start a re-created slug fresh.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/partner-constants-loader')
vi.mock('../../../lib/buyer-profile-loader', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/buyer-profile-loader')>('../../../lib/buyer-profile-loader')
  return { ...actual, loadBuyerProfiles: vi.fn(), refreshBuyerProfilesCache: vi.fn() }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { invalidatePartnerConstantsCache } from '../../../lib/partner-constants-loader'
import { refreshBuyerProfilesCache, type BuyerProfilesSnapshot } from '../../../lib/buyer-profile-loader'
import { dailyCapObjectName } from '../../../lib/daily-cap-name'
import { COPY_NOT_CLEARED_MESSAGE } from '../../../lib/stored-copy'
import { DELETE_CHECK_FAILED_MESSAGE, CONSEQUENCE_CHANGED_MESSAGE } from '../partner-delete'
import type { PartnerDeleteCheck, PartnerDeleted, PartnerDeleteRefused } from '../../../lib/partner-delete-shape'
import labels from '../../../partner-delete/labels/dependents.json'
import { makeSupabase } from './_supabase-mock'

const ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
const NOW = new Date('2026-10-15T16:00:00Z')
const PARTNER = { id: 'p-tp', name: 'Tripoint', slug: 'tripoint', partner_type: 'buyer', is_active: true }

/** The SQL check's answer, every labelled table, with these counts. */
function rpcCheck(rows: Partial<Record<string, number>> = {}, blocking: Partial<Record<string, number>> = {}) {
  return {
    partner: PARTNER,
    dependents: Object.keys(labels.tables).map((table) => ({
      table,
      kind: table === 'buyer_sales' || table === 'held_click_claims' ? 'blocks' : 'deleted',
      rows: rows[table] ?? blocking[table] ?? 0,
      blocking_rows: blocking[table] ?? 0,
    })),
    secret: { name: 'TRIPOINT_PROXY_SECRET', other_partners: 0 },
  }
}

const workflowRow = (id: string, nodes: unknown[], updated_at = '2026-10-15T12:00:00.123456+00:00') => ({
  id, name: `Flow ${id}`, is_active: true, definition: { nodes, edges: [] }, updated_at, organization_id: ORG, deleted_at: null,
})

/** A Durable Object namespace whose objects keep state by name. */
function objects(handle: (name: string, path: string, state: Map<string, unknown>) => Response) {
  const state = new Map<string, unknown>()
  const names: string[] = []
  return {
    state,
    names,
    ns: {
      idFromName: (n: string) => { names.push(n); return n },
      get: (n: string) => ({ fetch: async (url: string) => handle(n, new URL(url).pathname, state) }),
    },
  }
}

interface World {
  check: unknown
  checkError?: { code: string; message: string }
  deleteError?: { code: string; message: string; details?: string }
  workflows?: Record<string, unknown>[]
  workflowsError?: { message: string }
  uuids?: Array<{ uuid: string }>
  ledger?: { unmirrored: number; unresolved: number } | 'down'
  partnerRow?: Record<string, unknown> | null
  capFails?: boolean
  breakerFails?: boolean
}

function setup(world: World) {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'partner_delete_check') return world.checkError ? { data: null, error: world.checkError } : { data: world.check, error: null }
    if (name === 'delete_partner_config') return world.deleteError ? { data: null, error: world.deleteError } : { data: null, error: null }
    return { data: null, error: null }
  })
  const sb = makeSupabase(
    {
      users: { single: testUser },
      workflows: world.workflowsError ? { listError: world.workflowsError } : { list: world.workflows ?? [] },
      partner_uuid_map: { list: world.uuids ?? [] },
      partner_configs: { single: world.partnerRow === undefined ? { id: PARTNER.id, name: PARTNER.name, slug: PARTNER.slug } : world.partnerRow },
    },
    { rpc }
  )
  vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)

  const ledger = objects((_n, path) => {
    const counts = world.ledger ?? { unmirrored: 0, unresolved: 0 }
    if (counts === 'down') return new Response('boom', { status: 500 })
    const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ lead_key: `l${i}` }))
    if (path === '/unmirrored') return Response.json({ entries: entries(counts.unmirrored), oldest_age_ms: null })
    if (path === '/unresolved') return Response.json({ entries: entries(counts.unresolved) })
    return new Response('not found', { status: 404 })
  })
  const cap = objects((n, path, state) => {
    if (world.capFails) return new Response('boom', { status: 500 })
    if (path === '/reset') { state.set(n, 0); return Response.json({ ok: true, count: 0 }) }
    if (path === '/get-count') return Response.json({ count: state.get(n) ?? 0 })
    return new Response('not found', { status: 404 })
  })
  const breaker = objects((n, path, state) => {
    if (world.breakerFails) return new Response('boom', { status: 500 })
    if (path === '/reset') { state.set(n, 'closed'); return new Response(null, { status: 200 }) }
    if (path === '/status') return Response.json({ state: state.get(n) ?? 'closed' })
    return new Response('not found', { status: 404 })
  })
  const kv = { delete: vi.fn(async () => undefined), get: vi.fn(async () => null), put: vi.fn(async () => undefined) }
  const env = { SUPABASE_JWKS_URL: 'https://fake.jwks', BUYER_LEDGER: ledger.ns, DAILY_CAP: cap.ns, CIRCUIT_BREAKER: breaker.ns, WORKFLOW_CACHE: kv } as unknown as Env
  return { rpc, ledger, cap, breaker, env, sb }
}

async function call(env: Env, method: string, path: string, body?: unknown) {
  const { default: api } = await import('../index')
  return api.request(path, { method, headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env, mockCtx)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  vi.mocked(invalidatePartnerConstantsCache).mockResolvedValue(undefined)
  vi.mocked(refreshBuyerProfilesCache).mockResolvedValue({ buyers: [] } as unknown as BuyerProfilesSnapshot)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('GET /partners/:id/delete-check', () => {
  it('asks the SQL check for this organization\'s partner and answers the consequence and the fingerprint', async () => {
    const w = setup({ check: rpcCheck({ partner_uuid_map: 2, buyer_profiles: 1 }), workflows: [workflowRow('w1', [])], uuids: [{ uuid: 'u1' }, { uuid: 'u2' }] })
    const res = await call(w.env, 'GET', '/partners/p-tp/delete-check')
    expect(res.status).toBe(200)
    const body = await res.json() as PartnerDeleteCheck
    expect(w.rpc).toHaveBeenCalledWith('partner_delete_check', { p_org: ORG, p_id: 'p-tp' })
    expect(body.blockers).toEqual([])
    expect(body.removes.map((r) => [r.table, r.rows])).toEqual([['buyer_profiles', 1], ['partner_uuid_map', 2]])
    expect(body.fingerprint.workflows).toEqual([{ id: 'w1', updated_at: '2026-10-15T12:00:00.123456+00:00' }])
    expect(body.fingerprint.counts.partner_uuid_map).toBe(2)
    // The ledger asked is this partner's.
    expect(w.ledger.names).toEqual(['buyer:p-tp'])
  })

  it('lists a workflow reading constants.<Slug>SellOffOfferTitle that names no partner id', async () => {
    const reader = workflowRow('w-read', [{ id: 'c', namespace: 'constants', type: 'constants', config: { data: {} } }, { id: 'r', namespace: 'r', type: 'code', config: { script: 'return constants.TripointSellOffOfferTitle' } }])
    const w = setup({ check: rpcCheck(), workflows: [reader] })
    const body = await (await call(w.env, 'GET', '/partners/p-tp/delete-check')).json() as PartnerDeleteCheck
    expect(body.workflows_naming_partner).toEqual([])
    expect(body.workflows_reading_values).toEqual([{ id: 'w-read', name: 'Flow w-read', is_active: true, reads: 'by_name', values: ['TripointSellOffOfferTitle'] }])
  })

  it('blocks a buyer with one unmirrored ledger entry and no buyer_sales row', async () => {
    const w = setup({ check: rpcCheck(), ledger: { unmirrored: 1, unresolved: 0 } })
    const body = await (await call(w.env, 'GET', '/partners/p-tp/delete-check')).json() as PartnerDeleteCheck
    expect(body.blockers).toEqual([{ kind: 'ledger_unmirrored', count: 1 }])
  })

  it('a failed part is a failed check (503 with the message), never an empty list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const world of [
      { check: rpcCheck(), checkError: { code: '57014', message: 'timeout' } },
      { check: rpcCheck(), workflowsError: { message: 'connection refused' } },
      { check: rpcCheck(), ledger: 'down' as const },
      { check: { partner: PARTNER } },
      { check: { ...rpcCheck(), dependents: [...rpcCheck().dependents, { table: 'unlabelled_child', kind: 'deleted', rows: 0, blocking_rows: 0 }] } },
    ]) {
      const res = await call(setup(world).env, 'GET', '/partners/p-tp/delete-check')
      expect(res.status, JSON.stringify(world).slice(0, 80)).toBe(503)
      expect(await res.json()).toEqual({ error: DELETE_CHECK_FAILED_MESSAGE })
    }
  })

  it('another organization\'s partner is a 404, and its ledger is never asked', async () => {
    const w = setup({ check: null, checkError: { code: 'P0002', message: 'partner_not_found' } })
    const res = await call(w.env, 'GET', '/partners/p-theirs/delete-check')
    expect(res.status).toBe(404)
    expect(w.ledger.names).toEqual([])
  })
})

describe('DELETE /partners/:id', () => {
  const FP = { counts: { partner_uuid_map: 2 }, workflows: [{ id: 'w1', updated_at: '2026-10-15T12:00:00.123456+00:00' }] }

  it('refuses a delete with no fingerprint (a page from before #2140), deleting nothing', async () => {
    const w = setup({ check: rpcCheck() })
    const res = await call(w.env, 'DELETE', '/partners/p-tp')
    expect(res.status).toBe(400)
    expect(w.rpc).not.toHaveBeenCalledWith('delete_partner_config', expect.anything())
  })

  it('sends the fingerprint, clears the stored copies inside copyCleared, and resets the slug\'s cap and breaker', async () => {
    const w = setup({ check: rpcCheck() })
    const res = await call(w.env, 'DELETE', '/partners/p-tp', { fingerprint: FP })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true } satisfies PartnerDeleted)
    expect(w.rpc).toHaveBeenCalledWith('delete_partner_config', { p_org: ORG, p_id: 'p-tp', p_actor: 'user-1', p_actor_email: 'dan@pennie.com', p_expected: FP })
    expect(vi.mocked(invalidatePartnerConstantsCache)).toHaveBeenCalledWith(ORG, expect.anything())
    expect(vi.mocked(refreshBuyerProfilesCache).mock.calls.map((c) => c[0])).toEqual([ORG])
    expect(w.cap.names).toEqual([dailyCapObjectName('tripoint', NOW.getTime()).name])
    expect(w.breaker.names).toEqual(['circuit-tripoint'])
  })

  it('delete then re-create the same slug: today\'s cap count and the breaker start fresh', async () => {
    const w = setup({ check: rpcCheck() })
    const capName = dailyCapObjectName('tripoint', NOW.getTime()).name
    w.cap.state.set(capName, 250)
    w.breaker.state.set('circuit-tripoint', 'open')
    expect((await call(w.env, 'DELETE', '/partners/p-tp', { fingerprint: FP })).status).toBe(200)
    // A partner created again as tripoint reads the same two objects by name.
    const count = await (await w.env.DAILY_CAP.get(w.env.DAILY_CAP.idFromName(capName)).fetch('http://do/get-count')).json() as { count: number }
    const breaker = await (await w.env.CIRCUIT_BREAKER.get(w.env.CIRCUIT_BREAKER.idFromName('circuit-tripoint')).fetch('http://do/status')).json() as { state: string }
    expect(count.count).toBe(0)
    expect(breaker.state).toBe('closed')
  })

  it('a reset that fails still answers success, with its own warning naming what was not reset', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const capDown = await call(setup({ check: rpcCheck(), capFails: true }).env, 'DELETE', '/partners/p-tp', { fingerprint: FP })
    expect(capDown.status).toBe(200)
    const body = await capDown.json() as PartnerDeleted
    expect(body.state_reset_warning).toBe("Tripoint was deleted, but today's lead count kept under the slug tripoint could not be reset. A partner created again with the slug tripoint today would start with it.")
    expect(body.stored_copy_warning).toBeUndefined()
    const both = await (await call(setup({ check: rpcCheck(), capFails: true, breakerFails: true }).env, 'DELETE', '/partners/p-tp', { fingerprint: FP })).json() as PartnerDeleted
    expect(both.state_reset_warning).toMatch(/today's lead count and the error breaker .* would start with them\.$/)
  })

  it('a stored copy that could not be cleared answers success with stored_copy_warning, never an error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(invalidatePartnerConstantsCache).mockRejectedValueOnce(new Error('kv down'))
    const w = setup({ check: rpcCheck() })
    const res = await call(w.env, 'DELETE', '/partners/p-tp', { fingerprint: FP })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, stored_copy_warning: COPY_NOT_CLEARED_MESSAGE })
    // The profile copy is still rebuilt and the slug's state still reset.
    expect(vi.mocked(refreshBuyerProfilesCache)).toHaveBeenCalledTimes(1)
    expect(w.breaker.names).toEqual(['circuit-tripoint'])
  })

  it('a sale the ledger took after the check refuses before the database is asked', async () => {
    // The DELETE asks the ledger itself: a sale taken after the check is in the
    // ledger and not yet in buyer_sales, so the database alone would not refuse it.
    const w = setup({ check: rpcCheck(), ledger: { unmirrored: 1, unresolved: 0 } })
    const res = await call(w.env, 'DELETE', '/partners/p-tp', { fingerprint: FP })
    expect(res.status).toBe(409)
    const body = await res.json() as PartnerDeleteRefused
    expect(body).toMatchObject({ error: 'blocked', message: 'Tripoint cannot be deleted: 1 sale is not yet recorded.' })
    expect(w.rpc).not.toHaveBeenCalledWith('delete_partner_config', expect.anything())
  })

  it('a sale landing after the check (BP023) answers blocked with the check as it is now', async () => {
    const w = setup({ check: rpcCheck({}, { buyer_sales: 1 }), deleteError: { code: 'BP023', message: 'partner_has_dependents', details: '1 rows in buyer_sales' } })
    const res = await call(w.env, 'DELETE', '/partners/p-tp', { fingerprint: FP })
    expect(res.status).toBe(409)
    const body = await res.json() as PartnerDeleteRefused
    expect(body).toMatchObject({ error: 'blocked', message: 'Tripoint cannot be deleted: 1 sale refers to it.' })
    expect(body.check?.blockers).toEqual([{ kind: 'rows', table: 'buyer_sales', rows: 1, noun: { one: 'sale', many: 'sales' } }])
    expect(vi.mocked(invalidatePartnerConstantsCache)).not.toHaveBeenCalled()
  })

  it('a consequence that moved (BP024) answers the new consequence, so the box re-renders with it', async () => {
    const w = setup({ check: rpcCheck({ partner_uuid_map: 3 }), deleteError: { code: 'BP024', message: 'partner_delete_consequence_changed', details: 'counts' } })
    const res = await call(w.env, 'DELETE', '/partners/p-tp', { fingerprint: FP })
    expect(res.status).toBe(409)
    const body = await res.json() as PartnerDeleteRefused
    expect(body.error).toBe('consequence_changed')
    expect(body.message).toBe(CONSEQUENCE_CHANGED_MESSAGE)
    expect(body.check?.fingerprint.counts.partner_uuid_map).toBe(3)
  })

  it('a refusal whose fresh check cannot be read carries a null check, which the page shows as a failed check', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = setup({ check: rpcCheck(), workflowsError: { message: 'down' }, deleteError: { code: 'BP024', message: 'partner_delete_consequence_changed', details: 'workflows' } })
    const body = await (await call(w.env, 'DELETE', '/partners/p-tp', { fingerprint: FP })).json() as PartnerDeleteRefused
    expect(body.check).toBeNull()
  })

  it('no such partner in this organization is 404; a real database error is 500, never a false 404', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await call(setup({ check: rpcCheck(), partnerRow: null }).env, 'DELETE', '/partners/p-x', { fingerprint: FP })).status).toBe(404)
    expect((await call(setup({ check: rpcCheck(), deleteError: { code: 'P0002', message: 'partner_not_found' } }).env, 'DELETE', '/partners/p-tp', { fingerprint: FP })).status).toBe(404)
    const failed = setup({ check: rpcCheck(), deleteError: { code: '42P01', message: 'relation missing' } })
    expect((await call(failed.env, 'DELETE', '/partners/p-tp', { fingerprint: FP })).status).toBe(500)
    expect(failed.cap.names).toEqual([])
  })

  // A deleted partner must never bid from its stored copy in an outage (#1846).
  it('retires the partner\'s stored copy, first, even when the profile rebuild throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(refreshBuyerProfilesCache).mockRejectedValueOnce(new Error('kv down'))
    const w = setup({ check: rpcCheck() })
    const res = await call(w.env, 'DELETE', '/partners/p-tp', { fingerprint: FP })
    expect(res.status).toBe(200)
    expect(((await res.json()) as PartnerDeleted).stored_copy_warning).toBe(COPY_NOT_CLEARED_MESSAGE)
    expect((w.env.WORKFLOW_CACHE as unknown as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalledWith('partner-lastgood:p-tp')
  })

  it('a refused delete leaves the stored copy alone, because the partner is still there', async () => {
    const w = setup({ check: rpcCheck({}, { buyer_sales: 1 }), deleteError: { code: 'BP023', message: 'partner_has_dependents' } })
    expect((await call(w.env, 'DELETE', '/partners/p-tp', { fingerprint: FP })).status).toBe(409)
    expect((w.env.WORKFLOW_CACHE as unknown as { delete: ReturnType<typeof vi.fn> }).delete).not.toHaveBeenCalled()
    expect(w.cap.names).toEqual([])
  })

  it('the partner read is scoped to the caller\'s organization', async () => {
    const w = setup({ check: rpcCheck() })
    await call(w.env, 'DELETE', '/partners/p-tp', { fingerprint: FP })
    expect(w.sb.eqCalls.partner_configs).toEqual(expect.arrayContaining([['id', 'p-tp'], ['organization_id', ORG]]))
  })
})
