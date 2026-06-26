import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadEnvVars } from '../env-loader'

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    store,
    get: vi.fn(async (k: string) => {
      const v = store.get(k)
      return v == null ? null : JSON.parse(v)
    }),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  } as unknown as KVNamespace & { store: Map<string, string> }
}

/** supabase whose env-var query resolves to the given { data, error }. The
 * query chain is thenable so it resolves at whichever filter is terminal, and
 * records every .eq()/.is() filter applied so tests can assert what was queried. */
function fakeSupabase(result: { data: unknown; error: unknown }): SupabaseClient & {
  filters: { is: [string, unknown][]; eq: [string, unknown][] }
} {
  const filters = { is: [] as [string, unknown][], eq: [] as [string, unknown][] }
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => { filters.eq.push([col, val]); return chain },
    is: (col: string, val: unknown) => { filters.is.push([col, val]); return chain },
    then: (resolve: (r: unknown) => void) => resolve(result),
  }
  return { from: () => chain, filters } as unknown as SupabaseClient & {
    filters: { is: [string, unknown][]; eq: [string, unknown][] }
  }
}

describe('loadEnvVars (#391)', () => {
  it('returns the cached value without querying when present', async () => {
    const kv = fakeKv({ 'env-vars-org1': JSON.stringify({ A: '1' }) })
    const r = await loadEnvVars('org1', kv, fakeSupabase({ data: [{ key: 'X', value: '9' }], error: null }))
    expect(r).toEqual({ A: '1' })
  })

  it('on a successful load, caches the result AND records a last-good copy', async () => {
    const kv = fakeKv()
    const sb = fakeSupabase({ data: [{ key: 'SALESFORCE_CLIENT_ID', value: 'cid' }, { key: 'BLANK', value: '' }], error: null })
    const r = await loadEnvVars('org1', kv, sb)
    expect(r).toEqual({ SALESFORCE_CLIENT_ID: 'cid' }) // empty values skipped
    expect(kv.store.has('env-vars-org1')).toBe(true)
    expect(kv.store.has('env-vars-org1-lastgood')).toBe(true)
  })

  it('includes secret-flagged env vars and does NOT filter by is_secret (Dan 2026-06-26: nodes must read secrets)', async () => {
    const kv = fakeKv()
    const sb = fakeSupabase({ data: [{ key: 'ELIGIBILITY_SCOUT_CLIENT_SECRET', value: 'shh' }], error: null })
    const r = await loadEnvVars('org1', kv, sb)
    // A secret-flagged var must be returned so code nodes / template resolution can read it.
    expect(r).toEqual({ ELIGIBILITY_SCOUT_CLIENT_SECRET: 'shh' })
    // The query must NOT exclude secrets.
    expect(sb.filters.is).not.toContainEqual(['is_secret', false])
  })

  it('on a DB error, does NOT cache an empty result (the bug that caused the outage)', async () => {
    const kv = fakeKv()
    const r = await loadEnvVars('org1', kv, fakeSupabase({ data: null, error: { message: 'pool exhausted' } }))
    expect(r).toEqual({})
    expect(kv.store.has('env-vars-org1')).toBe(false)
  })

  it('on a DB error, serves the last-good values so a transient blip does not blank creds', async () => {
    const kv = fakeKv({ 'env-vars-org1-lastgood': JSON.stringify({ SALESFORCE_CLIENT_ID: 'good', SALESFORCE_INSTANCE_URL: 'u' }) })
    const r = await loadEnvVars('org1', kv, fakeSupabase({ data: null, error: { message: 'timeout' } }))
    expect(r).toEqual({ SALESFORCE_CLIENT_ID: 'good', SALESFORCE_INSTANCE_URL: 'u' })
    expect(kv.store.has('env-vars-org1')).toBe(false) // still must not poison the short cache
  })
})
