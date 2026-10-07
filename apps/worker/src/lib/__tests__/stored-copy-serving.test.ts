/**
 * Every loader counts the stored copies it serves and refuses (#1848).
 *
 * Drives each of the six real loaders through a healthy load (which writes its
 * copy), then a database that refuses every request, and reads the ledger the
 * per minute check reads. A loader that serves its copy without counting it is
 * an outage nobody hears about, which is what this exists to prevent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadWorkflowDefinition } from '../../engine/definition-loader'
import { loadEnvVars } from '../env-loader'
import { loadPartnerConstants } from '../partner-constants-loader'
import { loadBuyerProfiles } from '../buyer-profile-loader'
import { endpointCopyOf, readEndpointLastGood, writeEndpointLastGood } from '../endpoint-copies'
import { readPartnerLastGood, rememberPartnerLastGood } from '../partner-last-good'
import { STORED_COPY_MAX_AGE_MS, type StoredCopyKind } from '../stored-copy-age'
import { flushStoredCopyLedger, forgetStoredCopyLedger, readStoredCopyLedger, type LedgerKv } from '../stored-copy-ledger'

const KEY = btoa('0'.repeat(32))
// Fresh per test: the partner constants and partner copy writers keep per isolate memory keyed on these.
let ORG = 'org-serve'
const WF = 'wf-serve'
const T0 = Date.parse('2026-10-07T12:00:00Z')
const MINUTE = 60_000

/** A KV double that honours expirationTtl, keeps metadata and lists it, on the faked clock. */
function expiringKv() {
  const store = new Map<string, { value: string; metadata: unknown; expiresAt: number }>()
  const live = (k: string) => {
    const e = store.get(k)
    if (!e) return null
    if (Date.now() >= e.expiresAt) { store.delete(k); return null }
    return e
  }
  return {
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
      const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '') && live(k)).sort().map((name) => ({ name, metadata: store.get(name)?.metadata }))
      return { keys, list_complete: true, cursor: undefined }
    },
  }
}

const WORKFLOW_ROW = {
  id: WF, name: 'Engine Bidding', organization_id: ORG, slack_channel: null,
  definition: { nodes: [{ id: 'n1', type: 'response' }], edges: [] }, is_active: true, lane: 'money',
  updated_at: '2026-10-06T00:00:00.000000+00:00', deleted_at: null, workflow_versions: [{ id: 'ver-1', version_number: 1 }],
}
let PARTNER_ROW = { id: 'p-1', slug: 'tripoint', is_active: true, updated_at: '2026-10-06T00:00:00+00:00' }
let run = 0

/** The real supabase-js client, over a database that answers, or one that refuses every request. */
function db(up: () => boolean): SupabaseClient {
  const tables: Record<string, unknown[]> = {
    workflows: [WORKFLOW_ROW],
    environment_variables: [{ key: 'API_URL', value: 'https://x.example', is_secret: false, scope: 'global', workflow_id: null }],
    partner_uuid_map: [{ uuid: 'u1', partner_slug: 'tripoint' }],
    partner_configs: [PARTNER_ROW],
    buyer_profiles: [],
  }
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!up()) return new Response(JSON.stringify({ message: 'upstream connect error' }), { status: 503, headers: { 'content-type': 'application/json' } })
    const table = new URL(String(input)).pathname.split('/').pop() ?? ''
    const rows = tables[table] ?? []
    const accept = init?.headers instanceof Headers ? init.headers.get('Accept') : (init?.headers as Record<string, string> | undefined)?.Accept
    const body = accept === 'application/vnd.pgrst.object+json' ? rows[0] : rows
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return createClient('https://db.test', 'k', { auth: { persistSession: false }, global: { fetch }, db: { retry: false } } as Parameters<typeof createClient>[2])
}

type Kv = ReturnType<typeof expiringKv>

/** What the ledger holds for one copy, once flushed. */
async function counted(copy: StoredCopyKind) {
  const ledger = expiringKv()
  await flushStoredCopyLedger(ledger as unknown as LedgerKv, { now: () => Date.now(), sleep: async () => {} })
  return (await readStoredCopyLedger(ledger as unknown as LedgerKv, Date.now(), 5)).kinds[copy]
}

/** Each loader: write its copy with the database up, then drive it with the database down. */
const LOADERS: Record<StoredCopyKind, { warm: (kv: Kv, d: SupabaseClient) => Promise<unknown>; serve: (kv: Kv, d: SupabaseClient) => Promise<unknown> }> = {
  workflow_definition: {
    warm: (kv, d) => loadWorkflowDefinition(WF, kv as unknown as KVNamespace, d),
    serve: (kv, d) => loadWorkflowDefinition(WF, kv as unknown as KVNamespace, d),
  },
  env_vars: {
    warm: (kv, d) => loadEnvVars(ORG, kv as unknown as KVNamespace, d, KEY, 'global-only'),
    serve: (kv, d) => loadEnvVars(ORG, kv as unknown as KVNamespace, d, KEY, 'global-only'),
  },
  partner_constants: {
    warm: (kv, d) => loadPartnerConstants(ORG, kv as unknown as KVNamespace, d),
    serve: async (kv, d) => {
      // The 30 day cache keeps every lead off the database; the copy is read only without it.
      await kv.delete(`partner-constants-v2-${ORG}`)
      return loadPartnerConstants(ORG, kv as unknown as KVNamespace, d)
    },
  },
  buyer_profiles: {
    warm: (kv, d) => loadBuyerProfiles(ORG, kv as unknown as KVNamespace, d),
    serve: async (kv, d) => {
      await kv.delete(`buyer-profiles:${ORG}`)
      return loadBuyerProfiles(ORG, kv as unknown as KVNamespace, d)
    },
  },
  custom_endpoint: {
    warm: (kv) => writeEndpointLastGood(kv as unknown as KVNamespace, 'engine', '/bid', endpointCopyOf({ id: 'ep-1', workflow_id: WF, source_name: 'engine', is_active: true }, null), Date.now()),
    serve: async (kv) => {
      const copy = await readEndpointLastGood(kv as unknown as KVNamespace, 'engine', '/bid', 'upstream connect error', Date.now())
      if (!copy) throw new Error('refused')
      return copy
    },
  },
  partner_config: {
    warm: (kv) => rememberPartnerLastGood(kv as unknown as KVNamespace, PARTNER_ROW, Date.now()),
    serve: async (kv) => {
      const copy = await readPartnerLastGood(kv as unknown as KVNamespace, PARTNER_ROW.id, 'upstream connect error', Date.now())
      if (!copy) throw new Error('refused')
      return copy
    },
  },
}

beforeEach(() => {
  run++
  ORG = `org-serve-${run}`
  PARTNER_ROW = { ...PARTNER_ROW, id: `p-${run}` }
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  forgetStoredCopyLedger()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  forgetStoredCopyLedger()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('every loader counts what it serves and refuses in an outage (#1848)', () => {
  for (const [copy, loader] of Object.entries(LOADERS) as [StoredCopyKind, (typeof LOADERS)[StoredCopyKind]][]) {
    it(`${copy}: a copy served is counted with its age, and logged as served`, async () => {
      let up = true
      const kv = expiringKv()
      const d = db(() => up)
      await loader.warm(kv, d)
      // Past every short cache in front of the copy, inside the maximum age.
      vi.setSystemTime(T0 + 10 * MINUTE)
      up = false
      await loader.serve(kv, d)

      const tally = await counted(copy)
      expect(tally?.served).toBe(1)
      expect(tally?.oldestServedAgeMs).toBe(10 * MINUTE)
      const served = vi.mocked(console.warn).mock.calls.flat().map(String).filter((l) => l.includes('"stored_copy_served"'))
      expect(served.map((l) => JSON.parse(l) as { copy: string; copy_age_ms: number })).toEqual([expect.objectContaining({ copy, copy_age_ms: 10 * MINUTE })])
    })

    it(`${copy}: a copy past the maximum age is counted as refused, never as served`, async () => {
      let up = true
      const kv = expiringKv()
      const d = db(() => up)
      await loader.warm(kv, d)
      vi.setSystemTime(T0 + STORED_COPY_MAX_AGE_MS + MINUTE)
      up = false
      await loader.serve(kv, d).catch(() => undefined)

      const tally = await counted(copy)
      expect(tally?.served).toBe(0)
      expect(tally?.refused.copy_too_old).toBe(1)
    })

    it(`${copy}: a copy that is there but cannot be read is counted as unusable, never as missing`, async () => {
      let up = true
      const kv = expiringKv()
      const d = db(() => up)
      await loader.warm(kv, d)
      // The last-good copies are the keys kept with no expiry; damage each one,
      // keeping its confirmation, so only its content is wrong.
      let damaged = 0
      for (const entry of kv.store.values()) {
        if (entry.expiresAt === Number.POSITIVE_INFINITY) { entry.value = '{not a copy'; damaged++ }
      }
      expect(damaged).toBeGreaterThan(0)
      vi.setSystemTime(T0 + 10 * MINUTE)
      up = false
      await loader.serve(kv, d).catch(() => undefined)

      const tally = await counted(copy)
      expect(tally?.served ?? 0).toBe(0)
      expect(tally?.refused).toMatchObject({ copy_unusable: 1, no_copy: 0 })
      const refused = vi.mocked(console.error).mock.calls.flat().map(String).filter((l) => l.includes('"stored_copy_refused"'))
      if (copy !== 'workflow_definition') expect(refused.map((l) => (JSON.parse(l) as { reason: string }).reason)).toEqual(['copy_unusable'])
    })

    it(`${copy}: a copy KV fails to hand back is counted as unusable, never as missing`, async () => {
      let up = true
      const kv = expiringKv()
      const d = db(() => up)
      await loader.warm(kv, d)
      const kept = new Set([...kv.store.entries()].filter(([, e]) => e.expiresAt === Number.POSITIVE_INFINITY).map(([k]) => k))
      expect(kept.size).toBeGreaterThan(0)
      const failing = (k: string) => { if (kept.has(k)) throw new Error('KV GET failed: 500 Internal Server Error') }
      const get = kv.get.bind(kv)
      const getWithMetadata = kv.getWithMetadata.bind(kv)
      kv.get = async (k: string, type?: string) => { failing(k); return get(k, type) }
      kv.getWithMetadata = async (k: string) => { failing(k); return getWithMetadata(k) }
      vi.setSystemTime(T0 + 10 * MINUTE)
      up = false
      await loader.serve(kv, d).catch(() => undefined)

      const tally = await counted(copy)
      expect(tally?.served ?? 0).toBe(0)
      expect(tally?.refused).toMatchObject({ copy_unusable: 1, no_copy: 0 })
    })

    it(`${copy}: no copy at all is counted as refused for want of one`, async () => {
      const kv = expiringKv()
      await loader.serve(kv, db(() => false)).catch(() => undefined)
      const tally = await counted(copy)
      expect(tally?.served ?? 0).toBe(0)
      expect(tally?.refused.no_copy).toBe(1)
    })
  }

  it('counts nothing on a healthy read', async () => {
    const kv = expiringKv()
    const d = db(() => true)
    for (const loader of Object.values(LOADERS)) await loader.warm(kv, d)
    for (const copy of Object.keys(LOADERS) as StoredCopyKind[]) expect(await counted(copy)).toBeUndefined()
  })
})
