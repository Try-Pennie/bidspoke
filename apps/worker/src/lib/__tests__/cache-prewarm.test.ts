/**
 * The per minute prewarm (#1632): it kept the workflow definitions, the env
 * vars, the partner constants and the Salesforce token warm, and never the
 * buyer profiles, so on a quiet night the profile copy reached its 300 s TTL and
 * the next lead paid the cold read inside buyer_select's 800 ms budget.
 */
import { describe, expect, it, vi } from 'vitest'
import { prewarmKvCaches } from '../cache-prewarm'
import type { Env } from '../../index'

const PROFILE_ROW = {
  partner_id: 'p-1', version: 7, sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: ['TX'],
  debt_min: null, debt_max: null, loan_amount_min: null, hourly_lead_cap: null, daily_lead_cap: null,
  hourly_spend_cap_cents: null, daily_spend_cap_cents: null, updated_at: '2026-09-30T00:00:00.000Z',
  partner_configs: {
    id: 'p-1', slug: 'tripoint', name: 'Tripoint', is_active: true, api_endpoint: null, cf_secret_key: null,
    outbound_field_mapping: null, extra_extraction: null, accept_signals: [], response_classification: null,
    click_url: null, external_routing_code: null, duplicate_signals: [],
    circuit_enabled: false, circuit_error_threshold: 5, circuit_window_seconds: 60, circuit_cooldown_seconds: 30,
  },
  buyer_operating_windows: [], buyer_blackout_dates: [], buyer_pricing_tiers: [],
}

/** Answers the workflows and buyer_profiles reads; every other table the prewarm touches is refused, which each of those loaders swallows. */
function fakeSupabase(profiles: { data: unknown; error: { message: string } | null }) {
  const tables: string[] = []
  const answer = (table: string) => {
    if (table === 'workflows') return { data: [{ id: 'wf-1', organization_id: 'org-1' }, { id: 'wf-2', organization_id: 'org-1' }], error: null }
    if (table === 'buyer_profiles') return profiles
    return { data: null, error: { message: `table ${table} is not part of this test` } }
  }
  const supabase = {
    from(table: string) {
      tables.push(table)
      const result = answer(table)
      const builder: Record<string, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject)
          if (prop === 'single' || prop === 'maybeSingle') return async () => result
          return () => builder
        },
      })
      return builder
    },
    rpc: async () => ({ data: null, error: { message: 'rpc is not part of this test' } }),
  }
  return { supabase: supabase as never, tables }
}

function fakeKv() {
  const store = new Map<string, { value: string; ttl?: number }>()
  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const hit = store.get(key)
      if (!hit) return null
      return type === 'json' ? JSON.parse(hit.value) : hit.value
    }),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => { store.set(key, { value, ttl: opts?.expirationTtl }) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  }
  return { kv: kv as unknown as KVNamespace, store }
}

function envWith(kv: KVNamespace): Env {
  return { WORKFLOW_CACHE: kv, SECRET_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } as unknown as Env
}

describe('prewarmKvCaches keeps the buyer profile copy warm (#1632)', () => {
  it('rebuilds each org\'s buyer profile copy once a run, even while a copy is already cached', async () => {
    const { kv, store } = fakeKv()
    const stale = { org_id: 'org-1', loaded_at: '2026-09-30T00:00:00.000Z', content_hash: 'old', served_from: 'database', buyers: [] }
    store.set('buyer-profiles:org-1', { value: JSON.stringify(stale), ttl: 300 })
    const { supabase, tables } = fakeSupabase({ data: [PROFILE_ROW], error: null })
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await prewarmKvCaches(supabase, envWith(kv))
    } finally {
      logs.mockRestore()
      errors.mockRestore()
    }
    expect(tables.filter((t) => t === 'buyer_profiles')).toHaveLength(1)
    const cached = JSON.parse(store.get('buyer-profiles:org-1')!.value) as { content_hash: string; buyers: Array<{ version: number }> }
    expect(cached.content_hash).not.toBe('old')
    expect(cached.buyers.map((b) => b.version)).toEqual([7])
  })

  it('a failed profile read leaves the cached copy in place, is reported, and does not fail the prewarm', async () => {
    const { kv, store } = fakeKv()
    const held = { org_id: 'org-1', loaded_at: '2026-09-30T00:00:00.000Z', content_hash: 'held', served_from: 'database', buyers: [] }
    store.set('buyer-profiles:org-1', { value: JSON.stringify(held), ttl: 300 })
    const { supabase } = fakeSupabase({ data: null, error: { message: 'connection reset' } })
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(prewarmKvCaches(supabase, envWith(kv))).resolves.toBeUndefined()
      expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/keep warm failed for org org-1: connection reset/)
    } finally {
      logs.mockRestore()
      errors.mockRestore()
    }
    expect(JSON.parse(store.get('buyer-profiles:org-1')!.value).content_hash).toBe('held')
  })
})
