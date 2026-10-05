import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ENV_READ_MAX_PAGES, loadEnvVars, invalidateEnvCache } from '../env-loader'
import { decryptSecret, encryptSecret } from '../secret-crypto'
import { buildSandboxEnv } from '../sandbox-env'
import type { Env } from '../../index'

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
    // Accepted, not applied: these cases hold far fewer rows than one page.
    order: () => chain,
    range: () => chain,
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
    await loadEnvVars('org1', kv, fakeSupabase({ data: [{ key: 'A', value: '1', is_secret: false, scope: 'global', workflow_id: null }], error: null }), KEY, 'global-only')

    const exploding = { from: () => { throw new Error('must not query the DB on a cache hit') } } as unknown as SupabaseClient
    const r = await loadEnvVars('org1', kv, exploding, KEY, 'global-only')
    expect(r).toEqual({ A: '1' })
  })

  it('on a successful load, caches the result AND records a last-good copy', async () => {
    const kv = fakeKv()
    const sb = fakeSupabase({ data: [{ key: 'SALESFORCE_CLIENT_ID', value: 'cid', is_secret: false, scope: 'global', workflow_id: null }, { key: 'BLANK', value: '', is_secret: false, scope: 'global', workflow_id: null }], error: null })
    const r = await loadEnvVars('org1', kv, sb, KEY, 'global-only')
    expect(r).toEqual({ SALESFORCE_CLIENT_ID: 'cid' }) // empty values skipped
    expect(kv.store.has('env-vars-org1')).toBe(true)
    expect(kv.store.has('env-vars-org1-lastgood')).toBe(true)
  })

  it('decrypts secret-flagged vars so nodes get the plaintext (Dan 2026-06-26: nodes must read secrets)', async () => {
    const enc = await encryptSecret('super-secret-pw', KEY)
    const kv = fakeKv()
    const sb = fakeSupabase({ data: [{ key: 'ELIGIBILITY_SCOUT_CLIENT_SECRET', value: enc, is_secret: true, scope: 'global', workflow_id: null }], error: null })
    const r = await loadEnvVars('org1', kv, sb, KEY, 'global-only')
    expect(r).toEqual({ ELIGIBILITY_SCOUT_CLIENT_SECRET: 'super-secret-pw' })
  })

  it('skips a secret it cannot decrypt instead of injecting the raw ciphertext (prevents the 2026-06-26 Equifax outage)', async () => {
    // Encrypted with KEY but loaded with WRONG_KEY → decrypt throws.
    const enc = await encryptSecret('the-real-password', KEY)
    const kv = fakeKv()
    const sb = fakeSupabase({ data: [{ key: 'EQUIFAX_PASSWORD', value: enc, is_secret: true, scope: 'global', workflow_id: null }], error: null })
    const r = await loadEnvVars('org1', kv, sb, WRONG_KEY, 'global-only')
    // Must be ABSENT — never the ciphertext (which is what broke Equifax).
    expect(r).toEqual({})
    expect(r.EQUIFAX_PASSWORD).toBeUndefined()
  })

  it('on a DB error, does NOT cache an empty result (the bug that caused the outage)', async () => {
    const kv = fakeKv()
    const r = await loadEnvVars('org1', kv, fakeSupabase({ data: null, error: { message: 'pool exhausted' } }), KEY, 'global-only')
    expect(r).toEqual({})
    expect(kv.store.has('env-vars-org1')).toBe(false)
  })

  it('on a DB error, serves the last-good values so a transient blip does not blank creds', async () => {
    const kv = fakeKv()
    // Seed last-good the way the loader itself writes it, so the format is whatever
    // the loader uses rather than something this test asserts into existence.
    await loadEnvVars('org1', kv, fakeSupabase({ data: [{ key: 'SALESFORCE_CLIENT_ID', value: 'good', is_secret: false, scope: 'global', workflow_id: null }, { key: 'SALESFORCE_INSTANCE_URL', value: 'u', is_secret: false, scope: 'global', workflow_id: null }], error: null }), KEY, 'global-only')
    kv.store.delete('env-vars-org1') // short cache expired; only last-good remains

    const r = await loadEnvVars('org1', kv, fakeSupabase({ data: null, error: { message: 'timeout' } }), KEY, 'global-only')
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
    const sb = fakeSupabase({ data: [{ key: 'EQUIFAX_PASSWORD', value: enc, is_secret: true, scope: 'global', workflow_id: null }], error: null })
    return loadEnvVars('org1', kv, sb, KEY, 'global-only')
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
    const r = await loadEnvVars('org1', kv, exploding, KEY, 'global-only')
    expect(r).toEqual({ EQUIFAX_PASSWORD: SECRET })
  })

  it('treats a cache it cannot decrypt as a miss and reloads from the DB', async () => {
    // SECRET_ENCRYPTION_KEY was rotated after the cache was written. The stale blob
    // is now undecryptable. That must behave as a cache miss, not a crash and not
    // garbage: rotating the key is a documented operation.
    const kv = fakeKv()
    await loadWithSecret(kv)

    const enc = await encryptSecret('new-pw', WRONG_KEY)
    const sb = fakeSupabase({ data: [{ key: 'EQUIFAX_PASSWORD', value: enc, is_secret: true, scope: 'global', workflow_id: null }], error: null })
    const r = await loadEnvVars('org1', kv, sb, WRONG_KEY, 'global-only')

    expect(r).toEqual({ EQUIFAX_PASSWORD: 'new-pw' })
  })
})

describe('invalidateEnvCache: a superseded secret does not linger (#491)', () => {
  const OLD = 'old-password'
  const NEW = 'new-password'

  function sbWith(value: string) {
    return async () =>
      fakeSupabase({ data: [{ key: 'EQUIFAX_PASSWORD', value: await encryptSecret(value, KEY), is_secret: true, scope: 'global', workflow_id: null }], error: null })
  }

  it('purges the rotated secret from the last-good copy instead of keeping it forever', async () => {
    const kv = fakeKv()
    await loadEnvVars('org1', kv, await sbWith(OLD)(), KEY, 'global-only')
    expect(await loadEnvVars('org1', kv, await sbWith(OLD)(), KEY, 'global-only')).toEqual({ EQUIFAX_PASSWORD: OLD })

    // The operator rotates the credential: the DB now holds the new value, and the
    // route invalidates the cache.
    await invalidateEnvCache('org1', kv, await sbWith(NEW)(), KEY)

    // The old credential must be gone from KV entirely, not just from the short key.
    expect(kvContents(kv)).not.toContain(OLD)

    // And the next read serves the new one.
    const r = await loadEnvVars('org1', kv, await sbWith(NEW)(), KEY, 'global-only')
    expect(r).toEqual({ EQUIFAX_PASSWORD: NEW })
  })

  it('leaves a usable last-good behind, so a DB blip right after a rotation does not blank creds (#391)', async () => {
    // The whole point of last-good is that creds never go blank during a DB blip.
    // Purging the rotated value must not be done by simply deleting last-good and
    // hoping: that would reopen the #391 outage in the window after any edit.
    const kv = fakeKv()
    await loadEnvVars('org1', kv, await sbWith(OLD)(), KEY, 'global-only')

    await invalidateEnvCache('org1', kv, await sbWith(NEW)(), KEY)

    // Now the DB goes down. The loader must still serve the CURRENT credential.
    const down = fakeSupabase({ data: null, error: { message: 'pool exhausted' } })
    const r = await loadEnvVars('org1', kv, down, KEY, 'global-only')
    expect(r).toEqual({ EQUIFAX_PASSWORD: NEW })
  })

  // Failure path of the re-warm itself. The invalidate happens right after the
  // route's DB write commits, so its read should succeed, but it can still lose a
  // race with a connection-pool blip. When it does, the org must be left with
  // SOMETHING to fall back on rather than nothing: a stale last-good beats blank
  // creds (#391), and the next successful load purges it anyway.
  it('keeps the previous last-good when the re-warm read itself fails, rather than blanking it', async () => {
    const kv = fakeKv()
    await loadEnvVars('org1', kv, await sbWith(OLD)(), KEY, 'global-only')

    // The rotation committed, but the re-warm's read hits a blip.
    const down = fakeSupabase({ data: null, error: { message: 'pool exhausted' } })
    await invalidateEnvCache('org1', kv, down, KEY)

    // Short key is gone, so a later healthy load will repopulate from the DB.
    expect(kv.store.has('env-vars-org1')).toBe(false)

    // Last-good survived, so creds do not go blank while the DB is still down.
    expect(kv.store.has('env-vars-org1-lastgood')).toBe(true)
    expect(await loadEnvVars('org1', kv, down, KEY, 'global-only')).toEqual({ EQUIFAX_PASSWORD: OLD })

    // And once the DB recovers, the superseded value is purged after all.
    expect(await loadEnvVars('org1', kv, await sbWith(NEW)(), KEY, 'global-only')).toEqual({ EQUIFAX_PASSWORD: NEW })
    expect(kvContents(kv)).not.toContain(OLD)
  })

  it('does not throw out of the mutation route when the re-warm read fails', async () => {
    // invalidateEnvCache is awaited inside the route's Promise.all. If a failed
    // re-warm threw, a successful env-var edit would report as a 500.
    const kv = fakeKv()
    const down = fakeSupabase({ data: null, error: { message: 'pool exhausted' } })
    await expect(invalidateEnvCache('org1', kv, down, KEY)).resolves.toBeUndefined()
  })
})

// #1681. The table has always allowed a variable saved against ONE workflow
// (scope 'workflow', workflow_id set), and the API has always accepted one, but
// the loader read `scope = 'global'` only, so such a value never reached the run
// it was saved for and nothing told the person who saved it.
//
// These cases use a double that APPLIES the equality filters the loader sends,
// over rows from two organizations and two workflows. A double that returns its
// rows whatever was asked (fakeSupabase above) cannot see a filter that drops
// the workflow rows, or one that lets another organization's rows in (L52).
describe('loadEnvVars: workflow scoped variables (#1681)', () => {
  const ORG = 'org1'
  const WF_A = 'wf-a'
  const WF_B = 'wf-b'

  interface EnvRow {
    organization_id: string
    key: string
    value: string | null
    is_secret: boolean
    scope: string
    workflow_id: string | null
  }

  const globalRow = (key: string, value: string, org = ORG): EnvRow =>
    ({ organization_id: org, key, value, is_secret: false, scope: 'global', workflow_id: null })
  const workflowRow = (workflowId: string | null, key: string, value: string): EnvRow =>
    ({ organization_id: ORG, key, value, is_secret: false, scope: 'workflow', workflow_id: workflowId })

  function filteringSupabase(rows: EnvRow[], error: { message: string } | null = null): SupabaseClient {
    return {
      from: (table: string) => {
        if (table !== 'environment_variables') throw new Error(`unexpected table ${table}`)
        const filters: Array<[string, unknown]> = []
        const chain = {
          select: () => chain,
          // Accepted, not applied: these cases hold far fewer rows than one page.
          order: () => chain,
          range: () => chain,
          eq: (col: string, val: unknown) => {
            filters.push([col, val])
            return chain
          },
          then: (resolve: (r: unknown) => void) =>
            resolve(
              error
                ? { data: null, error }
                : {
                    data: rows.filter((r) => filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v)),
                    error: null,
                  },
            ),
        }
        return chain
      },
    } as unknown as SupabaseClient
  }

  const exploding = { from: () => { throw new Error('must not query the DB on a cache hit') } } as unknown as SupabaseClient

  const ROWS: EnvRow[] = [
    globalRow('API_URL', 'https://org.example'),
    globalRow('SHARED', 'org-shared'),
    workflowRow(WF_A, 'API_URL', 'https://a.example'),
    workflowRow(WF_A, 'ONLY_A', 'a-only'),
    workflowRow(WF_B, 'ONLY_B', 'b-only'),
    // Another organization's rows must never be read, whatever the scope.
    globalRow('API_URL', 'https://other-org.example', 'org2'),
    { ...workflowRow(WF_A, 'ONLY_A', 'other-org-a'), organization_id: 'org2' },
  ]

  it("hands a run its own workflow's value, over the org value of the same key", async () => {
    const r = await loadEnvVars(ORG, fakeKv(), filteringSupabase(ROWS), KEY, { workflowId: WF_A })
    expect(r).toEqual({ API_URL: 'https://a.example', SHARED: 'org-shared', ONLY_A: 'a-only' })
  })

  it("never hands a sibling workflow another workflow's value, including from the shared cache", async () => {
    const kv = fakeKv()
    // A's run fills the cache first, then B's run is served from it.
    await loadEnvVars(ORG, kv, filteringSupabase(ROWS), KEY, { workflowId: WF_A })
    const b = await loadEnvVars(ORG, kv, exploding, KEY, { workflowId: WF_B })
    expect(b).toEqual({ API_URL: 'https://org.example', SHARED: 'org-shared', ONLY_B: 'b-only' })

    // And the other way round, from a cold cache.
    const kv2 = fakeKv()
    await loadEnvVars(ORG, kv2, filteringSupabase(ROWS), KEY, { workflowId: WF_B })
    const a = await loadEnvVars(ORG, kv2, exploding, KEY, { workflowId: WF_A })
    expect(a).toEqual({ API_URL: 'https://a.example', SHARED: 'org-shared', ONLY_A: 'a-only' })
  })

  it('gives a caller with no workflow the org values only', async () => {
    const r = await loadEnvVars(ORG, fakeKv(), filteringSupabase(ROWS), KEY, 'global-only')
    expect(r).toEqual({ API_URL: 'https://org.example', SHARED: 'org-shared' })
  })

  // The Salesforce node holds one token per organization, so a workflow's own
  // Salesforce connection would run on the org's token (#1689 is a workflow with
  // its own Salesforce org). The API refuses one; a row written some other way is
  // not applied, and says so in the log.
  it("does not apply a workflow's own value for a Salesforce connection key", async () => {
    const rows = [
      globalRow('SALESFORCE_INSTANCE_URL', 'https://org.my.salesforce.com'),
      workflowRow(WF_A, 'SALESFORCE_INSTANCE_URL', 'https://other.my.salesforce.com'),
      workflowRow(WF_A, 'ONLY_A', 'a-only'),
    ]
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await loadEnvVars(ORG, fakeKv(), filteringSupabase(rows), KEY, { workflowId: WF_A }))
        .toEqual({ SALESFORCE_INSTANCE_URL: 'https://org.my.salesforce.com', ONLY_A: 'a-only' })
      expect(logged.mock.calls.flat().join(' ')).toContain('SALESFORCE_INSTANCE_URL')
    } finally {
      logged.mockRestore()
    }
  })

  it('applies a workflow scoped row that names no workflow to no run at all', async () => {
    const rows = [globalRow('API_URL', 'https://org.example'), workflowRow(null, 'API_URL', 'orphan')]
    expect(await loadEnvVars(ORG, fakeKv(), filteringSupabase(rows), KEY, { workflowId: WF_A })).toEqual({ API_URL: 'https://org.example' })
    expect(await loadEnvVars(ORG, fakeKv(), filteringSupabase(rows), KEY, 'global-only')).toEqual({ API_URL: 'https://org.example' })
  })

  it("decrypts a workflow scoped secret for that workflow's run, and keeps it encrypted at rest in KV", async () => {
    const kv = fakeKv()
    const rows = [{ ...workflowRow(WF_A, 'PARTNER_TOKEN', await encryptSecret('a-token', KEY)), is_secret: true }]
    expect(await loadEnvVars(ORG, kv, filteringSupabase(rows), KEY, { workflowId: WF_A })).toEqual({ PARTNER_TOKEN: 'a-token' })
    expect(await loadEnvVars(ORG, kv, exploding, KEY, { workflowId: WF_A })).toEqual({ PARTNER_TOKEN: 'a-token' })
    expect(kvContents(kv)).not.toContain('a-token')
  })

  // The choice this pins: a workflow's own secret that cannot be decrypted is
  // WITHHELD, not skipped. Skipping it would let the org value of the same key
  // show through, so a workflow saved with, say, a sandbox credential would send
  // the org's production credential instead, silently. The key is handed over
  // EMPTY rather than absent, because absent is not enough: a code node's sandbox
  // lays the Worker secrets underneath the loaded values (buildSandboxEnv), so an
  // absent key would be filled from the Worker secret of the same name, which is
  // the org's copy.
  it('withholds a workflow scoped secret it cannot decrypt, and does not put the org value in its place', async () => {
    const kv = fakeKv()
    const unreadable = await encryptSecret('a-sandbox-pw', WRONG_KEY)
    const rows: EnvRow[] = [
      { ...globalRow('EQUIFAX_PASSWORD', await encryptSecret('org-pw', KEY)), is_secret: true },
      { ...workflowRow(WF_A, 'EQUIFAX_PASSWORD', unreadable), is_secret: true },
    ]

    const a = await loadEnvVars(ORG, kv, filteringSupabase(rows), KEY, { workflowId: WF_A })
    expect(a).toEqual({ EQUIFAX_PASSWORD: '' })
    expect(Object.values(a)).not.toContain(unreadable)

    // The same from the cache, and the sibling keeps the org value.
    expect(await loadEnvVars(ORG, kv, exploding, KEY, { workflowId: WF_A })).toEqual({ EQUIFAX_PASSWORD: '' })
    expect(await loadEnvVars(ORG, kv, exploding, KEY, { workflowId: WF_B })).toEqual({ EQUIFAX_PASSWORD: 'org-pw' })

    // A code node in A does not get the Worker secret of the same name either.
    const worker = { EQUIFAX_PASSWORD: 'worker-copy' } as unknown as Env
    expect(buildSandboxEnv(worker, a).EQUIFAX_PASSWORD).toBe('')
  })

  it('on a DB error, serves the last-good values for both scopes and caches nothing (#391)', async () => {
    const kv = fakeKv()
    await loadEnvVars(ORG, kv, filteringSupabase(ROWS), KEY, { workflowId: WF_A })
    // Both short copies expired; only the last-good copies remain.
    for (const k of [...kv.store.keys()]) if (!k.endsWith('-lastgood')) kv.store.delete(k)
    const shortKeys = () => [...kv.store.keys()].filter((k) => !k.endsWith('-lastgood'))

    const down = filteringSupabase([], { message: 'pool exhausted' })
    expect(await loadEnvVars(ORG, kv, down, KEY, { workflowId: WF_A })).toEqual({ API_URL: 'https://a.example', SHARED: 'org-shared', ONLY_A: 'a-only' })
    expect(await loadEnvVars(ORG, kv, down, KEY, { workflowId: WF_B })).toEqual({ API_URL: 'https://org.example', SHARED: 'org-shared', ONLY_B: 'b-only' })
    expect(shortKeys()).toEqual([])
  })

  it('on a DB error with no last-good copy, returns nothing and caches nothing', async () => {
    const kv = fakeKv()
    const down = filteringSupabase([], { message: 'pool exhausted' })
    expect(await loadEnvVars(ORG, kv, down, KEY, { workflowId: WF_A })).toEqual({})
    expect(kv.store.size).toBe(0)
  })

  it('reloads when the org copy is held but the workflow copy it names is not, rather than serving the org values alone', async () => {
    const kv = fakeKv()
    const before = [globalRow('API_URL', 'https://org.example'), workflowRow(WF_A, 'API_URL', 'https://a-old.example')]
    await loadEnvVars(ORG, kv, filteringSupabase(before), KEY, { workflowId: WF_A })
    // The workflow copy expired a moment before the org copy did.
    kv.store.delete(`env-vars-${ORG}-workflow-scoped`)
    expect(kv.store.has(`env-vars-${ORG}`)).toBe(true)
    const now = [globalRow('API_URL', 'https://org.example'), workflowRow(WF_A, 'API_URL', 'https://a-new.example')]
    expect(await loadEnvVars(ORG, kv, filteringSupabase(now), KEY, { workflowId: WF_A })).toEqual({ API_URL: 'https://a-new.example' })
  })

  it("re-warms the workflow scoped values on invalidation, so a save reaches the workflow's next run", async () => {
    const kv = fakeKv()
    await loadEnvVars(ORG, kv, filteringSupabase([workflowRow(WF_A, 'API_URL', 'old')]), KEY, { workflowId: WF_A })
    await invalidateEnvCache(ORG, kv, filteringSupabase([workflowRow(WF_A, 'API_URL', 'new')]), KEY)
    expect(await loadEnvVars(ORG, kv, exploding, KEY, { workflowId: WF_A })).toEqual({ API_URL: 'new' })
  })

  // Expand before contract (ADR 0007), applied to a cache: the release before
  // this one reads `env-vars-<org>` and its last-good copy as a flat map of the
  // org values. If the workflow values were folded into those same entries, a
  // rollback would hand every run a map with no credentials in it for up to the
  // 300 second TTL, and serve the same wrong shape from last-good during a blip.
  // An org that has workflow values gets ONE extra entry there, the marker naming
  // the load that wrote them, under a key no stored variable can have (Postgres
  // text cannot hold a NUL), so the previous release sees one inert extra value.
  it('keeps the org cache entries a flat map of the org values the previous release reads', async () => {
    const kv = fakeKv()
    await loadEnvVars(ORG, kv, filteringSupabase(ROWS), KEY, { workflowId: WF_A })
    for (const k of [`env-vars-${ORG}`, `env-vars-${ORG}-lastgood`]) {
      const blob = kv.store.get(k)
      expect(blob, k).toBeDefined()
      const parsed = JSON.parse(await decryptSecret(blob as string, KEY)) as Record<string, unknown>
      const extra = Object.keys(parsed).filter((key) => !['API_URL', 'SHARED'].includes(key))
      expect(parsed, k).toMatchObject({ API_URL: 'https://org.example', SHARED: 'org-shared' })
      expect(extra, k).toHaveLength(1)
      expect(extra[0].startsWith('\u0000'), k).toBe(true)
      expect(Object.values(parsed).every((v) => typeof v === 'string'), k).toBe(true)
    }
  })

  // Every organization in production has no workflow scoped variable today, so
  // for such an organization the loader must do exactly what it did before:
  // the same two entries, holding the same flat map, written with the same one
  // encryption. The money gate replays the engine with pinned randomness and
  // compares the cache it leaves; a second encryption draws a second IV and
  // shifts every random id after it.
  it('for an org with no workflow scoped variables, writes exactly the two entries the previous release wrote', async () => {
    const kv = fakeKv()
    const rows = [globalRow('API_URL', 'https://org.example')]
    const draws = vi.spyOn(crypto, 'getRandomValues')
    try {
      await loadEnvVars(ORG, kv, filteringSupabase(rows), KEY, { workflowId: WF_A })
      expect(draws).toHaveBeenCalledTimes(1)
    } finally {
      draws.mockRestore()
    }
    expect([...kv.store.keys()].sort()).toEqual([`env-vars-${ORG}`, `env-vars-${ORG}-lastgood`])
    expect(JSON.parse(await decryptSecret(kv.store.get(`env-vars-${ORG}`) as string, KEY))).toEqual({ API_URL: 'https://org.example' })
  })

  it('removes the workflow copies once a load finds no workflow values, so a deleted workflow secret does not linger', async () => {
    const kv = fakeKv()
    const secretRow = { ...workflowRow(WF_A, 'PARTNER_TOKEN', await encryptSecret('a-token', KEY)), is_secret: true }
    await loadEnvVars(ORG, kv, filteringSupabase([globalRow('API_URL', 'https://org.example'), secretRow]), KEY, { workflowId: WF_A })
    expect(kv.store.has(`env-vars-${ORG}-workflow-scoped-lastgood`)).toBe(true)

    // The workflow's secret is deleted, and the save invalidates.
    await invalidateEnvCache(ORG, kv, filteringSupabase([globalRow('API_URL', 'https://org.example')]), KEY)

    expect([...kv.store.keys()].sort()).toEqual([`env-vars-${ORG}`, `env-vars-${ORG}-lastgood`])
    expect(await loadEnvVars(ORG, kv, exploding, KEY, { workflowId: WF_A })).toEqual({ API_URL: 'https://org.example' })
  })

  it('still hands the run its values when removing a leftover workflow copy fails', async () => {
    const kv = fakeKv()
    vi.mocked(kv.delete).mockRejectedValue(new Error('KV write limit'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await loadEnvVars(ORG, kv, filteringSupabase([globalRow('API_URL', 'https://org.example')]), KEY, { workflowId: WF_A })
      expect(r).toEqual({ API_URL: 'https://org.example' })
      expect(logged.mock.calls.flat().join(' ')).toContain('could not remove the workflow scoped copies')
    } finally {
      logged.mockRestore()
    }
  })

  it('does not trust a workflow copy left by a different load than the org copy beside it', async () => {
    const kv = fakeKv()
    await loadEnvVars(ORG, kv, filteringSupabase([workflowRow(WF_A, 'API_URL', 'v1')]), KEY, { workflowId: WF_A })
    const staleWorkflowCopy = kv.store.get(`env-vars-${ORG}-workflow-scoped`) as string

    const now = [workflowRow(WF_A, 'API_URL', 'v2')]
    await invalidateEnvCache(ORG, kv, filteringSupabase(now), KEY)
    // Two loads raced and the older one's workflow copy landed last.
    kv.store.set(`env-vars-${ORG}-workflow-scoped`, staleWorkflowCopy)

    expect(await loadEnvVars(ORG, kv, filteringSupabase(now), KEY, { workflowId: WF_A })).toEqual({ API_URL: 'v2' })
  })
})

// #1681. The loader reads every row for an organization, its own and every
// workflow's, and caches what it read as the whole set. PostgREST answers at
// most 1,000 rows however many match, and says nothing, so an unpaged read
// would quietly drop the rest, and cache the short read as complete (L211).
// Porting the Pipedream workflows that keep their own settings can pass 1,000.
describe('loadEnvVars: every row or none (#1681)', () => {
  const ORG = 'org1'
  const WF_A = 'wf-a'
  const CAP = 1000

  interface PagedRow {
    id: string
    created_at: string
    organization_id: string
    key: string
    value: string
    is_secret: boolean
    scope: string
    workflow_id: string | null
  }

  // created_at runs in row order; ids are unique and sort the same way.
  const orgRows = (n: number): PagedRow[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `id-${String(i).padStart(5, '0')}`,
      created_at: `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(5, '0')}Z`,
      organization_id: ORG,
      key: `ORG_${i}`,
      value: `v${i}`,
      is_secret: false,
      scope: 'global',
      workflow_id: null,
    }))
  const lastRow = (n: number, key: string, value: string, workflowId: string | null): PagedRow => ({
    id: `id-${String(n).padStart(5, '0')}`,
    created_at: '2026-10-02T00:00:00.00000Z',
    organization_id: ORG,
    key,
    value,
    is_secret: false,
    scope: workflowId ? 'workflow' : 'global',
    workflow_id: workflowId,
  })

  // A double that behaves as PostgREST does: equality filters, ordering, a range,
  // and never more than 1,000 rows in one answer. `failPage` fails that page;
  // `endless` answers every page full, as a table that never ends would.
  function pagedSupabase(rows: PagedRow[], opts: { failPage?: number; endless?: boolean } = {}) {
    const seen = { pages: 0, orders: [] as string[][] }
    const sb = {
      from: () => {
        const filters: Array<[string, unknown]> = []
        const order: string[] = []
        let range: [number, number] | null = null
        const chain = {
          select: () => chain,
          eq: (col: string, val: unknown) => { filters.push([col, val]); return chain },
          order: (col: string) => { order.push(col); return chain },
          range: (from: number, to: number) => { range = [from, to]; return chain },
          then: (resolve: (r: unknown) => void) => {
            seen.pages++
            seen.orders.push([...order])
            if (opts.failPage === seen.pages) return resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } })
            if (opts.endless) return resolve({ data: orgRows(CAP), error: null })
            const matched = rows
              .filter((r) => filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v))
              .sort((a, b) => {
                for (const col of order) {
                  const x = String((a as unknown as Record<string, unknown>)[col])
                  const y = String((b as unknown as Record<string, unknown>)[col])
                  if (x !== y) return x < y ? -1 : 1
                }
                return 0
              })
            const [from, to] = range ?? [0, CAP - 1]
            resolve({ data: matched.slice(from, Math.min(to + 1, from + CAP)), error: null })
          },
        }
        return chain
      },
    } as unknown as SupabaseClient
    return { sb, seen }
  }

  it("hands a run its own value when it is the 1,001st row, and every org value before it", async () => {
    const { sb, seen } = pagedSupabase([...orgRows(CAP), lastRow(CAP, 'A_ONLY', 'a-value', WF_A)])
    const r = await loadEnvVars(ORG, fakeKv(), sb, KEY, { workflowId: WF_A })
    expect(r.A_ONLY).toBe('a-value')
    expect(Object.keys(r)).toHaveLength(CAP + 1)
    // Paged on a unique key, so no row is skipped or read twice between pages (L746).
    expect(seen.orders[0].at(-1)).toBe('id')
    expect(seen.pages).toBe(2)
  })

  it('serves last-good and caches nothing when the second page fails', async () => {
    const kv = fakeKv()
    await loadEnvVars(ORG, kv, pagedSupabase([lastRow(0, 'A_ONLY', 'good', WF_A)]).sb, KEY, { workflowId: WF_A })
    for (const k of [...kv.store.keys()]) if (!k.endsWith('-lastgood')) kv.store.delete(k)
    const lastGoodBefore = new Map([...kv.store.entries()])

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { sb, seen } = pagedSupabase([...orgRows(CAP), lastRow(CAP, 'A_ONLY', 'new', WF_A)], { failPage: 2 })
      expect(await loadEnvVars(ORG, kv, sb, KEY, { workflowId: WF_A })).toEqual({ A_ONLY: 'good' })
      expect(seen.pages).toBe(2)
    } finally {
      logged.mockRestore()
    }
    // The first page's 1,000 rows were not cached as the organization's set.
    expect(new Map([...kv.store.entries()])).toEqual(lastGoodBefore)
  })

  it('refuses a read that has not ended at the page bound, rather than caching it as complete', async () => {
    const kv = fakeKv()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { sb, seen } = pagedSupabase([], { endless: true })
      expect(await loadEnvVars(ORG, kv, sb, KEY, { workflowId: WF_A })).toEqual({})
      expect(seen.pages).toBe(ENV_READ_MAX_PAGES)
      expect(logged.mock.calls.flat().join(' ')).toContain(`within ${ENV_READ_MAX_PAGES} pages`)
    } finally {
      logged.mockRestore()
    }
    expect(kv.store.size).toBe(0)
  })
})
