/**
 * The ops Anthropic service (#2337): an API key for one Anthropic workspace,
 * driven through the real verify, connectionFetch, seal and static key minter,
 * with the ops database and the bidding Worker as doubles. connectionFetch
 * sends the key as x-api-key and the declared workspace as
 * anthropic-workspace-id on every request, so a key is only ever used in the
 * workspace its connection names, and verify proves both with the free models
 * list.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { resolveRuntimeAction } from '@bidspoke/service-catalogue/runtime'
import { anthropicIdentity, anthropicServiceEntry } from '../anthropic-service'
import { connectionFetch, type ConnectionCall } from '../connection-fetch'
import type { OpsConnectionsDeps, OpsServiceEntry } from '../ops-connections'
import { verifyConnection } from '../ops-connections'
import { ConnectionRefusal, RequeueAt } from '../refusals'
import { opsServiceEntry, registeredOpsServices } from '../services'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, visibleText, type Doubles, type TestKeys } from './harness'

/** The canary key: not shaped like a real one, so no scanner reads it as a secret. */
const API_KEY = 'canary-anthropic-key-2337'
const WORKSPACE = 'wrkspc_0PS2337'
const ORGANIZATION = '0a1b2c3d-0000-4000-8000-000000002337'
const TARGET = { workspace_id: WORKSPACE }

let keys: TestKeys
let envelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  envelope = await sealLogin(keys, { service: 'anthropic', plaintext: JSON.stringify({ api_key: API_KEY }) })
}, 120_000)

const anthropic = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const anthropicError = (status: number, type: string, headers: Record<string, string> = {}) =>
  anthropic({ type: 'error', error: { type, message: 'refused' } }, status, headers)

/** The models list, with the headers Anthropic answers it with. */
const models = (headers: Record<string, string> = { 'anthropic-organization-id': ORGANIZATION, 'anthropic-workspace-id': WORKSPACE }) =>
  anthropic({ data: [{ type: 'model', id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5' }], has_more: false, first_id: 'a', last_id: 'a' }, 200, headers)

interface World {
  d: Doubles
  deps: OpsConnectionsDeps
  measured: unknown[]
}

function world(target: unknown = TARGET): World {
  const services: Record<string, OpsServiceEntry> = { anthropic: anthropicServiceEntry() }
  const d = makeDoubles(keys, usableCopy(envelope, { service: 'anthropic', target }), () => [services.anthropic.rules])
  const measured: unknown[] = []
  const deps: OpsConnectionsDeps = {
    connection: d.deps,
    services: (service) => (Object.hasOwn(services, service) ? services[service] : undefined),
    moneyIdentities: async () => {
      throw new Error('an Anthropic verify never asks for money\'s Salesforce identity')
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

describe('verify of an Anthropic workspace key', () => {
  it('lists the models, which costs nothing, with the key, the declared workspace and the API version', async () => {
    const w = world()
    w.d.respond(models())
    expect(await verify(w)).toEqual({
      ok: true, service: 'anthropic', generation: 1,
      identity: { kind: 'anthropic', workspace_id: WORKSPACE, organization_id: ORGANIZATION },
    })
    expect(w.d.rec.sent).toHaveLength(1)
    const [sent] = w.d.rec.sent
    expect(sent.url).toBe('https://api.anthropic.com/v1/models')
    expect(sent.init.method ?? 'GET').toBe('GET')
    const headers = new Headers(sent.init.headers)
    expect(headers.get('x-api-key')).toBe(API_KEY)
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('anthropic-workspace-id')).toBe(WORKSPACE)
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(w.measured).toEqual([])
  })

  it('passes a key Anthropic answers without naming its organization or workspace, since the workspace header was honoured', async () => {
    const w = world()
    w.d.respond(models({}))
    expect(await verify(w)).toMatchObject({ ok: true, identity: { kind: 'anthropic', workspace_id: WORKSPACE, organization_id: null } })
  })

  it('refuses a key Anthropic says runs in another workspace, naming no value', async () => {
    const w = world()
    w.d.respond(models({ 'anthropic-organization-id': ORGANIZATION, 'anthropic-workspace-id': 'wrkspc_ELSEWHERE' }))
    const answer = await verify(w)
    expect(answer).toMatchObject({ ok: false, refused: 'verify_anthropic_workspace_mismatch' })
    expect(JSON.stringify(answer)).not.toContain('wrkspc_ELSEWHERE')
  })

  it('a key Anthropic refuses twice (revoked, deleted, disabled) is needs_reauth through connectionFetch', async () => {
    const w = world()
    const refused = () => anthropicError(401, 'authentication_error')
    w.d.respond(refused, refused)
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'connection_needs_reauth' })
    expect(w.d.rec.sent).toHaveLength(2)
  })

  it('a 429 is connection_rate_limited with its time', async () => {
    const w = world()
    w.d.respond(anthropicError(429, 'rate_limit_error', { 'retry-after': '30' }))
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'connection_rate_limited' })
  })

  it('an answer it cannot read is unreadable by name, its body never quoted', async () => {
    for (const answer of [new Response('<html>edge</html>', { status: 200 }), anthropic({ has_more: false }), anthropicError(529, 'overloaded_error'), anthropicError(403, 'permission_error')]) {
      const w = world()
      w.d.respond(answer)
      const refused = await verify(w)
      expect(refused).toMatchObject({ ok: false, refused: 'verify_identity_unreadable' })
      expect(JSON.stringify(refused)).not.toContain('edge')
    }
  })

  it('a target that declares no workspace, or one no header can carry, is refused before anything is sent', async () => {
    for (const target of [{}, { workspace_id: ' ' }, { workspace_id: 'wrkspc_1\r\nx-api-key: y' }, { workspace_id: 'wrkspc 1' }]) {
      const w = world(target)
      expect(await verify(w), JSON.stringify(target)).toMatchObject({ ok: false })
      expect(w.d.rec.sent).toEqual([])
    }
  })
})

describe('the Anthropic entry', () => {
  it('is registered on the ops Worker with its identity measurement, and declares api.anthropic.com as its one host', () => {
    expect(registeredOpsServices()).toContain('anthropic')
    const entry = opsServiceEntry('anthropic')
    expect(entry?.identity).toBe(anthropicIdentity)
    expect(entry?.rules.declaredHosts(TARGET, {})).toEqual(['api.anthropic.com'])
    expect(() => entry?.rules.declaredHosts({}, {})).toThrow()
  })

  it('reads a 401 as the expiry signal, and nothing else', async () => {
    const rules = anthropicServiceEntry().rules
    expect(await rules.expired(anthropicError(401, 'authentication_error'))).toBe(true)
    for (const status of [200, 400, 403, 404, 429, 500, 529]) {
      expect(await rules.expired(anthropic({}, status)), String(status)).toBe(false)
    }
  })
})

describe('anthropic.chat through the real connectionFetch (#2337)', () => {
  const CHAT = (() => {
    const resolved = resolveRuntimeAction('anthropic.chat', 1)
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

  const ctx = (w: World) => ({ fetch: stepFetch(w), signal: new AbortController().signal, target: TARGET, sleep: () => Promise.reject(new Error('never waits')) })
  const ARGS = { model: 'claude-sonnet-4-5-20250929', user_message: 'Summarise this pitch.', max_tokens: 400 }
  const message = () => anthropic({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'In short.' }], stop_reason: 'end_turn' })

  it('chats with the key and the workspace connectionFetch applies and the version the action sends, to api.anthropic.com only', async () => {
    const w = world()
    w.d.respond(message())
    expect(await CHAT.run(ctx(w), ARGS)).toMatchObject({ text: 'In short.', stop_reason: 'end_turn' })
    expect(w.d.rec.sent.map((s) => s.url)).toEqual(['https://api.anthropic.com/v1/messages'])
    const headers = new Headers(w.d.rec.sent[0].init.headers)
    expect(headers.get('x-api-key')).toBe(API_KEY)
    expect(headers.get('anthropic-workspace-id')).toBe(WORKSPACE)
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('a 429 with Retry-After is a requeue at not_before, sent once, with no wait inside the request', async () => {
    const w = world()
    w.d.respond(anthropicError(429, 'rate_limit_error', { 'retry-after': '20' }))
    const thrown: unknown = await CHAT.run(ctx(w), ARGS).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(RequeueAt)
    expect((thrown as RequeueAt).notBefore.getTime()).toBe(T0 + 20_000)
    expect(w.d.rec.sent).toHaveLength(1)
    expect(w.d.rec.slept).toEqual([])
  })

  it('a revoked key is needs_reauth after the one renewal, and its refusal names no key', async () => {
    const w = world()
    const revoked = () => anthropicError(401, 'authentication_error')
    w.d.respond(revoked, revoked)
    const thrown: unknown = await CHAT.run(ctx(w), ARGS).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(ConnectionRefusal)
    expect((thrown as ConnectionRefusal).code).toBe('connection_needs_reauth')
    expect(visibleText(thrown)).not.toContain(API_KEY)
  })

  it('refuses a host other than api.anthropic.com before anything is sent', async () => {
    const w = world()
    const thrown: unknown = await stepFetch(w)('https://api.openai.com/v1/chat/completions', { method: 'POST' }).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(ConnectionRefusal)
    expect(w.d.rec.sent).toEqual([])
  })
})
