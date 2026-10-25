/**
 * The ops Supabase service (#2337): one project's service key, driven through
 * the real verify, connectionFetch, seal and static key minter, with the ops
 * database and the bidding Worker as doubles. Verify proves the key on the
 * declared project's REST root, and refuses the bidding and ops projects before
 * anything is sent.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { resolveRuntimeAction } from '@bidspoke/service-catalogue/runtime'
import { connectionFetch, type ConnectionCall } from '../connection-fetch'
import type { OpsConnectionsDeps, OpsServiceEntry } from '../ops-connections'
import { verifyConnection } from '../ops-connections'
import { ConnectionRefusal, RequeueAt } from '../refusals'
import { opsServiceEntry, opsServiceRegistry, registeredOpsServices } from '../services'
import { supabaseServiceEntry, type SupabaseServiceDeps } from '../supabase-service'
import { BIDDING_PROJECT_REF, laneProjectRefs } from '../../ops-db'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, visibleText, type Doubles, type TestKeys } from './harness'

/** The canary key: not shaped like a real one, so no scanner reads it as a secret. */
const SERVICE_KEY = 'canary-supabase-key-2337'
const REF = 'blicjwldjfjubbukxatn'
const OPS_REF = 'zwihpjxouklvkvngkvmw'
const TARGET = { project_url: `https://${REF}.supabase.co` }
const LANES: SupabaseServiceDeps = { laneProjectRefs: () => [BIDDING_PROJECT_REF, OPS_REF] }

let keys: TestKeys
let envelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  envelope = await sealLogin(keys, { service: 'supabase', plaintext: JSON.stringify({ service_key: SERVICE_KEY }) })
}, 120_000)

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

interface World {
  d: Doubles
  deps: OpsConnectionsDeps
}

function world(target: unknown = TARGET, lanes: SupabaseServiceDeps = LANES): World {
  const services: Record<string, OpsServiceEntry> = { supabase: supabaseServiceEntry(lanes) }
  const d = makeDoubles(keys, usableCopy(envelope, { service: 'supabase', target }), () => [services.supabase.rules])
  const deps: OpsConnectionsDeps = {
    connection: d.deps,
    services: (service) => (Object.hasOwn(services, service) ? services[service] : undefined),
    moneyIdentities: async () => {
      throw new Error('a Supabase verify never asks for money\'s Salesforce identity')
    },
    recordMeasuredIdentity: async () => {
      throw new Error('a Supabase verify records nothing')
    },
    recordReauthCleared: async () => 'recorded',
    recordTombstone: async () => ({ outcome: 'recorded', copiesRemoved: 1 }),
    readStatus: async () => ({ connections: [], reachedLimit: false }),
    takeLookupAllowance: async () => ({ outcome: 'allowed', used: 1, retryAt: null }),
    tokens: { get: () => { throw new Error('no token objects in this test') } },
    now: () => d.now.value,
  }
  return { d, deps }
}

const verify = (w: World) => verifyConnection(w.deps, { organization_id: ORG, connection_id: CONN, candidate: null })

describe('verify of a Supabase service key', () => {
  it('GETs the declared project\'s REST root with the key as apikey and bearer, and acts as the project', async () => {
    const w = world()
    w.d.respond(json({ swagger: '2.0' }))
    expect(await verify(w)).toEqual({ ok: true, service: 'supabase', generation: 1, identity: { kind: 'supabase', project_ref: REF } })
    expect(w.d.rec.sent).toHaveLength(1)
    const [sent] = w.d.rec.sent
    expect(sent.url).toBe(`https://${REF}.supabase.co/rest/v1/`)
    const headers = new Headers(sent.init.headers)
    expect(headers.get('apikey')).toBe(SERVICE_KEY)
    expect(headers.get('authorization')).toBe(`Bearer ${SERVICE_KEY}`)
  })

  it.each([
    ['the bidding project', BIDDING_PROJECT_REF],
    ['the ops project', OPS_REF],
  ])('refuses %s by name before anything is sent', async (_what, ref) => {
    for (const project_url of [`https://${ref}.supabase.co`, ref]) {
      const w = world({ project_url })
      expect(await verify(w)).toMatchObject({ ok: false, refused: 'verify_supabase_lane_project' })
      expect(w.d.rec.sent).toEqual([])
    }
  })

  it('refuses rather than passes when the lane projects cannot be read', async () => {
    const w = world(TARGET, { laneProjectRefs: () => { throw new Error('OPS_SUPABASE_URL is not set') } })
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'verify_identity_unreadable' })
    expect(w.d.rec.sent).toEqual([])
  })

  it('a key of another project (the bidding key declared as this one included) is refused twice with 401, and is needs_reauth', async () => {
    const w = world()
    const refused = () => json({ message: 'Invalid API key' }, 401)
    w.d.respond(refused, refused)
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'connection_needs_reauth' })
    expect(w.d.rec.sent).toHaveLength(2)
  })

  it('a 429 is connection_rate_limited with its time, and a 5xx unreadable by name', async () => {
    const w = world()
    w.d.respond(json({}, 429, { 'retry-after': '30' }))
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'connection_rate_limited' })
    const v = world()
    v.d.respond(json({ message: 'down' }, 503))
    expect(await verify(v)).toMatchObject({ ok: false, refused: 'verify_identity_unreadable' })
  })

  it('a target naming no project is refused before anything is sent', async () => {
    for (const target of [{}, { project_url: 'https://api.example.com' }, { project_url: `https://db.${REF}.supabase.co` }]) {
      const w = world(target)
      expect(await verify(w), JSON.stringify(target)).toMatchObject({ ok: false })
      expect(w.d.rec.sent).toEqual([])
    }
  })
})

describe('the Supabase entry', () => {
  it('is registered on the ops Worker per request, and declares the project\'s one host', () => {
    expect(registeredOpsServices()).toContain('supabase')
    expect(opsServiceEntry('supabase')).toBeUndefined()
    const entry = opsServiceRegistry({
      google: { checkDelegation: async () => 'allowed', serviceAccountKey: () => undefined, tokens: { get: () => { throw new Error('never') } } },
      supabase: LANES,
    })('supabase')
    expect(entry?.rules.declaredHosts(TARGET, {})).toEqual([`${REF}.supabase.co`])
    expect(() => entry?.rules.declaredHosts({ project_url: BIDDING_PROJECT_REF }, {})).toThrow()
    expect(() => entry?.rules.declaredHosts({ project_url: OPS_REF }, {})).toThrow()
  })

  it('reads a 401 as the expiry signal, and nothing else', async () => {
    const rules = supabaseServiceEntry(LANES).rules
    expect(await rules.expired(json({}, 401))).toBe(true)
    for (const status of [200, 201, 400, 403, 404, 409, 429, 500]) {
      expect(await rules.expired(json({}, status)), String(status)).toBe(false)
    }
  })
})

describe('laneProjectRefs, the one list of projects Bidspoke runs on', () => {
  it('is the bidding project and the ops project of this Worker\'s own client', () => {
    expect(laneProjectRefs({ OPS_SUPABASE_URL: `https://${OPS_REF}.supabase.co` })).toEqual([BIDDING_PROJECT_REF, OPS_REF])
  })

  it('throws when the ops project cannot be read, or names the bidding one', () => {
    expect(() => laneProjectRefs({})).toThrow()
    expect(() => laneProjectRefs({ OPS_SUPABASE_URL: `https://${BIDDING_PROJECT_REF}.supabase.co` })).toThrow()
  })
})

describe('the Supabase actions through the real connectionFetch (#2337)', () => {
  const action = (key: string) => {
    const resolved = resolveRuntimeAction(key, 1)
    if (!resolved.ok) throw new Error(resolved.message)
    return resolved.action
  }
  const INSERT = action('supabase.insert-row')
  const SELECT = action('supabase.select-row')

  /** A step's call, and the executor's adapter as #1950 will build it: a RequeueAt is thrown, as itself. */
  function stepFetch(w: World, deadlineMs?: number) {
    const call: ConnectionCall = { organizationId: ORG, connectionId: CONN, source: { kind: 'copy' }, purpose: 'step', workflowId: 'wf-ops-1', record: async () => undefined }
    const services = w.deps.services
    const deps = { ...w.deps.connection, rulesFor: (service: string) => services(service)?.rules, ...(deadlineMs === undefined ? {} : { deadlineMs }) }
    return async (url: string, init?: RequestInit) => {
      const answer = await connectionFetch(deps, call, url, init)
      // RequeueAt is a value, not an Error, by design (refusals.ts); the executor's adapter throws it as itself.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (answer instanceof RequeueAt) throw answer
      return answer
    }
  }

  const ctx = (w: World, target: unknown = TARGET, deadlineMs?: number) => ({
    fetch: stepFetch(w, deadlineMs), signal: new AbortController().signal, target: target as never,
    sleep: () => Promise.reject(new Error('never waits')), requestId: '00000000-0000-8000-8000-000000000001',
  })
  const ROW = { table: 'leads', data: { email: 'sam@example.com' } }

  it('inserts with the key connectionFetch applies, to the declared project only', async () => {
    const w = world()
    w.d.respond(json([{ id: 7 }], 201))
    expect(await INSERT.run(ctx(w), ROW)).toMatchObject({ data: [{ id: 7 }], status: 201 })
    expect(w.d.rec.sent.map((s) => s.url)).toEqual([`https://${REF}.supabase.co/rest/v1/leads?select=*`])
    const headers = new Headers(w.d.rec.sent[0].init.headers)
    expect(headers.get('apikey')).toBe(SERVICE_KEY)
    expect(headers.get('prefer')).toBe('return=representation')
  })

  it('a 429 with Retry-After is a requeue at not_before, sent once, with no wait inside the request', async () => {
    const w = world()
    w.d.respond(json({}, 429, { 'retry-after': '20' }))
    const thrown: unknown = await INSERT.run(ctx(w), ROW).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(RequeueAt)
    expect((thrown as RequeueAt).notBefore.getTime()).toBe(T0 + 20_000)
    expect(w.d.rec.sent).toHaveLength(1)
    expect(w.d.rec.slept).toEqual([])
  })

  it('a refused key is needs_reauth after the one renewal, and its refusal names no key', async () => {
    const w = world()
    const revoked = () => json({ message: 'Invalid API key' }, 401)
    w.d.respond(revoked, revoked)
    const thrown: unknown = await SELECT.run(ctx(w), { table: 'leads', order_by: 'id' }).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(ConnectionRefusal)
    expect((thrown as ConnectionRefusal).code).toBe('connection_needs_reauth')
    expect(visibleText(thrown)).not.toContain(SERVICE_KEY)
  })

  it('a timeout after send is connection_timeout, sent once, and the insert is not one to repeat', async () => {
    const w = world()
    w.d.respond(() => new Promise<Response>(() => undefined))
    const thrown: unknown = await INSERT.run(ctx(w, TARGET, 20), ROW).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(ConnectionRefusal)
    expect((thrown as ConnectionRefusal).code).toBe('connection_timeout')
    expect(w.d.rec.sent).toHaveLength(1)
    expect(INSERT.idempotent).toBe(false)
  })

  it('a stored copy naming a lane project is refused at send, before anything is sent', async () => {
    const w = world({ project_url: OPS_REF })
    const thrown: unknown = await stepFetch(w)(`https://${OPS_REF}.supabase.co/rest/v1/leads`, { method: 'GET' }).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(ConnectionRefusal)
    expect((thrown as ConnectionRefusal).code).toBe('connection_target_invalid')
    expect(w.d.rec.sent).toEqual([])
  })

  it('refuses another project\'s host before anything is sent', async () => {
    const w = world()
    const thrown: unknown = await stepFetch(w)(`https://${OPS_REF}.supabase.co/rest/v1/leads`, { method: 'GET' }).catch((e: unknown) => e)
    expect((thrown as ConnectionRefusal).code).toBe('connection_host_not_declared')
    expect(w.d.rec.sent).toEqual([])
  })
})
