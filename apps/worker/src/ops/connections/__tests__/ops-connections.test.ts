/**
 * OpsConnections' methods (#2335, PR 8 of phase 5 of #1689; plan: discussion
 * #2329, part 2), driven through the real connectionFetch, the real seal and the
 * real Salesforce minter, with the ops database and the bidding Worker's
 * moneyIdentities as doubles. The entrypoint that calls these over the binding
 * is ops-connections-entrypoint.ts; findings F116 and F126 are proven in
 * reconnect-candidate.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import type { SealedCandidate } from '../../../lib/ops-connections-contract'
import type { ConnectionHealthStatus, LookupAllowance, MeasuredIdentityOutcome } from '../../ops-writes'
import type { OrganizationId } from '../../ops-db'
import {
  MONEY_IDENTITY_MAX_AGE_MS, clearReauth, connectionHealth, exchangeConnectionCode, lookupConnection, revokeConnection, verifyConnection,
  type OpsConnectionsDeps, type OpsServiceEntry,
} from '../ops-connections'
import { salesforceServiceEntry } from '../salesforce-service'
import { CONN, ORG, OTHER_ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, type Doubles, type TestKeys } from './harness'
import { tokenEndpoint, type TokenEndpoint } from '../minters/__tests__/minter-harness'

const TARGET = { instance_url: 'https://trypennie.my.salesforce.com', client_id: 'ops-app-client' }
const OPS_LOGIN = { client_id: 'ops-app-client', client_secret: 'plain-ops-client-secret' }
const MONEY_CLIENT = 'money-app-client'
const OPS_ORG_ID = '00Dcs0000000001EAA'
const MONEY = { sf_org_id: OPS_ORG_ID, username: 'money-integration@trypennie.example' }
const USERINFO = 'https://trypennie.my.salesforce.com/services/oauth2/userinfo'

let keys: TestKeys
let committed: SealedEnvelope
let candidateEnvelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  committed = await sealLogin(keys, { service: 'salesforce', plaintext: JSON.stringify(OPS_LOGIN) })
  candidateEnvelope = await sealLogin(keys, { service: 'salesforce', generation: 2, plaintext: JSON.stringify(OPS_LOGIN) })
}, 120_000)

const userinfo = (orgId = OPS_ORG_ID, username = 'ops-integration@trypennie.example') =>
  Response.json({ organization_id: orgId, preferred_username: username, user_id: '005cs000000001' })

interface World {
  d: Doubles
  deps: OpsConnectionsDeps
  endpoint: TokenEndpoint
  measured: Array<{ organizationId: string; connectionId: string; generation: number; identity: { sfOrgId: string; username: string } }>
  cleared: Array<{ organizationId: string; connectionId: string }>
  moneyAsks: string[]
  setMoney: (answer: unknown) => void
  setMeasured: (outcome: MeasuredIdentityOutcome | Error) => void
}

function world(opts: { copy?: Parameters<typeof makeDoubles>[1]; services?: (endpoint: TokenEndpoint) => Record<string, OpsServiceEntry> } = {}): World {
  const endpoint = tokenEndpoint(Response.json({ access_token: 'plain-ops-access-token' }))
  const services = opts.services?.(endpoint) ?? { salesforce: salesforceServiceEntry({ fetch: endpoint.fetch, now: () => T0 }) }
  const d = makeDoubles(keys, opts.copy ?? usableCopy(committed, { service: 'salesforce', target: TARGET }), () => Object.values(services).map((s) => s.rules))
  d.respond(userinfo())
  const measured: World['measured'] = []
  const cleared: World['cleared'] = []
  const moneyAsks: string[] = []
  let money: unknown = (org: string) => ({ organization_id: org, served_at: new Date(T0).toISOString(), salesforce: { ...MONEY, measured_at: new Date(T0 - 3_600_000).toISOString() } })
  let measuredOutcome: MeasuredIdentityOutcome | Error = 'recorded'
  const deps: OpsConnectionsDeps = {
    connection: d.deps,
    services: (service) => (Object.hasOwn(services, service) ? services[service] : undefined),
    moneyIdentities: async (org) => {
      moneyAsks.push(org)
      if (money instanceof Error) throw money
      return typeof money === 'function' ? (money as (o: string) => unknown)(org) : money
    },
    recordMeasuredIdentity: async (organizationId, connectionId, generation, identity) => {
      if (measuredOutcome instanceof Error) throw measuredOutcome
      measured.push({ organizationId, connectionId, generation, identity })
      return measuredOutcome
    },
    recordReauthCleared: async (organizationId, connectionId) => {
      cleared.push({ organizationId, connectionId })
      return 'recorded'
    },
    recordTombstone: async () => ({ outcome: 'recorded', copiesRemoved: 1 }),
    readStatus: async () => ({ connections: [], reachedLimit: false }),
    takeLookupAllowance: async () => ({ outcome: 'allowed', used: 1, retryAt: null }),
    tokens: { get: () => { throw new Error('no token objects in this test') } },
    now: () => d.now.value,
  }
  return {
    d, deps, endpoint, measured, cleared, moneyAsks,
    setMoney: (answer) => { money = answer },
    setMeasured: (outcome) => { measuredOutcome = outcome },
  }
}

const candidate = (overrides: Partial<SealedCandidate> = {}): SealedCandidate => ({
  service: 'salesforce', generation: 2, envelope: candidateEnvelope as SealedCandidate['envelope'], target: TARGET, public_config: {}, ...overrides,
})

const verify = (w: World, c: SealedCandidate | null = null) => verifyConnection(w.deps, { organization_id: ORG, connection_id: CONN, candidate: c })

describe('verify: the credential is measured, never only declared', () => {
  it('a committed copy: asks userinfo through connectionFetch under the verify purpose, and records what it measured under its generation', async () => {
    const w = world()
    expect(await verify(w)).toEqual({
      ok: true, service: 'salesforce', generation: 1, identity: { kind: 'salesforce', sf_org_id: OPS_ORG_ID, username: 'ops-integration@trypennie.example' },
    })
    expect(w.d.rec.sent.map((s) => s.url)).toEqual([USERINFO])
    // Verify's lease names the declared instance host for the bootstrap slot.
    expect(w.d.rec.leases[0]).toMatchObject({ op: 'acquire', purpose: 'verify', bootstrapHost: 'trypennie.my.salesforce.com' })
    expect(w.measured).toEqual([{ organizationId: ORG, connectionId: CONN, generation: 1, identity: { sfOrgId: OPS_ORG_ID, username: 'ops-integration@trypennie.example' } }])
    expect(w.moneyAsks).toEqual([ORG])
  })

  it('a candidate: the generation passed in the call is used, while the copy still holds the older one', async () => {
    const w = world()
    const answer = await verify(w, candidate())
    expect(answer).toMatchObject({ ok: true, generation: 2 })
    expect(w.endpoint.calls).toHaveLength(1)
    expect(w.measured.map((m) => m.generation)).toEqual([2])
  })

  it('records the measurement under the generation the request carried, when a serve moved the copy on since verify read it', async () => {
    const next = await sealLogin(keys, { service: 'salesforce', generation: 3, plaintext: JSON.stringify(OPS_LOGIN) })
    const w = world()
    const reads = [usableCopy(committed, { service: 'salesforce', target: TARGET }), usableCopy(next, { service: 'salesforce', target: TARGET, generation: 3 })]
    w.d.deps.readCopy = async () => (reads.length > 1 ? reads.shift()! : reads[0])
    expect(await verify(w)).toMatchObject({ ok: true, generation: 3 })
    expect(w.measured.map((m) => m.generation)).toEqual([3])
  })

  it('refuses a credential that authenticates as money\'s Salesforce run as user, and records nothing', async () => {
    const w = world()
    w.d.respond(userinfo(OPS_ORG_ID, 'MONEY-Integration@TryPennie.example'))
    const answer = await verify(w)
    expect(answer).toMatchObject({ ok: false, refused: 'money_identity_match' })
    expect(w.measured).toEqual([])
  })

  it('money\'s org measured as a 15 character id is still money\'s org', async () => {
    const w = world()
    w.setMoney((org: string) => ({ organization_id: org, served_at: new Date(T0).toISOString(), salesforce: { sf_org_id: OPS_ORG_ID.slice(0, 15), username: MONEY.username, measured_at: new Date(T0).toISOString() } }))
    w.d.respond(userinfo(OPS_ORG_ID, MONEY.username))
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'money_identity_match' })
  })

  it('passes another user of money\'s own org: the ops connection deliberately targets it', async () => {
    const w = world()
    w.d.respond(userinfo(OPS_ORG_ID, 'ops-integration@trypennie.example'))
    expect(await verify(w)).toMatchObject({ ok: true })
  })

  it('with no reading of money\'s identity, refuses by name before any Salesforce call', async () => {
    const w = world()
    w.setMoney((org: string) => ({ organization_id: org, served_at: new Date(T0).toISOString(), salesforce: null }))
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'money_identity_unmeasured' })
    expect(w.endpoint.calls).toEqual([])
    expect(w.d.rec.sent).toEqual([])
    expect(w.d.rec.leases).toEqual([])
  })

  it('a reading just past the stated bound is unmeasured; one just inside it is a measurement', async () => {
    expect(MONEY_IDENTITY_MAX_AGE_MS).toBe(50 * 60 * 60 * 1000)
    const at = (ageMs: number) => (org: string) => ({
      organization_id: org, served_at: new Date(T0).toISOString(), salesforce: { ...MONEY, measured_at: new Date(T0 - ageMs).toISOString() },
    })
    const stale = world()
    stale.setMoney(at(MONEY_IDENTITY_MAX_AGE_MS + 1_000))
    const refused = await verify(stale)
    expect(refused).toMatchObject({ ok: false, refused: 'money_identity_unmeasured' })
    expect((refused as { detail: string }).detail).toMatch(/50 hours/)
    expect(stale.d.rec.sent).toEqual([])
    const fresh = world()
    fresh.setMoney(at(MONEY_IDENTITY_MAX_AGE_MS - 1_000))
    expect(await verify(fresh)).toMatchObject({ ok: true })
  })

  it('a reading from the future is not a measurement', async () => {
    const w = world()
    w.setMoney((org: string) => ({ organization_id: org, served_at: new Date(T0).toISOString(), salesforce: { ...MONEY, measured_at: new Date(T0 + 10 * 60_000).toISOString() } }))
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'money_identity_unmeasured' })
  })

  it('a gateway that throws, answers malformed, or answers another organization is unavailable, never a pass', async () => {
    for (const answer of [new Error('internal error; reference = abc'), { salesforce: null }, () => ({ organization_id: OTHER_ORG, served_at: new Date(T0).toISOString(), salesforce: null })]) {
      const w = world()
      w.setMoney(answer)
      const refused = await verify(w)
      expect(refused).toMatchObject({ ok: false, refused: 'money_identity_unavailable' })
      expect((refused as { detail: string }).detail).not.toContain('reference = abc')
      expect(w.d.rec.sent).toEqual([])
    }
  })

  it('an envelope holding money\'s client id with another declared is refused at verify by name, before any token is asked', async () => {
    const money = await sealLogin(keys, { service: 'salesforce', generation: 2, plaintext: JSON.stringify({ client_id: MONEY_CLIENT, client_secret: 'plain-money-client-secret' }) })
    const w = world()
    const answer = await verify(w, candidate({ envelope: money as SealedCandidate['envelope'] }))
    expect(answer).toMatchObject({ ok: false, refused: 'verify_client_id_mismatch' })
    expect(w.endpoint.calls).toEqual([])
    expect(w.d.rec.sent).toEqual([])
    // A candidate's failure writes nothing about the committed connection (F126).
    expect(w.d.rec.needsReauth).toEqual([])
    expect(JSON.stringify(answer)).not.toContain('plain-money-client-secret')
  })

  it('a person bound candidate is refused candidate_not_refreshable: it is proven by its code exchange (#2425)', async () => {
    const w = world({
      services: (endpoint) => ({
        gmail_user: {
          ...salesforceServiceEntry({ fetch: endpoint.fetch, now: () => T0 }),
          rules: { ...salesforceServiceEntry({ fetch: endpoint.fetch, now: () => T0 }).rules, service: 'gmail_user' },
          oauthUser: { tokenUrl: () => 'https://oauth2.googleapis.com/token', expired: (r) => r.status === 401 },
        },
      }),
    })
    const answer = await verify(w, candidate({ service: 'gmail_user' }))
    expect(answer).toMatchObject({ ok: false, refused: 'candidate_not_refreshable' })
    expect(w.d.rec.sent).toEqual([])
  })

  it('a service with no identity measurement is refused by name, and an unknown service too: verify never passes unmeasured', async () => {
    const w = world({ services: (endpoint) => ({ salesforce: { ...salesforceServiceEntry({ fetch: endpoint.fetch, now: () => T0 }), identity: undefined } }) })
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'verify_identity_unmeasurable' })
    const none = world({ services: () => ({}) })
    expect(await verify(none)).toMatchObject({ ok: false, refused: 'connection_service_unknown' })
  })

  it('identity_changed and an unwritable measurement are refusals; a replaced candidate measurement passes', async () => {
    const changed = world()
    changed.setMeasured('identity_changed')
    expect(await verify(changed)).toMatchObject({ ok: false, refused: 'identity_changed' })
    const removed = world()
    removed.setMeasured('connection_removed')
    expect(await verify(removed)).toMatchObject({ ok: false, refused: 'connection_removed' })
    const down = world()
    down.setMeasured(new Error('ops database down'))
    expect(await verify(down)).toMatchObject({ ok: false, refused: 'measured_identity_unrecorded' })
    const replaced = world()
    replaced.setMeasured('replaced')
    expect(await verify(replaced, candidate())).toMatchObject({ ok: true })
  })

  it('a userinfo answer that is not a 200, not JSON, or has no 18 character org id is unreadable, by name', async () => {
    for (const answer of [new Response('nope', { status: 403 }), new Response('<html>', { status: 200 }), userinfo('00Dcs00000000')]) {
      const w = world()
      w.d.respond(answer)
      expect(await verify(w)).toMatchObject({ ok: false, refused: 'verify_identity_unreadable' })
      expect(w.measured).toEqual([])
    }
  })

  it('a copy ops cannot use is refused by its state, and a 429 on userinfo is connection_rate_limited with its time', async () => {
    const expired = world({ copy: usableCopy(committed, { state: 'connection_copy_expired', envelope: null, service: 'salesforce', target: TARGET }) })
    expect(await verify(expired)).toMatchObject({ ok: false, refused: 'connection_copy_expired' })
    const limited = world()
    limited.d.respond(new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }))
    expect(await verify(limited)).toEqual({ ok: false, refused: 'connection_rate_limited', detail: expect.any(String), retry_at: new Date(T0 + 30_000).toISOString() })
  })

  it('a refusal connectionFetch makes is answered by its own code: a busy pool', async () => {
    const w = world()
    w.d.leaseAnswers({ outcome: 'pool_full', retryAt: new Date(T0 + 5_000).toISOString() })
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'sf_pool_busy' })
  })

  it('refuses a malformed organization before anything is read', async () => {
    const w = world()
    expect(await verifyConnection(w.deps, { organization_id: 'acme', connection_id: CONN, candidate: null })).toMatchObject({ ok: false, refused: 'ops_connections_request_invalid' })
    expect(w.moneyAsks).toEqual([])
  })
})

describe('clearReauth: Reconnect, the only writer of reauth_cleared_at', () => {
  it('verifies the candidate, and only then writes the clearing; it writes no copy', async () => {
    const w = world()
    const answer = await clearReauth(w.deps, { organization_id: ORG, connection_id: CONN, candidate: candidate() })
    expect(answer).toMatchObject({ ok: true, generation: 2, cleared: true })
    expect(w.measured.map((m) => m.generation)).toEqual([2])
    expect(w.cleared).toEqual([{ organizationId: ORG, connectionId: CONN }])
  })

  it('writes nothing when verify fails', async () => {
    const w = world()
    w.endpoint.respond(Response.json({ error: 'invalid_client' }, { status: 400 }))
    const answer = await clearReauth(w.deps, { organization_id: ORG, connection_id: CONN, candidate: candidate() })
    expect(answer).toMatchObject({ ok: false, refused: 'connection_needs_reauth' })
    expect(w.cleared).toEqual([])
    expect(w.d.rec.needsReauth).toEqual([])
  })

  it('a clearing that cannot be written, or a connection removed meanwhile, is refused by name', async () => {
    const down = world()
    down.deps.recordReauthCleared = async () => { throw new Error('ops database down') }
    expect(await clearReauth(down.deps, { organization_id: ORG, connection_id: CONN, candidate: candidate() })).toMatchObject({ ok: false, refused: 'reauth_clear_unrecorded' })
    const removed = world()
    removed.deps.recordReauthCleared = async () => 'connection_removed'
    expect(await clearReauth(removed.deps, { organization_id: ORG, connection_id: CONN, candidate: candidate() })).toMatchObject({ ok: false, refused: 'connection_removed' })
  })

  it('a caller that gave up before the clearing is answered aborted and nothing is cleared', async () => {
    const w = world()
    const controller = new AbortController()
    w.deps.recordMeasuredIdentity = async () => { controller.abort(); return 'recorded' }
    const answer = await clearReauth(w.deps, { organization_id: ORG, connection_id: CONN, candidate: candidate() }, controller.signal)
    expect(answer).toMatchObject({ ok: false, refused: 'connection_aborted' })
    expect(w.cleared).toEqual([])
  })
})

describe('revoke and health', () => {
  it('revoke writes the ops tombstone at once, on the bidding Worker\'s clock', async () => {
    const w = world()
    const calls: unknown[] = []
    w.deps.recordTombstone = async (org, conn, generation, removedAt) => { calls.push({ org, conn, generation, removedAt: removedAt.toISOString() }); return { outcome: 'recorded', copiesRemoved: 1 } }
    expect(await revokeConnection(w.deps, { organization_id: ORG, connection_id: CONN, generation: 3, removed_at: '2026-10-18T09:00:00.000Z' }))
      .toEqual({ ok: true, outcome: 'recorded', copies_removed: 1 })
    expect(calls).toEqual([{ org: ORG, conn: CONN, generation: 3, removedAt: '2026-10-18T09:00:00.000Z' }])
    w.deps.recordTombstone = async () => { throw new Error('ops database down') }
    expect(await revokeConnection(w.deps, { organization_id: ORG, connection_id: CONN, generation: 3, removed_at: '2026-10-18T09:00:00.000Z' })).toMatchObject({ ok: false, refused: 'revoke_unrecorded' })
  })

  it('health answers each connection\'s derived status for the one organization, and says when the page was full', async () => {
    const w = world()
    const row: ConnectionHealthStatus = {
      connectionId: CONN, service: 'salesforce', generation: 2, status: 'refresh_failing', lastCheckOkAt: null, lastCheckFailedAt: null, lastCheckCause: null,
      needsReauthAt: null, needsReauthCause: null, reauthClearedAt: null,
    }
    const asked: Array<{ org: OrganizationId; limit: number }> = []
    w.deps.readStatus = async (org, limit) => { asked.push({ org, limit }); return { connections: [row], reachedLimit: true } }
    expect(await connectionHealth(w.deps, { organization_id: ORG })).toEqual({
      ok: true, reached_limit: true,
      connections: [{
        connection_id: CONN, service: 'salesforce', generation: 2, status: 'refresh_failing', last_check_ok_at: null, last_check_failed_at: null,
        last_check_cause: null, needs_reauth_at: null, needs_reauth_cause: null, reauth_cleared_at: null,
      }],
    })
    expect(asked).toEqual([{ org: ORG, limit: 1000 }])
    w.deps.readStatus = async () => { throw new Error('ops database down') }
    expect(await connectionHealth(w.deps, { organization_id: ORG })).toMatchObject({ ok: false, refused: 'health_unavailable' })
  })
})

describe('lookup: behind the per organization cap, through connectionFetch', () => {
  const SOBJECTS = { sobjects: [{ name: 'Submission__c', label: 'Submission', queryable: true }] }

  it('takes an allowance, then asks the service through connectionFetch under the lookup purpose', async () => {
    const w = world()
    const asked: unknown[] = []
    w.deps.takeLookupAllowance = async (org, perMinute) => { asked.push({ org, perMinute }); return { outcome: 'allowed', used: 1, retryAt: null } }
    w.d.respond(Response.json(SOBJECTS))
    expect(await lookupConnection(w.deps, { organization_id: ORG, connection_id: CONN, key: 'objects', parents: [] }))
      .toEqual({ ok: true, answer: { key: 'objects', entries: [{ name: 'Submission__c', label: 'Submission' }] } })
    expect(asked).toEqual([{ org: ORG, perMinute: 60 }])
    expect(w.d.rec.sent.map((s) => s.url)).toEqual(['https://trypennie.my.salesforce.com/services/data/v59.0/sobjects/'])
    expect(w.d.rec.leases[0]).toMatchObject({ op: 'acquire', purpose: 'lookup' })
    // The connection's token is on the request, applied by connectionFetch.
    expect(new Headers(w.d.rec.sent[0].init.headers).get('authorization')).toBe('Bearer plain-ops-access-token')
  })

  it('an organization past its cap is refused with the window\'s end, and nothing is sent', async () => {
    const w = world()
    const limited: LookupAllowance = { outcome: 'rate_limited', used: 60, retryAt: new Date(T0 + 20_000).toISOString() }
    w.deps.takeLookupAllowance = async () => limited
    expect(await lookupConnection(w.deps, { organization_id: ORG, connection_id: CONN, key: 'objects', parents: [] }))
      .toEqual({ ok: false, refused: 'lookup_rate_limited', detail: expect.stringMatching(/60 lookups a minute/), retry_at: new Date(T0 + 20_000).toISOString() })
    expect(w.d.rec.sent).toEqual([])
    w.deps.takeLookupAllowance = async () => { throw new Error('ops database down') }
    expect(await lookupConnection(w.deps, { organization_id: ORG, connection_id: CONN, key: 'objects', parents: [] })).toMatchObject({ ok: false, refused: 'lookup_allowance_unavailable' })
    expect(w.d.rec.sent).toEqual([])
  })

  it('a failed describe is a named refusal, never an empty field list', async () => {
    const w = world()
    w.d.respond(new Response('down', { status: 503 }))
    expect(await lookupConnection(w.deps, { organization_id: ORG, connection_id: CONN, key: 'fields', parents: ['Submission__c'] }))
      .toMatchObject({ ok: false, refused: 'schema_service_error' })
  })

  it('a refusal from connectionFetch keeps its own code and time, and a service answering 429 is connection_rate_limited', async () => {
    const busy = world()
    busy.d.leaseAnswers({ outcome: 'pool_full', retryAt: new Date(T0 + 5_000).toISOString() })
    expect(await lookupConnection(busy.deps, { organization_id: ORG, connection_id: CONN, key: 'objects', parents: [] }))
      .toMatchObject({ ok: false, refused: 'sf_pool_busy', retry_at: new Date(T0 + 5_000).toISOString() })
    const limited = world()
    limited.d.respond(new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }))
    expect(await lookupConnection(limited.deps, { organization_id: ORG, connection_id: CONN, key: 'objects', parents: [] }))
      .toMatchObject({ ok: false, refused: 'connection_rate_limited', retry_at: new Date(T0 + 30_000).toISOString() })
  })

  it('a key the service does not answer, and a service with no lookups, are refused before anything is sent', async () => {
    const w = world()
    expect(await lookupConnection(w.deps, { organization_id: ORG, connection_id: CONN, key: 'tables', parents: [] })).toMatchObject({ ok: false, refused: 'schema_key_invalid' })
    const none = world({ services: (endpoint) => ({ salesforce: { ...salesforceServiceEntry({ fetch: endpoint.fetch, now: () => T0 }), schema: undefined } }) })
    expect(await lookupConnection(none.deps, { organization_id: ORG, connection_id: CONN, key: 'objects', parents: [] })).toMatchObject({ ok: false, refused: 'lookup_not_supported' })
    expect([...w.d.rec.sent, ...none.d.rec.sent]).toEqual([])
  })

  it('a removed connection is refused by its state', async () => {
    const w = world({ copy: usableCopy(committed, { state: 'connection_removed', envelope: null, service: 'salesforce', target: TARGET }) })
    expect(await lookupConnection(w.deps, { organization_id: ORG, connection_id: CONN, key: 'objects', parents: [] })).toMatchObject({ ok: false, refused: 'connection_removed' })
  })
})

describe('exchangeOAuthCode: a person bound login\'s consent', () => {
  it('hands the candidate, code, verifier and redirect URI to the connection\'s token object, and answers the generation', async () => {
    const exchanges: unknown[] = []
    const w = world({
      // A first consent: ops holds no copy of the connection yet.
      copy: usableCopy(committed, { state: 'not_found', envelope: null, service: null, generation: null }),
      services: (endpoint) => ({
        gmail_user: {
          rules: { ...salesforceServiceEntry({ fetch: endpoint.fetch, now: () => T0 }).rules, service: 'gmail_user' },
          oauthUser: { tokenUrl: () => 'https://oauth2.googleapis.com/token', expired: (r) => r.status === 401 },
        },
      }),
    })
    w.deps.tokens = {
      get: () => ({
        accessToken: async () => { throw new Error('not asked') },
        exchange: async (request) => { exchanges.push(request); return { ok: true, generation: 2 } },
      }),
    }
    const answer = await exchangeConnectionCode(w.deps, {
      organization_id: ORG, connection_id: CONN, candidate: candidate({ service: 'gmail_user' }), code: 'auth-code', verifier: 'v'.repeat(43), redirect_uri: 'https://bidspoke.trypennie.dev/callback',
    })
    expect(answer).toEqual({ ok: true, generation: 2 })
    expect(exchanges).toEqual([expect.objectContaining({ organizationId: ORG, connectionId: CONN, generation: 2, code: 'auth-code', verifier: 'v'.repeat(43), redirectUri: 'https://bidspoke.trypennie.dev/callback' })])
  })

  it('a service that is not person bound has no exchange, and a refused one keeps its name', async () => {
    const w = world()
    expect(await exchangeConnectionCode(w.deps, {
      organization_id: ORG, connection_id: CONN, candidate: candidate(), code: 'auth-code', verifier: 'v'.repeat(43), redirect_uri: 'https://bidspoke.trypennie.dev/callback',
    })).toMatchObject({ ok: false, refused: 'connection_service_unknown' })
  })
})
