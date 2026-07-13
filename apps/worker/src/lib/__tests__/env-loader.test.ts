import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadEnvVars, invalidateEnvCache } from '../env-loader'
import { encryptSecret } from '../secret-crypto'

// A throwaway 32-byte base64 key for round-tripping encrypt/decrypt in tests.
const KEY = btoa('0'.repeat(32))
const WRONG_KEY = btoa('1'.repeat(32))

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    store,
    // Mirrors the real KV: `get(k, 'json')` parses, a bare `get(k)` returns the
    // raw string. The cache is stored as an encrypted string, so the loader reads
    // it raw and decrypts before parsing.
    get: vi.fn(async (k: string, type?: string) => {
      const v = store.get(k)
      if (v == null) return null
      return type === 'json' ? JSON.parse(v) : v
    }),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  } as unknown as KVNamespace & { store: Map<string, string> }
}

// Everything the fake KV is currently holding, as one string. If a secret's
// plaintext appears anywhere in here, it is readable at rest to anyone who can
// read the namespace.
function kvContents(kv: KVNamespace & { store: Map<string, string> }): string {
  return [...kv.store.entries()].map(([k, v]) => `${k}=${v}`).join('\n')
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
    // Seed via the loader itself: the cache is encrypted at rest (#491), so a
    // hand-written plaintext entry is not a cache entry at all any more.
    const kv = fakeKv()
    await loadEnvVars('org1', kv, fakeSupabase({ data: [{ key: 'A', value: '1', is_secret: false }], error: null }), KEY)

    const exploding = { from: () => { throw new Error('must not query the DB on a cache hit') } } as unknown as SupabaseClient
    const r = await loadEnvVars('org1', kv, exploding, KEY)
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
    const kv = fakeKv()
    // Seed last-good the way the loader itself writes it, so the format is whatever
    // the loader uses rather than something this test asserts into existence.
    await loadEnvVars('org1', kv, fakeSupabase({ data: [{ key: 'SALESFORCE_CLIENT_ID', value: 'good', is_secret: false }, { key: 'SALESFORCE_INSTANCE_URL', value: 'u', is_secret: false }], error: null }), KEY)
    kv.store.delete('env-vars-org1') // short cache expired; only last-good remains

    const r = await loadEnvVars('org1', kv, fakeSupabase({ data: null, error: { message: 'timeout' } }), KEY)
    expect(r).toEqual({ SALESFORCE_CLIENT_ID: 'good', SALESFORCE_INSTANCE_URL: 'u' })
    expect(kv.store.has('env-vars-org1')).toBe(false) // still must not poison the short cache
  })
})

// #491. The loader wrote the FULLY DECRYPTED env map into KV: the short cache
// (TTL 300) and a last-good copy with NO TTL. Anyone who could read the KV
// namespace (a leaked Cloudflare token) could read every live credential in
// plaintext. Worse, invalidate only dropped the short key, so a rotated or deleted
// credential's plaintext sat in the never-expiring last-good copy indefinitely.
//
// The secrets are encrypted at rest in Postgres precisely so they are not lying
// around in the clear. Decrypting them into a cache undoes that.
describe('loadEnvVars: secrets are not left in plaintext at rest in KV (#491)', () => {
  const SECRET = 'super-secret-pw'

  async function loadWithSecret(kv: KVNamespace & { store: Map<string, string> }, value = SECRET) {
    const enc = await encryptSecret(value, KEY)
    const sb = fakeSupabase({ data: [{ key: 'EQUIFAX_PASSWORD', value: enc, is_secret: true }], error: null })
    return loadEnvVars('org1', kv, sb, KEY)
  }

  it('writes no plaintext secret into the short cache or the last-good copy', async () => {
    const kv = fakeKv()
    const r = await loadWithSecret(kv)

    // The caller still gets the plaintext: nodes exist to use these credentials.
    expect(r).toEqual({ EQUIFAX_PASSWORD: SECRET })

    // But KV must not be holding it in the clear, in either key.
    expect(kv.store.has('env-vars-org1')).toBe(true)
    expect(kv.store.has('env-vars-org1-lastgood')).toBe(true)
    expect(kvContents(kv)).not.toContain(SECRET)
  })

  it('round-trips: a cache hit still returns the decrypted plaintext', async () => {
    const kv = fakeKv()
    await loadWithSecret(kv)

    // Second load must be served from cache (a supabase that would throw if used)
    // and still hand back the real password.
    const exploding = { from: () => { throw new Error('must not query the DB on a cache hit') } } as unknown as SupabaseClient
    const r = await loadEnvVars('org1', kv, exploding, KEY)
    expect(r).toEqual({ EQUIFAX_PASSWORD: SECRET })
  })

  it('treats a cache it cannot decrypt as a miss and reloads from the DB', async () => {
    // SECRET_ENCRYPTION_KEY was rotated after the cache was written. The stale blob
    // is now undecryptable. That must behave as a cache miss, not a crash and not
    // garbage: rotating the key is a documented operation.
    const kv = fakeKv()
    await loadWithSecret(kv)

    const enc = await encryptSecret('new-pw', WRONG_KEY)
    const sb = fakeSupabase({ data: [{ key: 'EQUIFAX_PASSWORD', value: enc, is_secret: true }], error: null })
    const r = await loadEnvVars('org1', kv, sb, WRONG_KEY)

    expect(r).toEqual({ EQUIFAX_PASSWORD: 'new-pw' })
  })
})

describe('invalidateEnvCache: a superseded secret does not linger (#491)', () => {
  const OLD = 'old-password'
  const NEW = 'new-password'

  function sbWith(value: string) {
    return async () =>
      fakeSupabase({ data: [{ key: 'EQUIFAX_PASSWORD', value: await encryptSecret(value, KEY), is_secret: true }], error: null })
  }

  it('purges the rotated secret from the last-good copy instead of keeping it forever', async () => {
    const kv = fakeKv()
    await loadEnvVars('org1', kv, await sbWith(OLD)(), KEY)
    expect(await loadEnvVars('org1', kv, await sbWith(OLD)(), KEY)).toEqual({ EQUIFAX_PASSWORD: OLD })

    // The operator rotates the credential: the DB now holds the new value, and the
    // route invalidates the cache.
    await invalidateEnvCache('org1', kv, await sbWith(NEW)(), KEY)

    // The old credential must be gone from KV entirely, not just from the short key.
    expect(kvContents(kv)).not.toContain(OLD)

    // And the next read serves the new one.
    const r = await loadEnvVars('org1', kv, await sbWith(NEW)(), KEY)
    expect(r).toEqual({ EQUIFAX_PASSWORD: NEW })
  })

  it('leaves a usable last-good behind, so a DB blip right after a rotation does not blank creds (#391)', async () => {
    // The whole point of last-good is that creds never go blank during a DB blip.
    // Purging the rotated value must not be done by simply deleting last-good and
    // hoping: that would reopen the #391 outage in the window after any edit.
    const kv = fakeKv()
    await loadEnvVars('org1', kv, await sbWith(OLD)(), KEY)

    await invalidateEnvCache('org1', kv, await sbWith(NEW)(), KEY)

    // Now the DB goes down. The loader must still serve the CURRENT credential.
    const down = fakeSupabase({ data: null, error: { message: 'pool exhausted' } })
    const r = await loadEnvVars('org1', kv, down, KEY)
    expect(r).toEqual({ EQUIFAX_PASSWORD: NEW })
  })
})
