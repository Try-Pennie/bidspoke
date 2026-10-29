/**
 * The ops HTTP service (#2337): a key in a declared header, to one declared
 * host, driven through the real verify, connectionFetch, seal and static key
 * minter, with the ops database and the bidding Worker as doubles. Verify GETs
 * the declared check path with the key, and a 2xx proves it.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { httpHostOf } from '@bidspoke/service-catalogue/schema'
import { resolveRuntimeAction } from '@bidspoke/service-catalogue/runtime'
import { connectionFetch, type ConnectionCall } from '../connection-fetch'
import { httpIdentity, httpServiceEntry, httpTargetOf } from '../http-service'
import type { OpsConnectionsDeps, OpsServiceEntry } from '../ops-connections'
import { verifyConnection } from '../ops-connections'
import { ConnectionRefusal, LoginMintError, RequeueAt } from '../refusals'
import { opsServiceEntry, opsServiceRegistry, registeredOpsServices } from '../services'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, visibleText, type Doubles, type TestKeys } from './harness'

/** The canary key: not shaped like a real one, so no scanner reads it as a secret. */
const API_KEY = 'canary-http-key-2337'
const BEARER_TOKEN = 'canary-http-bearer-2337'
const HOST = 'api.lender.example'
const TARGET = { host: `https://${HOST}/v2`, header: 'X-Partner-Key', check_path: '/v2/me' }

let keys: TestKeys
let keyEnvelope: SealedEnvelope
let bearerEnvelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  keyEnvelope = await sealLogin(keys, { service: 'http', plaintext: JSON.stringify({ api_key: API_KEY }) })
  bearerEnvelope = await sealLogin(keys, { service: 'http', plaintext: JSON.stringify({ api_key: `Bearer ${BEARER_TOKEN}` }) })
}, 120_000)

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

interface World {
  d: Doubles
  deps: OpsConnectionsDeps
}

function world(target: unknown = TARGET, envelope?: SealedEnvelope): World {
  const services: Record<string, OpsServiceEntry> = { http: httpServiceEntry() }
  const d = makeDoubles(keys, usableCopy(envelope ?? keyEnvelope, { service: 'http', target }), () => [services.http.rules])
  const deps: OpsConnectionsDeps = {
    connection: d.deps,
    services: (service) => (Object.hasOwn(services, service) ? services[service] : undefined),
    moneyIdentities: async () => {
      throw new Error('an HTTP verify never asks for money\'s Salesforce identity')
    },
    recordMeasuredIdentity: async () => {
      throw new Error('an HTTP verify records nothing')
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

describe('verify of an HTTP key', () => {
  it('GETs the declared check path on the declared host with the key in the declared header, and acts as the host', async () => {
    const w = world()
    w.d.respond(json({ id: 'me' }))
    expect(await verify(w)).toEqual({ ok: true, service: 'http', generation: 1, identity: { kind: 'http', host: HOST } })
    expect(w.d.rec.sent).toHaveLength(1)
    const [sent] = w.d.rec.sent
    expect(sent.url).toBe(`https://${HOST}/v2/me`)
    expect(sent.init.method ?? 'GET').toBe('GET')
    const headers = new Headers(sent.init.headers)
    expect(headers.get('x-partner-key')).toBe(API_KEY)
    expect(headers.get('authorization')).toBeNull()
  })

  it('sends a bearer token as the whole header value it was saved as', async () => {
    const w = world({ ...TARGET, header: 'Authorization' }, bearerEnvelope)
    w.d.respond(new Response(null, { status: 204 }))
    expect(await verify(w)).toMatchObject({ ok: true, identity: { kind: 'http', host: HOST } })
    expect(new Headers(w.d.rec.sent[0].init.headers).get('authorization')).toBe(`Bearer ${BEARER_TOKEN}`)
  })

  it('a key the API refuses twice (401) is needs_reauth through connectionFetch', async () => {
    const w = world()
    const refused = () => json({ error: 'unauthorized' }, 401)
    w.d.respond(refused, refused)
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'connection_needs_reauth' })
    expect(w.d.rec.sent).toHaveLength(2)
  })

  it('a check path answered 403, 404 or a redirect is the check refused by name, its body never quoted', async () => {
    for (const answer of [json({ error: 'key of Sam Lee forbidden' }, 403), json({}, 404), new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })]) {
      const w = world()
      w.d.respond(answer)
      const refused = await verify(w)
      expect(refused, String(answer.status)).toMatchObject({ ok: false, refused: 'verify_http_check_refused' })
      expect(JSON.stringify(refused)).not.toContain('Sam Lee')
      expect(JSON.stringify(refused)).not.toContain('evil.example')
    }
  })

  it('a server error on the check path is unreadable by name', async () => {
    const w = world()
    w.d.respond(json({ error: 'down' }, 500))
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'verify_identity_unreadable' })
  })

  it('a 429 is connection_rate_limited with its time', async () => {
    const w = world()
    w.d.respond(json({}, 429, { 'retry-after': '30' }))
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'connection_rate_limited' })
  })

  it('a target the rules refuse is refused before anything is sent', async () => {
    const targets = [
      {},
      { ...TARGET, host: 'localhost' },
      { ...TARGET, host: '10.0.0.7' },
      { ...TARGET, host: 'https://trypennie.my.salesforce.com' },
      { ...TARGET, host: 'xvrmivmpfykwwtriqwpg.supabase.co' },
      { ...TARGET, host: 'http://api.lender.example' },
      { ...TARGET, header: 'Content-Type' },
      { ...TARGET, header: 'X Key' },
      { ...TARGET, header: 'X-Key\r\nX-Other' },
      { ...TARGET, check_path: 'v2/me' },
      { ...TARGET, check_path: 'https://evil.example/v2/me' },
      { ...TARGET, check_path: '//evil.example/x' },
    ]
    for (const target of targets) {
      const w = world(target)
      expect(await verify(w), JSON.stringify(target)).toMatchObject({ ok: false })
      expect(w.d.rec.sent, JSON.stringify(target)).toEqual([])
    }
  })
})

describe('the HTTP entry', () => {
  it('is registered on the ops Worker with its identity measurement, and declares the one host its target names', () => {
    expect(registeredOpsServices()).toContain('http')
    const entry = opsServiceEntry('http')
    expect(entry?.identity).toBe(httpIdentity)
    expect(entry?.rules.declaredHosts(TARGET, {})).toEqual([HOST])
    expect(() => entry?.rules.declaredHosts({}, {})).toThrow()
    expect(httpTargetOf({ host: 'API.Lender.example', header: ' X-Key ', check_path: `https://${HOST}/ping?x=1` })).toEqual({ host: HOST, header: 'X-Key', checkPath: '/ping?x=1' })
  })

  it('reads a 401 as the expiry signal, and nothing else', async () => {
    const rules = httpServiceEntry().rules
    expect(await rules.expired(json({}, 401))).toBe(true)
    for (const status of [200, 302, 400, 403, 404, 429, 500]) {
      expect(await rules.expired(json({}, status)), String(status)).toBe(false)
    }
  })

  it('names the bare token of a "Bearer" value as a secret too, so an API echoing it alone is scrubbed', async () => {
    const auth = await httpServiceEntry().rules.authorize({
      organizationId: ORG, connectionId: CONN, service: 'http', generation: 1, target: { ...TARGET, header: 'Authorization' }, publicConfig: {},
      envelope: null, login: { plaintext: JSON.stringify({ api_key: `Bearer ${BEARER_TOKEN}` }) }, candidate: true, renew: null,
      noteMint: () => undefined, noteUnreadableRateLimitHeader: () => undefined, fetch: () => Promise.reject(new Error('a static key asks no token endpoint')),
    })
    expect(auth.headers).toEqual({ authorization: `Bearer ${BEARER_TOKEN}` })
    expect(auth.secrets).toEqual([`Bearer ${BEARER_TOKEN}`, BEARER_TOKEN])
  })

  it('refuses a target before the key is read, by rule, not as a refused login', async () => {
    const err = await httpServiceEntry().rules.authorize({
      organizationId: ORG, connectionId: CONN, service: 'http', generation: 1, target: { ...TARGET, host: 'api.openai.com' }, publicConfig: {},
      envelope: null, login: { plaintext: 'not json' }, candidate: true, renew: null,
      noteMint: () => undefined, noteUnreadableRateLimitHeader: () => undefined, fetch: () => Promise.reject(new Error('never')),
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LoginMintError)
    expect([(err as LoginMintError).kind, (err as LoginMintError).reason]).toEqual(['not_allowed', 'target_invalid'])
  })
})

describe('every other ops service owns its hosts, which an HTTP connection may never declare (#2337)', () => {
  /** A target each registered service accepts, so its declared hosts can be read. */
  const SAMPLE_TARGETS: Readonly<Record<string, unknown>> = {
    anthropic: { workspace_id: 'wrkspc_0PS' },
    openai: { project_id: 'proj_0PS' },
    slack: { team_id: 'T0PENNIE' },
    salesforce: { instance_url: 'https://trypennie.my.salesforce.com', client_id: 'ops-client' },
    snowflake: { account: 'ab12345.us-east-1', user: 'OPS_READER' },
    google: { subject: 'ops@trypennie.example' },
    supabase: { project_url: 'https://blicjwldjfjubbukxatn.supabase.co' },
  }
  const registry = opsServiceRegistry({
    google: {
      checkDelegation: async () => 'allowed',
      serviceAccountKey: () => '{}',
      tokens: { get: () => { throw new Error('never') } },
    },
    supabase: { laneProjectRefs: () => [] },
  })

  it('has a sample target for every registered service but HTTP, so a new service is held to this too', () => {
    expect(registeredOpsServices().filter((s) => s !== 'http').sort()).toEqual(Object.keys(SAMPLE_TARGETS).sort())
  })

  for (const [service, target] of Object.entries(SAMPLE_TARGETS)) {
    it(`refuses ${service}'s declared hosts as owned by another service`, () => {
      const hosts = registry(service)?.rules.declaredHosts(target, {}) ?? []
      expect(hosts.length, service).toBeGreaterThan(0)
      for (const host of hosts) expect(httpHostOf(host), `${service} ${host}`).toMatchObject({ ok: false, problem: 'service_owned' })
    })
  }
})

describe('the HTTP actions through the real connectionFetch (#2337)', () => {
  const action = (key: string) => {
    const resolved = resolveRuntimeAction(key, 1)
    if (!resolved.ok) throw new Error(resolved.message)
    return resolved.action
  }
  const GET = action('http.get-request')
  const CUSTOM = action('http.custom-request')

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

  const ctx = (w: World, deadlineMs?: number) => ({
    fetch: stepFetch(w, deadlineMs), signal: new AbortController().signal, target: TARGET,
    sleep: () => Promise.reject(new Error('never waits')), requestId: '00000000-0000-8000-8000-000000000001',
  })
  const POST = { method: 'POST', url: '/v2/leads', body: { first_name: 'Sam' } }

  it('sends the step with the key connectionFetch puts in the declared header, to the declared host only', async () => {
    const w = world()
    w.d.respond(json({ id: 'L-1' }, 201))
    expect(await CUSTOM.run(ctx(w), POST)).toEqual({ id: 'L-1' })
    expect(w.d.rec.sent.map((s) => [s.init.method, s.url])).toEqual([['POST', `https://${HOST}/v2/leads`]])
    const headers = new Headers(w.d.rec.sent[0].init.headers)
    expect(headers.get('x-partner-key')).toBe(API_KEY)
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('a step header of the declared name is replaced by the key, never sent as the step wrote it', async () => {
    const w = world()
    w.d.respond(json({ ok: true }))
    await GET.run(ctx(w), { url: '/v2/me', headers: { 'X-Partner-Key': 'a step value' } })
    expect(new Headers(w.d.rec.sent[0].init.headers).get('x-partner-key')).toBe(API_KEY)
  })

  it('an API echoing the bare token behind a Bearer value has it scrubbed from what the step returns', async () => {
    const w = world({ ...TARGET, header: 'Authorization' }, bearerEnvelope)
    w.d.respond(json({ echoed: `you sent ${BEARER_TOKEN}` }))
    const out = await GET.run({ ...ctx(w), target: { ...TARGET, header: 'Authorization' } }, { url: '/v2/me' })
    expect(JSON.stringify(out)).not.toContain(BEARER_TOKEN)
  })

  it('a 429 with Retry-After is a requeue at not_before, sent once, with no wait inside the request', async () => {
    const w = world()
    w.d.respond(json({}, 429, { 'retry-after': '20' }))
    const thrown: unknown = await CUSTOM.run(ctx(w), POST).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(RequeueAt)
    expect((thrown as RequeueAt).notBefore.getTime()).toBe(T0 + 20_000)
    expect(w.d.rec.sent).toHaveLength(1)
    expect(w.d.rec.slept).toEqual([])
  })

  it('a refused key is needs_reauth after the one renewal, and its refusal names no key', async () => {
    const w = world()
    const revoked = () => json({ error: 'unauthorized' }, 401)
    w.d.respond(revoked, revoked)
    const thrown: unknown = await GET.run(ctx(w), { url: '/v2/me' }).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(ConnectionRefusal)
    expect((thrown as ConnectionRefusal).code).toBe('connection_needs_reauth')
    expect(visibleText(thrown)).not.toContain(API_KEY)
  })

  it('a timeout after send is connection_timeout, sent once, and the custom request is not one to repeat', async () => {
    const w = world()
    w.d.respond(() => new Promise<Response>(() => undefined))
    const thrown: unknown = await CUSTOM.run(ctx(w, 20), POST).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(ConnectionRefusal)
    expect((thrown as ConnectionRefusal).code).toBe('connection_timeout')
    expect(w.d.rec.sent).toHaveLength(1)
    expect(CUSTOM.idempotent).toBe(false)
  })

  it('refuses a host other than the declared one before anything is sent, in connectionFetch as in the action', async () => {
    const w = world()
    const thrown: unknown = await stepFetch(w)('https://api.other.example/v2/leads', { method: 'POST' }).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(ConnectionRefusal)
    expect((thrown as ConnectionRefusal).code).toBe('connection_host_not_declared')
    const refused: unknown = await CUSTOM.run(ctx(w), { ...POST, url: 'https://api.other.example/v2/leads' }).catch((e: unknown) => e)
    expect((refused as { code?: string }).code).toBe('http_host_not_declared')
    expect(w.d.rec.sent).toEqual([])
  })
})
