/**
 * How old a stored copy gets on a HEALTHY day (#1847). Measured, not argued.
 *
 * A stored copy is refused in an outage once it is STORED_COPY_MAX_AGE_MS past
 * its last confirmation, so on a healthy day every copy must be confirmed well
 * inside that, including copies no lead reads: an idle endpoint, an idle partner,
 * a 30 day partner constants cache that keeps every lead off the database.
 *
 * This drives the real loaders the per minute cron runs (the prewarm's calls and
 * the stored copy sweep) for three simulated hours, over a KV double that
 * honours expiry and metadata, with the cron firing late by a varying few
 * seconds as Cloudflare's does. Just before each run it reads every copy's
 * confirmation time; a copy only ages between runs, so the largest of those
 * readings is the worst age a lead in an outage could meet, less KV's own
 * propagation delay (up to 60 seconds between locations), which the bound adds.
 *
 * The idle endpoint, partner and bid matrix are written ONCE, by a single lookup at the
 * start, and then only the cron reaches them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadWorkflowDefinition, workflowCopyKey } from '../../engine/definition-loader'
import { loadEnvVars } from '../env-loader'
import { keepPartnerConstantsConfirmed, loadPartnerConstants } from '../partner-constants-loader'
import { keepBuyerProfilesWarm } from '../buyer-profile-loader'
import { endpointCopyOf, endpointLastGoodKey, writeEndpointLastGood } from '../endpoint-copies'
import { partnerLastGoodKey, rememberPartnerLastGood } from '../partner-last-good'
import { sweepStoredCopies, type SweepSources } from '../stored-copy-sweep'
import { bidMatrixLastGoodKey, lookupMatrixBid, readBidMatrix } from '../bid-matrix-lookup'
import { STORED_COPY_MAX_AGE_MS, STORED_COPY_RECONFIRM_AFTER_MS } from '../stored-copy-age'
import { findStaleCopies } from '../stored-copy-signals'

const KEY = btoa('0'.repeat(32))
const ORG = 'org-fresh'
const WF = 'wf-fresh'
const T0 = Date.parse('2026-10-07T00:00:00Z')
const MINUTE = 60_000
/** The longest the 300 s caches in front of the definition and env copies live. */
const CACHE_TTL_MS = 300_000
/** KV propagation between locations: a read elsewhere can see a write this late. */
const KV_PROPAGATION_MS = 60_000

/** A KV double that honours expirationTtl and keeps metadata, on the faked clock. */
function expiringKv() {
  const store = new Map<string, { value: string; metadata: unknown; expiresAt: number }>()
  const live = (k: string) => {
    const e = store.get(k)
    if (!e) return null
    if (Date.now() >= e.expiresAt) { store.delete(k); return null }
    return e
  }
  const kv = {
    store,
    async get(k: string, type?: string) {
      const e = live(k)
      if (!e) return null
      return type === 'json' ? JSON.parse(e.value) : e.value
    },
    async getWithMetadata(k: string) {
      const e = live(k)
      return { value: e?.value ?? null, metadata: e?.metadata ?? null }
    },
    async put(k: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }) {
      store.set(k, { value, metadata: opts?.metadata ?? null, expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : Number.POSITIVE_INFINITY })
    },
    async delete(k: string) { store.delete(k) },
    async list(opts: { prefix?: string } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '') && live(k)).sort().map((name) => ({ name }))
      return { keys, list_complete: true, cursor: undefined }
    },
  }
  return kv
}

const WORKFLOW_ROW = {
  id: WF, name: 'Engine Bidding', organization_id: ORG, slack_channel: null,
  definition: { nodes: [{ id: 'n1', type: 'response' }], edges: [] }, is_active: true, lane: 'money',
  updated_at: '2026-10-06T00:00:00.000000+00:00', deleted_at: null, workflow_versions: [{ id: 'ver-1', version_number: 1 }],
}
const PARTNER_ROW = { id: 'p-idle', slug: 'idle', is_active: true, updated_at: '2026-10-06T00:00:00+00:00' }
const MATRIX_CONFIG = { id: 'c-idle', is_active: true, dimensions: [{ name: 'debt', payload_field: 'debt', column: 'row' }], last_synced_at: null }
const MATRIX_ROWS = [{ id: 'r1', is_sell_off: false, row_id: null, row_low: 0, row_high: null, range_low: null, range_high: null, bid_amount: 10 }]

/** A healthy database behind the real supabase-js client. */
function healthyDb(): SupabaseClient {
  const tables: Record<string, unknown[]> = {
    workflows: [WORKFLOW_ROW],
    environment_variables: [{ key: 'API_URL', value: 'https://x.example', is_secret: false, scope: 'global', workflow_id: null }],
    partner_uuid_map: [{ uuid: 'u1', partner_slug: 'idle' }],
    partner_configs: [PARTNER_ROW],
    buyer_profiles: [],
    partner_bid_configs: [MATRIX_CONFIG],
    bid_matrix_rows: MATRIX_ROWS,
  }
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const table = new URL(String(input)).pathname.split('/').pop() ?? ''
    const rows = tables[table] ?? []
    const accept = init?.headers instanceof Headers ? init.headers.get('Accept') : (init?.headers as Record<string, string> | undefined)?.Accept
    const body = accept === 'application/vnd.pgrst.object+json' ? rows[0] : rows
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return createClient('https://db.test', 'k', { auth: { persistSession: false }, global: { fetch } })
}

const sources: SweepSources = {
  endpoints: async () => [{ id: 'ep-idle', subdomain: 'idle', path: '/bidding', workflow_id: WF, source_name: 'idle', is_active: true, trigger_auth_method: null }],
  partners: async () => [{ id: PARTNER_ROW.id, updated_at: PARTNER_ROW.updated_at }],
  workflows: async () => [{ id: WF, updated_at: WORKFLOW_ROW.updated_at }],
  refreshWorkflow: async () => {},
  bidMatrix: (configId, sellOff) => readBidMatrix(healthyDb(), configId, sellOff),
}

type Kv = ReturnType<typeof expiringKv>
/** Each copy, and where its confirmation time lives. */
const COPIES: Record<string, (kv: Kv) => unknown> = {
  'workflow definition': (kv) => JSON.parse(kv.store.get(workflowCopyKey(WF))?.value ?? '{}').written_at,
  'env vars': (kv) => (kv.store.get(`env-vars-${ORG}-lastgood`)?.metadata as { confirmed_at?: string } | null)?.confirmed_at,
  'partner constants': (kv) => (kv.store.get(`partner-constants-v2-${ORG}-lastgood`)?.metadata as { confirmed_at?: string } | null)?.confirmed_at,
  'buyer profiles': (kv) => JSON.parse(kv.store.get(`buyer-profiles:${ORG}:lastgood`)?.value ?? '{}').loaded_at,
  'idle endpoint': (kv) => (kv.store.get(endpointLastGoodKey('idle', '/bidding'))?.metadata as { confirmed_at?: string } | null)?.confirmed_at,
  'idle partner': (kv) => (kv.store.get(partnerLastGoodKey(PARTNER_ROW.id))?.metadata as { confirmed_at?: string } | null)?.confirmed_at,
  'idle bid matrix': (kv) => (kv.store.get(bidMatrixLastGoodKey(MATRIX_CONFIG.id, false))?.metadata as { confirmed_at?: string } | null)?.confirmed_at,
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('on a healthy day, every stored copy stays well inside the maximum age (#1847)', () => {
  it('measures each copy\'s worst age over three hours of the per minute cron, and holds it under the stated bound', async () => {
    const kv = expiringKv()
    const asKv = kv as unknown as KVNamespace
    const db = healthyDb()

    // The single lookup and bid that ever reach the idle endpoint and partner.
    await writeEndpointLastGood(asKv, 'idle', '/bidding', endpointCopyOf({ id: 'ep-idle', workflow_id: WF, source_name: 'idle', is_active: true }, null), Date.now())
    await rememberPartnerLastGood(asKv, PARTNER_ROW, Date.now())
    await lookupMatrixBid(MATRIX_CONFIG.id, { trigger: { payload: { debt: 1 } } } as never, db, { kv: asKv })

    const worst: Record<string, number> = Object.fromEntries(Object.keys(COPIES).map((k) => [k, 0]))
    for (let minute = 0; minute < 180; minute++) {
      // Cloudflare fires a cron late by a varying few seconds.
      vi.setSystemTime(T0 + minute * MINUTE + ((minute * 7) % 25) * 1000)
      if (minute > 0) {
        for (const [name, read] of Object.entries(COPIES)) {
          const age = Date.now() - Date.parse(String(read(kv)))
          expect(Number.isFinite(age), `${name} has no readable confirmation at minute ${minute}`).toBe(true)
          worst[name] = Math.max(worst[name], age)
        }
        // The stale copy alert (#1848) finds nothing on a healthy day, at every minute.
        expect(await findStaleCopies(asKv, Date.now()), `stale copy found at minute ${minute}`).toEqual({ stale: [], unmeasured: [] })
      }
      // What the per minute cron runs: the prewarm's loads, then the sweep.
      await loadWorkflowDefinition(WF, asKv, db)
      await loadEnvVars(ORG, asKv, db, KEY, 'global-only')
      await loadPartnerConstants(ORG, asKv, db).catch(() => undefined)
      await keepPartnerConstantsConfirmed(ORG, asKv, db)
      await keepBuyerProfilesWarm(ORG, asKv, db)
      await sweepStoredCopies(asKv, sources)
    }

    // The stated worst case: a copy confirmed just short of due is not
    // confirmed again until the next cache miss after it is due, so at most two
    // of the longer of the 300 s cache and the reconfirm interval, plus a late
    // cron run, plus KV propagation. About twelve minutes, against thirty.
    const bound = 2 * Math.max(CACHE_TTL_MS, STORED_COPY_RECONFIRM_AFTER_MS) + MINUTE + KV_PROPAGATION_MS
    expect(bound).toBe(12 * MINUTE)
    expect(bound * 2).toBeLessThanOrEqual(STORED_COPY_MAX_AGE_MS)
    for (const [name, age] of Object.entries(worst)) {
      expect(age + KV_PROPAGATION_MS, `${name} reached ${Math.round(age / 1000)} s`).toBeLessThanOrEqual(bound)
    }
    // And the measurement is real: every copy did age between confirmations.
    for (const [name, age] of Object.entries(worst)) {
      expect(age, `${name} never aged, so nothing was measured`).toBeGreaterThanOrEqual(STORED_COPY_RECONFIRM_AFTER_MS - MINUTE)
    }
  })
})

describe('the stale copy alert against a sweep that has stopped (#1848)', () => {
  it('finds exactly the copies only the sweep confirms, once they pass the maximum age, and nothing before', async () => {
    const kv = expiringKv()
    const asKv = kv as unknown as KVNamespace
    const db = healthyDb()
    await writeEndpointLastGood(asKv, 'idle', '/bidding', endpointCopyOf({ id: 'ep-idle', workflow_id: WF, source_name: 'idle', is_active: true }, null), Date.now())
    // Its own id: the partner copy writer remembers per isolate what it wrote.
    await rememberPartnerLastGood(asKv, { ...PARTNER_ROW, id: 'p-idle-stopped' }, Date.now())
    const broken: SweepSources = {
      ...sources,
      endpoints: async () => { throw new Error('database read failed') },
      partners: async () => { throw new Error('database read failed') },
    }

    let firstStaleMinute: number | null = null
    for (let minute = 0; minute < 60; minute++) {
      vi.setSystemTime(T0 + minute * MINUTE)
      await loadWorkflowDefinition(WF, asKv, db)
      await loadEnvVars(ORG, asKv, db, KEY, 'global-only')
      await loadPartnerConstants(ORG, asKv, db).catch(() => undefined)
      await keepPartnerConstantsConfirmed(ORG, asKv, db)
      await keepBuyerProfilesWarm(ORG, asKv, db)
      await sweepStoredCopies(asKv, broken)
      const { stale } = await findStaleCopies(asKv, Date.now())
      if (stale.length > 0 && firstStaleMinute === null) {
        firstStaleMinute = minute
        expect(stale.map((s) => s.copy).sort()).toEqual(['custom_endpoint', 'partner_config'])
      }
    }
    expect(firstStaleMinute).toBe(STORED_COPY_MAX_AGE_MS / MINUTE + 1)
  })
})
