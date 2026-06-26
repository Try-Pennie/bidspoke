import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadEnvVars } from '../env-loader'
import { encryptSecret } from '../secret-crypto'

// A throwaway 32-byte base64 key for round-tripping encrypt/decrypt in tests.
const KEY = btoa('0'.repeat(32))
const WRONG_KEY = btoa('1'.repeat(32))

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
 * chain is thenable so it resolves at whichever filter is terminal (the loader
 * no longer applies an is_secret filter). */
function fakeSupabase(result: { data: unknown; error: unknown }): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    then: (resolve: (r: unknown) => void) => resolve(result),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

describe('loadEnvVars (#391)', () => {
  it('returns the cached value without querying when present', async () => {
    const kv = fakeKv({ 'env-vars-org1': JSON.stringify({ A: '1' }) })
    const r = await loadEnvVars('org1', kv, fakeSupabase({ data: [{ key: 'X', value: '9' }], error: null }), KEY)
    expect(r).toEqual({ A: '1' })
  })

  it('on a successful load, caches the result AND records a last-good copy', async () => {
    const kv = fakeKv()
    const sb = fakeSupabase({ data: [{ key: 'SALESFORCE_CLIENT_ID', value: 'cid', is_secret: false }, { key: 'BLANK', value: '', is_secret: false }], error: null })
    const r = await loadEnvVars('org1', kv, sb, KEY)
    expect(r).toEqual({ SALESFORCE_CLIENT_ID: 'cid' }) // empty values skipped
    expect(kv.store.has('env-vars-org1')).toBe(true)
    expect(kv.store.has('env-vars-org1-lastgood')).toBe(true)
  })

  it('decrypts secret-flagged vars so nodes get the plaintext (Dan 2026-06-26: nodes must read secrets)', async () => {
    const enc = await encryptSecret('super-secret-pw', KEY)
    const kv = fakeKv()
    const sb = fakeSupabase({ data: [{ key: 'ELIGIBILITY_SCOUT_CLIENT_SECRET', value: enc, is_secret: true }], error: null })
    const r = await loadEnvVars('org1', kv, sb, KEY)
    expect(r).toEqual({ ELIGIBILITY_SCOUT_CLIENT_SECRET: 'super-secret-pw' })
  })

  it('skips a secret it cannot decrypt instead of injecting the raw ciphertext (prevents the 2026-06-26 Equifax outage)', async () => {
    // Encrypted with KEY but loaded with WRONG_KEY → decrypt throws.
    const enc = await encryptSecret('the-real-password', KEY)
    const kv = fakeKv()
    const sb = fakeSupabase({ data: [{ key: 'EQUIFAX_PASSWORD', value: enc, is_secret: true }], error: null })
    const r = await loadEnvVars('org1', kv, sb, WRONG_KEY)
    // Must be ABSENT — never the ciphertext (which is what broke Equifax).
    expect(r).toEqual({})
    expect(r.EQUIFAX_PASSWORD).toBeUndefined()
  })

  it('on a DB error, does NOT cache an empty result (the bug that caused the outage)', async () => {
    const kv = fakeKv()
    const r = await loadEnvVars('org1', kv, fakeSupabase({ data: null, error: { message: 'pool exhausted' } }), KEY)
    expect(r).toEqual({})
    expect(kv.store.has('env-vars-org1')).toBe(false)
  })

  it('on a DB error, serves the last-good values so a transient blip does not blank creds', async () => {
    const kv = fakeKv({ 'env-vars-org1-lastgood': JSON.stringify({ SALESFORCE_CLIENT_ID: 'good', SALESFORCE_INSTANCE_URL: 'u' }) })
    const r = await loadEnvVars('org1', kv, fakeSupabase({ data: null, error: { message: 'timeout' } }), KEY)
    expect(r).toEqual({ SALESFORCE_CLIENT_ID: 'good', SALESFORCE_INSTANCE_URL: 'u' })
    expect(kv.store.has('env-vars-org1')).toBe(false) // still must not poison the short cache
  })
})
