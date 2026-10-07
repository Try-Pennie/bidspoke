import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../index'
import { createLeadSupabaseClient, LEAD_READ_DEADLINE_MS } from '../lead-read-budget'
import { loadBuyerProfiles, BUYER_PROFILES_READ_DEADLINE_MS, BUYER_PROFILES_SLOW_KV_GET_MS } from '../buyer-profile-loader'
import { loadEnvVars } from '../env-loader'
import { loadPartnerConstants } from '../partner-constants-loader'
import { readPartnerConfig } from '../../engine/nodes/partner-bid'
import { CLICK_CHECK_BUDGET_MS } from '@bidspoke/buyer-profile'
import { BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS, BUYER_SELECT_LIVE_PRE_CALL_BUDGET_MS } from '../../engine/nodes/buyer-select'
import { CLICK_PROFILE_READ_DEADLINE_MS } from '../../engine/nodes/buyer-click-send'

/**
 * Each lead path read that has a last-good copy goes through leadRead (#1844),
 * so with the database down it reaches its copy after ONE request, with no
 * library retries (which cost about 7 s per read before), and within the
 * budget of the step that waits on it.
 *
 * Every case warms the copy the way production does, with a healthy read, then
 * drops the fast cache key and reads again on a new lead whose database refuses.
 * The real supabase-js client runs throughout; only its network is replaced.
 */
const env = { SUPABASE_URL: 'https://db.example.test', SUPABASE_SECRET_KEY: 'k' } as unknown as Env
const KEY = btoa('0'.repeat(32))

function fakeKv() {
  const store = new Map<string, string>()
  // The metadata each put carried, which carries a copy's confirmation (#1847).
  const meta = new Map<string, unknown>()
  return {
    store,
    get: vi.fn(async (k: string, type?: string) => {
      const v = store.get(k)
      if (v == null) return null
      return type === 'json' ? JSON.parse(v) : v
    }),
    getWithMetadata: vi.fn(async (k: string) => ({ value: store.get(k) ?? null, metadata: meta.get(k) ?? null })),
    put: vi.fn(async (k: string, v: string, opts?: { metadata?: unknown }) => { store.set(k, v); meta.set(k, opts?.metadata ?? null) }),
    delete: vi.fn(async (k: string) => { store.delete(k); meta.delete(k) }),
  } as unknown as KVNamespace & { store: Map<string, string> }
}

/** A network answering each table from `rows` while up, refusing every request while down. */
function database(rows: Record<string, unknown[]>) {
  const state = { down: false, calls: 0 }
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    state.calls++
    if (state.down) throw new TypeError('fetch failed')
    const url = new URL(String(input))
    const table = url.pathname.split('/').pop() ?? ''
    const data = rows[table] ?? []
    const single = (init?.headers instanceof Headers ? init.headers.get('Accept') : (init?.headers as Record<string, string> | undefined)?.Accept) === 'application/vnd.pgrst.object+json'
    const body = single ? data[0] : data
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { state, fetch }
}

const asked: number[] = []
const deadline = (ms: number) => { asked.push(ms); return new AbortController().signal }

beforeEach(() => { asked.length = 0 })
afterEach(() => { vi.useRealTimers() })

describe('lead path reads fall straight back to their copy (#1844)', () => {
  it('buyer profiles', async () => {
    const db = database({ buyer_profiles: [] })
    const kv = fakeKv()
    await loadBuyerProfiles('org1', kv, createLeadSupabaseClient(env, { fetch: db.fetch, deadline }))
    kv.store.delete('buyer-profiles:org1')
    db.state.down = true
    const before = db.state.calls
    asked.length = 0
    const snap = await loadBuyerProfiles('org1', kv, createLeadSupabaseClient(env, { fetch: db.fetch, deadline }))
    expect(snap.served_from).toBe('last_good')
    expect(db.state.calls - before).toBe(1)
    expect(asked).toEqual([BUYER_PROFILES_READ_DEADLINE_MS])
  })

  it('environment variables', async () => {
    const db = database({ environment_variables: [{ key: 'A', value: '1', is_secret: false, scope: 'global', workflow_id: null }] })
    const kv = fakeKv()
    await loadEnvVars('org1', kv, createLeadSupabaseClient(env, { fetch: db.fetch, deadline }), KEY, 'global-only')
    kv.store.delete('env-vars-org1')
    kv.store.delete('env-vars-org1-workflow-scoped')
    db.state.down = true
    const before = db.state.calls
    asked.length = 0
    const vars = await loadEnvVars('org1', kv, createLeadSupabaseClient(env, { fetch: db.fetch, deadline }), KEY, 'global-only')
    expect(vars).toEqual({ A: '1' })
    expect(db.state.calls - before).toBe(1)
    expect(asked).toEqual([LEAD_READ_DEADLINE_MS])
  })

  it('partner constants', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const db = database({ partner_uuid_map: [{ uuid: 'u1', partner_slug: 'tripoint' }], partner_configs: [{ id: 'p1', slug: 'tripoint', is_active: true }] })
    const kv = fakeKv()
    await loadPartnerConstants('org-pc', kv, createLeadSupabaseClient(env, { fetch: db.fetch, deadline }))
    // Past the module's 15 s memory copy, so the next read reaches the database.
    vi.setSystemTime(Date.now() + 60_000)
    kv.store.delete('partner-constants-v2-org-pc')
    db.state.down = true
    const before = db.state.calls
    const constants = await loadPartnerConstants('org-pc', kv, createLeadSupabaseClient(env, { fetch: db.fetch, deadline }))
    expect(constants.subAccountIdsMap).toEqual({ u1: 'tripoint' })
    // Both reads run together, so each is asked once and neither is retried.
    expect(db.state.calls - before).toBeLessThanOrEqual(2)
  })

  it('a partner config for a bid', async () => {
    const db = database({ partner_configs: [{ id: 'p1', slug: 'tripoint' }] })
    const up = await readPartnerConfig(createLeadSupabaseClient(env, { fetch: db.fetch, deadline }), 'p1')
    expect(up.error).toBeNull()
    db.state.down = true
    const before = db.state.calls
    const down = await readPartnerConfig(createLeadSupabaseClient(env, { fetch: db.fetch, deadline }), 'p1')
    expect(down.error).not.toBeNull()
    expect(db.state.calls - before).toBe(1)
  })
})

describe('the buyer profile read fits inside every step that waits on it (#1844)', () => {
  // Its deadline, plus the cache read before it and the last-good read after a
  // failure (each logged as slow past BUYER_PROFILES_SLOW_KV_GET_MS), plus room
  // to decide, must finish inside the tightest budget around it.
  const decideRoomMs = 100
  it.each([
    ['buyer_click_check', CLICK_CHECK_BUDGET_MS],
    ['buyer_select decide only', BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS],
    ['buyer_select live pre call', BUYER_SELECT_LIVE_PRE_CALL_BUDGET_MS],
    ['buyer_click_send profile read', CLICK_PROFILE_READ_DEADLINE_MS],
  ])('%s (%i ms)', (_name, budgetMs) => {
    expect(BUYER_PROFILES_READ_DEADLINE_MS + 2 * BUYER_PROFILES_SLOW_KV_GET_MS + decideRoomMs).toBeLessThanOrEqual(budgetMs)
  })
})
