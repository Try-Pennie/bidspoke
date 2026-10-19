/**
 * The ops Salesforce service as registered on the ops Worker (#2337, phase 7 of
 * #1689): verify and a lookup driven through the REAL registry (services.ts),
 * the real connectionFetch, seal and client_credentials minter, with the ops
 * database and the bidding Worker as doubles.
 *
 * The pool double answers what acquire_sf_lease answers in each state
 * (supabase-ops/supabase/migrations/20261018090000_sf_purpose_caps_2335.sql,
 * proven against Postgres in supabase-ops/supabase/tests/connection_storage.test.sql):
 * nothing measured and not verify, sf_org_unmeasured; nothing measured and a
 * verify of a host with no approved bootstrap row, sf_cap_unset; a measured org
 * with no approved cap, sf_cap_unset. Production holds approved rows for the
 * trypennie org only (Decision 11, ops migration 20261020010000, proven in
 * sf_lane_approval.test.sql), so a call to any other org or host is refused at
 * the lease, by name, before a token is asked for.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { measureMoneyIdentity, readMoneyIdentities } from '../../../lib/money-identity'
import type { AcquireSfLease, SfLeaseAnswer } from '../../ops-writes'
import { lookupConnection, verifyConnection, type OpsConnectionsDeps } from '../ops-connections'
import { salesforceIdentity, salesforceSchemaTarget } from '../salesforce-service'
import { opsServiceEntry, registeredOpsServices } from '../services'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, type TestKeys } from './harness'

const HOST = 'trypennie.my.salesforce.com'
const TARGET = { instance_url: `https://${HOST}`, client_id: 'ops-app-client' }
const OPS_LOGIN = { client_id: 'ops-app-client', client_secret: 'plain-ops-client-secret' }
const SF_ORG = '00Dcs0000000001EAA'
const OPS_USER = 'ops-integration@trypennie.example'
const MONEY_USER = 'money-integration@trypennie.example'
const TOKEN_URL = `https://${HOST}/services/oauth2/token`
const USERINFO_URL = `https://${HOST}/services/oauth2/userinfo`

let keys: TestKeys
let envelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  envelope = await sealLogin(keys, { service: 'salesforce', plaintext: JSON.stringify(OPS_LOGIN) })
}, 120_000)

/** What acquire_sf_lease holds: measured rows by connection and generation, and the approved caps. */
interface Pool {
  measured: Map<string, string>
  bootstrapCaps: Set<string>
  orgCaps: Set<string>
  asks: AcquireSfLease[]
}

/** acquire_sf_lease's answers for the states these tests reach, in the function's own order. */
function acquire(pool: Pool, ask: AcquireSfLease): SfLeaseAnswer {
  pool.asks.push(ask)
  const sfOrgId = pool.measured.get(`${ask.connectionId}:${ask.generation}`)
  const granted = (kind: 'org' | 'bootstrap'): SfLeaseAnswer => ({ outcome: 'granted', leaseId: 'lease-1', expiresAt: new Date(T0 + 90_000).toISOString(), pool: kind })
  if (sfOrgId === undefined) {
    if (ask.purpose !== 'verify' || ask.bootstrapHost === undefined) return { outcome: 'sf_org_unmeasured', retryAt: null }
    return pool.bootstrapCaps.has(ask.bootstrapHost.toLowerCase()) ? granted('bootstrap') : { outcome: 'sf_cap_unset', retryAt: null }
  }
  return pool.orgCaps.has(sfOrgId) ? granted('org') : { outcome: 'sf_cap_unset', retryAt: null }
}

interface World {
  deps: OpsConnectionsDeps
  pool: Pool
  sent: string[]
  recorded: Array<{ generation: number; identity: { sfOrgId: string; username: string } }>
  moneyAsks: string[]
}

/** Money's identity as the bidding Worker serves it: measured by the daily job, read back by OpsGateway.moneyIdentities. */
async function servedMoney(username: string | null): Promise<(org: string) => Promise<unknown>> {
  const store = new Map<string, string>()
  const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v) } }
  if (username !== null) {
    const result = await measureMoneyIdentity({
      kv,
      credentialOrg: async () => ({ orgId: ORG, error: null }),
      creds: async () => ({ instanceUrl: TARGET.instance_url, clientId: 'money-app-client', clientSecret: 'plain-money-secret' }),
      token: async () => 'plain-money-token',
      fetch: async () => Response.json({ organization_id: SF_ORG, preferred_username: username }),
      now: () => T0 - 3_600_000,
    })
    expect(result.measured).toBe(true)
  }
  return (org) => readMoneyIdentities(kv, org, T0)
}

async function world(opts: { money?: string | null; pool?: Partial<Pool>; userinfoUser?: string } = {}): Promise<World> {
  const pool: Pool = { measured: new Map(), bootstrapCaps: new Set(), orgCaps: new Set(), asks: [], ...opts.pool }
  const entry = opsServiceEntry('salesforce')
  const d = makeDoubles(keys, usableCopy(envelope, { service: 'salesforce', target: TARGET }), () => (entry ? [entry.rules] : []))
  const sent: string[] = []
  const recorded: World['recorded'] = []
  const moneyAsks: string[] = []
  const money = await servedMoney(opts.money === undefined ? MONEY_USER : opts.money)
  const deps: OpsConnectionsDeps = {
    connection: {
      ...d.deps,
      acquireSfLease: async (_org, ask) => acquire(pool, ask),
      // Every request the service sends, the token request included, reaches the platform through connectionFetch's fetch.
      fetch: async (url) => {
        sent.push(url)
        if (url === TOKEN_URL) return Response.json({ access_token: 'plain-ops-access-token' })
        if (url === USERINFO_URL) return Response.json({ organization_id: SF_ORG, preferred_username: opts.userinfoUser ?? OPS_USER, user_id: '005cs000000001' })
        return new Response('not found', { status: 404 })
      },
    },
    // The real registry, as the live wiring passes it.
    services: opsServiceEntry,
    moneyIdentities: async (org) => {
      moneyAsks.push(org)
      return money(org)
    },
    recordMeasuredIdentity: async (_org, _conn, generation, identity) => {
      recorded.push({ generation, identity })
      pool.measured.set(`${CONN}:${generation}`, identity.sfOrgId)
      return 'recorded'
    },
    recordReauthCleared: async () => 'recorded',
    recordTombstone: async () => ({ outcome: 'recorded', copiesRemoved: 1 }),
    readStatus: async () => ({ connections: [], reachedLimit: false }),
    takeLookupAllowance: async () => ({ outcome: 'allowed', used: 1, retryAt: null }),
    tokens: { get: () => { throw new Error('no token objects in this test') } },
    now: () => T0,
  }
  return { deps, pool, sent, recorded, moneyAsks }
}

const verify = (w: World) => verifyConnection(w.deps, { organization_id: ORG, connection_id: CONN, candidate: null })
const lookup = (w: World) => lookupConnection(w.deps, { organization_id: ORG, connection_id: CONN, key: 'objects', parents: [] })

describe('the Salesforce entry is registered on the ops Worker', () => {
  it('with its client_credentials minter, its declared instance host, its identity measurement and its lookup target', () => {
    expect(registeredOpsServices()).toEqual(expect.arrayContaining(['salesforce', 'snowflake']))
    const entry = opsServiceEntry('salesforce')
    expect(entry?.rules.service).toBe('salesforce')
    expect(entry?.rules.declaredHosts(TARGET, {})).toEqual([HOST])
    expect(entry?.rules.salesforce?.instanceHost(TARGET)).toBe(HOST)
    expect(entry?.identity).toBe(salesforceIdentity)
    expect(entry?.schema).toBe(salesforceSchemaTarget)
    // A client_credentials login, never a person bound one.
    expect(entry?.oauthUser).toBeUndefined()
  })
})

describe('with no approved cap, as in production today: refused at the lease, by name', () => {
  it('verify reaches the lease, asks the bootstrap slot of the declared host, and is refused sf_cap_unset before any token is asked for', async () => {
    const w = await world()
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'sf_cap_unset' })
    expect(w.pool.asks).toEqual([expect.objectContaining({ purpose: 'verify', bootstrapHost: HOST, generation: 1 })])
    expect(w.sent).toEqual([])
    expect(w.recorded).toEqual([])
    expect(w.moneyAsks).toEqual([ORG])
  })

  it('verify with money\'s identity unmeasured is refused before the lease, so nothing is asked of Salesforce at all', async () => {
    const w = await world({ money: null })
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'money_identity_unmeasured' })
    expect(w.pool.asks).toEqual([])
    expect(w.sent).toEqual([])
  })

  it('a lookup of a connection verify has never measured is refused sf_org_unmeasured, and takes no bootstrap slot', async () => {
    const w = await world()
    expect(await lookup(w)).toMatchObject({ ok: false, refused: 'sf_org_unmeasured' })
    expect(w.pool.asks).toEqual([expect.objectContaining({ purpose: 'lookup', bootstrapHost: undefined })])
    expect(w.sent).toEqual([])
  })

  it('a lookup of a measured connection whose org has no approved cap is refused sf_cap_unset', async () => {
    const w = await world({ pool: { measured: new Map([[`${CONN}:1`, SF_ORG]]) } })
    expect(await lookup(w)).toMatchObject({ ok: false, refused: 'sf_cap_unset' })
    expect(w.sent).toEqual([])
  })
})

describe('once a bootstrap slot is approved: what verify measures', () => {
  const approved = () => ({ bootstrapCaps: new Set([HOST]) })

  it('mints at the declared instance through connectionFetch, asks userinfo, and records the measured identity under the generation', async () => {
    const w = await world({ pool: approved() })
    expect(await verify(w)).toEqual({ ok: true, service: 'salesforce', generation: 1, identity: { kind: 'salesforce', sf_org_id: SF_ORG, username: OPS_USER } })
    // The token memo is per isolate, so a token minted by an earlier test may be reused; userinfo is always asked.
    expect(w.sent.filter((u) => u !== TOKEN_URL)).toEqual([USERINFO_URL])
    expect(w.recorded).toEqual([{ generation: 1, identity: { sfOrgId: SF_ORG, username: OPS_USER } }])
  })

  it('refuses a credential measured as money\'s run as user, as the daily job measured it, and records nothing', async () => {
    const w = await world({ pool: approved(), userinfoUser: MONEY_USER.toUpperCase() })
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'money_identity_match' })
    expect(w.recorded).toEqual([])
  })

  it('a later lookup of the measured connection still waits on the org\'s own cap', async () => {
    const w = await world({ pool: approved() })
    await verify(w)
    expect(await lookup(w)).toMatchObject({ ok: false, refused: 'sf_cap_unset' })
  })
})
