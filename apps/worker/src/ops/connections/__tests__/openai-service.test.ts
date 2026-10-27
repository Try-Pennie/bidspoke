/**
 * The ops OpenAI service (#2337): an API key for one OpenAI project, driven
 * through the real verify, connectionFetch, seal and static key minter, with
 * the ops database and the bidding Worker as doubles. connectionFetch sends
 * the key as a bearer and the declared project as OpenAI-Project on every
 * request, so a key is only ever used in the project its connection names,
 * and verify proves both with the free models list.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { resolveRuntimeAction } from '@bidspoke/service-catalogue/runtime'
import { RATE_LIMIT_DEFAULT_MS, connectionFetch, type ConnectionCall } from '../connection-fetch'
import type { OpsConnectionsDeps, OpsServiceEntry } from '../ops-connections'
import { verifyConnection } from '../ops-connections'
import { openaiIdentity, openaiServiceEntry } from '../openai-service'
import { ConnectionRefusal, RequeueAt } from '../refusals'
import { opsServiceEntry, registeredOpsServices } from '../services'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, visibleText, type Doubles, type TestKeys } from './harness'

/** The canary key: not shaped like a real one, so no scanner reads it as a secret. */
const API_KEY = 'canary-openai-key-2337'
const PROJECT = 'proj_0PS2337'
const TARGET = { project_id: PROJECT }

let keys: TestKeys
let envelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  envelope = await sealLogin(keys, { service: 'openai', plaintext: JSON.stringify({ api_key: API_KEY }) })
}, 120_000)

const openai = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** OpenAI's 429 when the account has run out of credit or hit its spend limit, as OpenAI words it. */
const quotaExhausted = () => openai({
  error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' },
}, 429)

/** The models list, with the headers OpenAI answers it with. */
const models = (headers: Record<string, string> = { 'openai-organization': 'pennie-ops', 'openai-project': PROJECT }) =>
  openai({ object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model', owned_by: 'system' }] }, 200, headers)

interface World {
  d: Doubles
  deps: OpsConnectionsDeps
  measured: unknown[]
}

function world(target: unknown = TARGET): World {
  const services: Record<string, OpsServiceEntry> = { openai: openaiServiceEntry() }
  const d = makeDoubles(keys, usableCopy(envelope, { service: 'openai', target }), () => [services.openai.rules])
  const measured: unknown[] = []
  const deps: OpsConnectionsDeps = {
    connection: d.deps,
    services: (service) => (Object.hasOwn(services, service) ? services[service] : undefined),
    moneyIdentities: async () => {
      throw new Error('an OpenAI verify never asks for money\'s Salesforce identity')
    },
    recordMeasuredIdentity: async (...args) => {
      measured.push(args)
      return 'recorded'
    },
    recordReauthCleared: async () => 'recorded',
    recordTombstone: async () => ({ outcome: 'recorded', copiesRemoved: 1 }),
    readStatus: async () => ({ connections: [], reachedLimit: false }),
    takeLookupAllowance: async () => ({ outcome: 'allowed', used: 1, retryAt: null }),
    tokens: { get: () => { throw new Error('no token objects in this test') } },
    now: () => d.now.value,
  }
  return { d, deps, measured }
}

const verify = (w: World) => verifyConnection(w.deps, { organization_id: ORG, connection_id: CONN, candidate: null })

describe('verify of an OpenAI project key', () => {
  it('lists the models, which costs nothing, with the key and the declared project connectionFetch applies', async () => {
    const w = world()
    w.d.respond(models())
    expect(await verify(w)).toEqual({
      ok: true, service: 'openai', generation: 1,
      identity: { kind: 'openai', project_id: PROJECT, organization: 'pennie-ops' },
    })
    expect(w.d.rec.sent).toHaveLength(1)
    const [sent] = w.d.rec.sent
    expect(sent.url).toBe('https://api.openai.com/v1/models')
    expect(sent.init.method ?? 'GET').toBe('GET')
    const headers = new Headers(sent.init.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
    expect(headers.get('openai-project')).toBe(PROJECT)
    expect(w.measured).toEqual([])
  })

  it('passes a key OpenAI answers without naming its organization or project, since the project header was honoured', async () => {
    const w = world()
    w.d.respond(models({}))
    expect(await verify(w)).toMatchObject({ ok: true, identity: { kind: 'openai', project_id: PROJECT, organization: null } })
  })

  it('refuses a key OpenAI says answers for another project, naming no value', async () => {
    const w = world()
    w.d.respond(models({ 'openai-organization': 'pennie-ops', 'openai-project': 'proj_ELSEWHERE' }))
    const answer = await verify(w)
    expect(answer).toMatchObject({ ok: false, refused: 'verify_openai_project_mismatch' })
    expect(JSON.stringify(answer)).not.toContain('proj_ELSEWHERE')
  })

  it('a key OpenAI refuses twice (revoked, deleted, a wrong project) is needs_reauth through connectionFetch', async () => {
    const w = world()
    const refused = () => openai({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401)
    w.d.respond(refused, refused)
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'connection_needs_reauth' })
    expect(w.d.rec.sent).toHaveLength(2)
  })

  it('a 429 is connection_rate_limited with its time', async () => {
    const w = world()
    w.d.respond(openai({ error: { type: 'requests', code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '30' }))
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'connection_rate_limited' })
  })

  it('a key whose account has no quota left is refused naming it, never answered as a rate limit to come back from (#2673)', async () => {
    const w = world()
    w.d.respond(quotaExhausted())
    const answer = await verify(w)
    expect(answer).toMatchObject({ ok: false, refused: 'verify_identity_unreadable', retry_at: null })
    expect(JSON.stringify(answer)).toContain('insufficient_quota')
    expect(JSON.stringify(answer)).not.toContain('You exceeded')
    expect(w.d.rec.sent).toHaveLength(1)
  })

  it('an answer it cannot read is unreadable by name, its body never quoted', async () => {
    for (const answer of [new Response('<html>edge</html>', { status: 200 }), openai({ object: 'list' }), openai({ error: { type: 'server_error' } }, 502), openai({ error: { type: 'permission_error' } }, 403)]) {
      const w = world()
      w.d.respond(answer)
      const refused = await verify(w)
      expect(refused).toMatchObject({ ok: false, refused: 'verify_identity_unreadable' })
      expect(JSON.stringify(refused)).not.toContain('edge')
    }
  })

  it('a target that declares no project, or one no header can carry, is refused before anything is sent', async () => {
    for (const target of [{}, { project_id: ' ' }, { project_id: 'proj_1\r\nx-api-key: y' }, { project_id: 'proj 1' }]) {
      const w = world(target)
      expect(await verify(w), JSON.stringify(target)).toMatchObject({ ok: false })
      expect(w.d.rec.sent).toEqual([])
    }
  })
})

describe('the OpenAI entry', () => {
  it('is registered on the ops Worker with its identity measurement, and declares api.openai.com as its one host', () => {
    expect(registeredOpsServices()).toContain('openai')
    const entry = opsServiceEntry('openai')
    expect(entry?.identity).toBe(openaiIdentity)
    expect(entry?.rules.declaredHosts(TARGET, {})).toEqual(['api.openai.com'])
    expect(() => entry?.rules.declaredHosts({}, {})).toThrow()
  })

  it('reads a 401 as the expiry signal, and nothing else', async () => {
    const rules = openaiServiceEntry().rules
    expect(await rules.expired(openai({ error: { type: 'invalid_request_error', code: 'invalid_api_key' } }, 401))).toBe(true)
    for (const status of [200, 400, 403, 404, 429, 500]) {
      expect(await rules.expired(openai({}, status)), String(status)).toBe(false)
    }
  })

  it('reads a 429 insufficient_quota as no rate limit, by its code or its type, and any other 429 as one (#2673)', async () => {
    const check = openaiServiceEntry().rules.notRateLimited
    if (check === undefined) throw new Error('the OpenAI entry declares no check of which 429s are not rate limits')
    expect(await check(quotaExhausted())).toBe(true)
    expect(await check(openai({ error: { type: 'insufficient_quota', code: null } }, 429))).toBe(true)
    expect(await check(openai({ error: { type: 'invalid_request_error', code: 'insufficient_quota' } }, 429))).toBe(true)
    for (const body of [{ error: { type: 'requests', code: 'rate_limit_exceeded' } }, { error: { type: 'tokens' } }, { error: 'insufficient_quota' }, {}]) {
      expect(await check(openai(body, 429)), JSON.stringify(body)).toBe(false)
    }
  })

  it('throws on a 429 whose body is not JSON, so connectionFetch takes it as a rate limit and says so (#2673)', async () => {
    const check = openaiServiceEntry().rules.notRateLimited
    if (check === undefined) throw new Error('the OpenAI entry declares no check of which 429s are not rate limits')
    await expect(check(new Response('<html>429 Too Many Requests</html>', { status: 429 }))).rejects.toThrow()
  })
})

describe('the OpenAI actions through the real connectionFetch (#2337)', () => {
  const CHAT = (() => {
    const resolved = resolveRuntimeAction('openai.chat', 1)
    if (!resolved.ok) throw new Error(resolved.message)
    return resolved.action
  })()

  /** A step's call, and the executor's adapter as #1950 will build it: a RequeueAt is thrown, as itself. */
  function stepFetch(w: World) {
    const call: ConnectionCall = { organizationId: ORG, connectionId: CONN, source: { kind: 'copy' }, purpose: 'step', workflowId: 'wf-ops-1', record: async () => undefined }
    const services = w.deps.services
    const deps = { ...w.deps.connection, rulesFor: (service: string) => services(service)?.rules }
    return async (url: string, init?: RequestInit) => {
      const answer = await connectionFetch(deps, call, url, init)
      // RequeueAt is a value, not an Error, by design (refusals.ts); the executor's adapter throws it as itself.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (answer instanceof RequeueAt) throw answer
      return answer
    }
  }

  const ctx = (w: World) => ({ fetch: stepFetch(w), signal: new AbortController().signal, target: TARGET, sleep: () => Promise.reject(new Error('never waits')), requestId: '00000000-0000-8000-8000-000000000001' })
  const ARGS = { model: 'gpt-4o-mini', user_message: 'Is 3pm good?' }
  const completion = () => openai({ id: 'chatcmpl-1', choices: [{ index: 0, message: { role: 'assistant', content: 'Yes', refusal: null }, finish_reason: 'stop' }] })

  it('chats with the key and the project connectionFetch applies, to api.openai.com only', async () => {
    const w = world()
    w.d.respond(completion())
    expect(await CHAT.run(ctx(w), ARGS)).toMatchObject({ content: 'Yes', finish_reason: 'stop' })
    expect(w.d.rec.sent.map((s) => s.url)).toEqual(['https://api.openai.com/v1/chat/completions'])
    const headers = new Headers(w.d.rec.sent[0].init.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
    expect(headers.get('openai-project')).toBe(PROJECT)
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('a 429 with Retry-After is a requeue at not_before, sent once, with no wait inside the request', async () => {
    const w = world()
    w.d.respond(openai({ error: { type: 'requests', code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '20' }))
    const thrown: unknown = await CHAT.run(ctx(w), ARGS).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(RequeueAt)
    expect((thrown as RequeueAt).notBefore.getTime()).toBe(T0 + 20_000)
    expect(w.d.rec.sent).toHaveLength(1)
    expect(w.d.rec.slept).toEqual([])
    expect(w.d.rec.reports).toEqual([])
  })

  it('a rate limit with no Retry-After is still a requeue, after the stated default (#2673)', async () => {
    const w = world()
    w.d.respond(openai({ error: { type: 'tokens', code: 'rate_limit_exceeded' } }, 429))
    const thrown: unknown = await CHAT.run(ctx(w), ARGS).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(RequeueAt)
    expect((thrown as RequeueAt).notBefore.getTime()).toBe(T0 + RATE_LIMIT_DEFAULT_MS)
    expect(w.d.rec.reports).toEqual([])
  })

  it('a 429 insufficient_quota reaches the action, which fails it by name as not applied, sent once and never requeued (#2673)', async () => {
    const w = world()
    w.d.respond(quotaExhausted())
    const thrown: unknown = await CHAT.run(ctx(w), ARGS).catch((e: unknown) => e)
    expect(thrown).not.toBeInstanceOf(RequeueAt)
    expect(thrown).toMatchObject({ code: 'openai_insufficient_quota', outcome: 'not_applied' })
    expect(w.d.rec.sent).toHaveLength(1)
    expect(w.d.rec.needsReauth).toEqual([])
    expect(w.d.rec.reports).toEqual([])
  })

  it('a 429 whose body cannot be read is taken as a rate limit: requeued, and reported as taken that way (#2673)', async () => {
    const w = world()
    w.d.respond(new Response('<html>429 Too Many Requests</html>', { status: 429, headers: { 'retry-after': '20' } }))
    const thrown: unknown = await CHAT.run(ctx(w), ARGS).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(RequeueAt)
    expect((thrown as RequeueAt).notBefore.getTime()).toBe(T0 + 20_000)
    expect(w.d.rec.reports).toEqual([{ event: 'rate_limit_check_failed', connection_id: CONN, purpose: 'step', cause: 'taken_as_rate_limit' }])
  })

  it('a revoked key is needs_reauth after the one renewal, and its refusal names no key', async () => {
    const w = world()
    const revoked = () => openai({ error: { type: 'invalid_request_error', code: 'invalid_api_key' } }, 401)
    w.d.respond(revoked, revoked)
    const thrown: unknown = await CHAT.run(ctx(w), ARGS).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(ConnectionRefusal)
    expect((thrown as ConnectionRefusal).code).toBe('connection_needs_reauth')
    expect(visibleText(thrown)).not.toContain(API_KEY)
  })

  it('refuses a host other than api.openai.com before anything is sent', async () => {
    const w = world()
    const thrown: unknown = await stepFetch(w)('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' }).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(ConnectionRefusal)
    expect(w.d.rec.sent).toEqual([])
  })
})
