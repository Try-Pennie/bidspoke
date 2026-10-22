/**
 * The ops Slack service (#2337): the ops bot (Dan's decision 6, a separate
 * Slack app from the alerts bot), driven through the real verify,
 * connectionFetch, seal and static key minter, with the ops database and the
 * bidding Worker as doubles. Verify asks Slack's auth.test through the one
 * Slack client factory, bound to connectionFetch, as the catalogue's Slack
 * action does, so verify and a step talk to Slack one way.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { resolveRuntimeAction } from '@bidspoke/service-catalogue/runtime'
import { connectionFetch, type ConnectionCall } from '../connection-fetch'
import type { OpsConnectionsDeps, OpsServiceEntry } from '../ops-connections'
import { verifyConnection } from '../ops-connections'
import { ConnectionRefusal, RequeueAt } from '../refusals'
import { opsServiceEntry, registeredOpsServices } from '../services'
import { slackIdentity, slackServiceEntry } from '../slack-service'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, visibleText, type Doubles, type TestKeys } from './harness'

/** The canary bot token: not shaped like a real one, so no scanner reads it as a secret. */
const BOT_TOKEN = 'canary-ops-bot-token-2337'
const TARGET = { team_id: 'T0PENNIE' }

let keys: TestKeys
let envelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  envelope = await sealLogin(keys, { service: 'slack', plaintext: JSON.stringify({ bot_token: BOT_TOKEN }) })
}, 120_000)

const slack = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** auth.test's answer for a bot token. */
const authTest = (over: Record<string, unknown> = {}) =>
  slack({ ok: true, url: 'https://pennie.slack.com/', team: 'Pennie', user: 'bidspoke_ops', team_id: 'T0PENNIE', user_id: 'U0OPSBOT', bot_id: 'B0OPSBOT', ...over })

interface World {
  d: Doubles
  deps: OpsConnectionsDeps
  measured: unknown[]
}

function world(target: unknown = TARGET): World {
  const services: Record<string, OpsServiceEntry> = { slack: slackServiceEntry() }
  const d = makeDoubles(keys, usableCopy(envelope, { service: 'slack', target }), () => [services.slack.rules])
  const measured: unknown[] = []
  const deps: OpsConnectionsDeps = {
    connection: d.deps,
    services: (service) => (Object.hasOwn(services, service) ? services[service] : undefined),
    moneyIdentities: async () => {
      throw new Error('a Slack verify never asks for money\'s Salesforce identity')
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

describe('verify of a Slack ops bot token', () => {
  it('asks Slack auth.test with the bot token connectionFetch applies, and passes a bot of the declared workspace', async () => {
    const w = world()
    w.d.respond(authTest())
    expect(await verify(w)).toEqual({
      ok: true, service: 'slack', generation: 1,
      identity: { kind: 'slack', team_id: 'T0PENNIE', team: 'Pennie', user_id: 'U0OPSBOT', user: 'bidspoke_ops', bot_id: 'B0OPSBOT' },
    })
    expect(w.d.rec.sent).toHaveLength(1)
    const [sent] = w.d.rec.sent
    expect(sent.url).toBe('https://slack.com/api/auth.test')
    expect(new Headers(sent.init.headers).get('authorization')).toBe(`Bearer ${BOT_TOKEN}`)
    expect(w.measured).toEqual([])
  })

  it('refuses a bot of another workspace, naming no value', async () => {
    const w = world()
    w.d.respond(authTest({ team_id: 'T0ELSEWHERE', team: 'Elsewhere Co' }))
    const answer = await verify(w)
    expect(answer).toMatchObject({ ok: false, refused: 'verify_slack_workspace_mismatch' })
    expect(JSON.stringify(answer)).not.toContain('T0ELSEWHERE')
  })

  it("refuses a person's token: the connection is a bot in a workspace, never somebody acting as themselves", async () => {
    const w = world()
    w.d.respond(authTest({ bot_id: undefined }))
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'verify_slack_not_a_bot' })
  })

  it('a token Slack refuses twice (revoked, expired, an uninstalled app) is needs_reauth through connectionFetch', async () => {
    for (const code of ['invalid_auth', 'token_revoked', 'token_expired', 'account_inactive']) {
      const w = world()
      const refused = () => slack({ ok: false, error: code })
      w.d.respond(refused, refused)
      expect(await verify(w), code).toMatchObject({ ok: false, refused: 'connection_needs_reauth' })
      expect(w.d.rec.sent).toHaveLength(2)
    }
  })

  it('a 429 is connection_rate_limited with its time', async () => {
    const w = world()
    w.d.respond(slack({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '30' }))
    expect(await verify(w)).toMatchObject({ ok: false, refused: 'connection_rate_limited' })
  })

  it('an answer it cannot read is unreadable by name, its body never quoted', async () => {
    for (const answer of [new Response('<html>edge</html>', { status: 200 }), slack({ ok: true, team_id: 'T0PENNIE' }), new Response('{}', { status: 502 })]) {
      const w = world()
      w.d.respond(answer)
      expect(await verify(w)).toMatchObject({ ok: false, refused: 'verify_identity_unreadable' })
    }
  })

  it('a target that declares no workspace is refused before anything is sent', async () => {
    const w = world({})
    expect(await verify(w)).toMatchObject({ ok: false })
    expect(w.d.rec.sent).toEqual([])
  })
})

describe('the Slack entry', () => {
  it('is registered on the ops Worker with its identity measurement, and declares slack.com as its one host', () => {
    expect(registeredOpsServices()).toContain('slack')
    const entry = opsServiceEntry('slack')
    expect(entry?.identity).toBe(slackIdentity)
    expect(entry?.rules.declaredHosts(TARGET, {})).toEqual(['slack.com'])
    expect(() => entry?.rules.declaredHosts({}, {})).toThrow()
  })

  it("reads Slack's login refusals as the expiry signal, from the body of a 200, and nothing else", async () => {
    const rules = slackServiceEntry().rules
    for (const code of ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']) {
      expect(await rules.expired(slack({ ok: false, error: code })), code).toBe(true)
    }
    expect(await rules.expired(new Response('', { status: 401 }))).toBe(true)
    for (const answer of [slack({ ok: true }), slack({ ok: false, error: 'channel_not_found' }), slack({ ok: false, error: 'missing_scope' }), new Response('<html>', { status: 200 }), slack({ ok: false, error: 'ratelimited' }, 429)]) {
      expect(await rules.expired(answer)).toBe(false)
    }
  })
})

describe('slack.send-message through the real connectionFetch (#2337)', () => {
  const SEND = (() => {
    const resolved = resolveRuntimeAction('slack.send-message', 1)
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

  it('posts with the bot token connectionFetch applies, to slack.com only', async () => {
    const w = world()
    w.d.respond(slack({ ok: true, channel: 'C0OPS', ts: '1.2', message: { text: 'hi' } }))
    expect(await SEND.run(ctx(w), { channel: 'C0OPS', text: 'hi' })).toEqual({ ok: true, channel: 'C0OPS', ts: '1.2', message: { text: 'hi' } })
    expect(w.d.rec.sent.map((s) => s.url)).toEqual(['https://slack.com/api/chat.postMessage'])
    expect(new Headers(w.d.rec.sent[0].init.headers).get('authorization')).toBe(`Bearer ${BOT_TOKEN}`)
  })

  it('a 429 with Retry-After is a requeue at not_before, sent once, with no wait inside the request', async () => {
    const w = world()
    w.d.respond(slack({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '20' }))
    const thrown: unknown = await SEND.run(ctx(w), { channel: 'C0OPS', text: 'hi' }).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(RequeueAt)
    expect((thrown as RequeueAt).notBefore.getTime()).toBe(T0 + 20_000)
    expect(w.d.rec.sent).toHaveLength(1)
    expect(w.d.rec.slept).toEqual([])
  })

  it('a revoked token is needs_reauth after the one renewal, and its refusal names no token', async () => {
    const w = world()
    const revoked = () => slack({ ok: false, error: 'token_revoked' })
    w.d.respond(revoked, revoked)
    const thrown: unknown = await SEND.run(ctx(w), { channel: 'C0OPS', text: 'hi' }).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(ConnectionRefusal)
    expect((thrown as ConnectionRefusal).code).toBe('connection_needs_reauth')
    expect(visibleText(thrown)).not.toContain(BOT_TOKEN)
  })

  it('refuses a host other than slack.com before anything is sent', async () => {
    const w = world()
    const thrown: unknown = await stepFetch(w)('https://hooks.slack.com/services/x', { method: 'POST' }).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(ConnectionRefusal)
    expect(w.d.rec.sent).toEqual([])
  })
})
