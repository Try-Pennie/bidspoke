import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { connectionFetch, type ConnectionCall } from '../../connection-fetch'
import { ConnectionRefusal, RequeueAt } from '../../refusals'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, type Recorder, type TestKeys } from '../../__tests__/harness'
import { STATIC_KEY_PLACEMENTS, headerPlacement, staticKeyAuth, type StaticKeyPlacement } from '../static-key'
import { rulesOf } from './minter-harness'

/**
 * The static key minter (#2335, PR 4 of phase 5): Slack's bot token, OpenAI's
 * and Anthropic's keys, a Supabase key and a plain HTTP key. Nothing is minted:
 * the key is read from the opened login on every request and put where the
 * service reads it. There is no token endpoint, so a refused login is the
 * service refusing the key, and a timeout is the request's own.
 */

const KEY = 'canary-static-key-9d8c7b6a5f'
const URL_ = 'https://api.example.test/v1/thing'

let keys: TestKeys
const envelopes = new Map<string, SealedEnvelope>()

beforeAll(async () => {
  keys = await makeKeys()
  for (const field of ['api_key', 'bot_token', 'service_key']) envelopes.set(field, await sealLogin(keys, { plaintext: JSON.stringify({ [field]: KEY }) }))
  envelopes.set('missing', await sealLogin(keys, { plaintext: JSON.stringify({ other: KEY }) }))
  envelopes.set('not json', await sealLogin(keys, { plaintext: KEY }))
}, 120_000)

function setup(placement: StaticKeyPlacement, login: string = placement.field) {
  const d = makeDoubles(keys, usableCopy(envelopes.get(login)!), () => [rulesOf('example', staticKeyAuth(placement), () => ['api.example.test'])])
  return d
}

function call(rec: Recorder, overrides: Partial<ConnectionCall> = {}): ConnectionCall {
  return { organizationId: ORG, connectionId: CONN, source: { kind: 'copy' }, purpose: 'lookup', record: async (r) => { rec.recorded.push(r) }, ...overrides }
}

async function refusal(promise: Promise<unknown>): Promise<ConnectionRefusal> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ConnectionRefusal) return err
    throw new Error(`expected a ConnectionRefusal, got ${String(err)}`, { cause: err })
  }
  throw new Error('expected a ConnectionRefusal, and the call answered')
}

describe('the static key minter', () => {
  it.each([
    ['bearer (OpenAI, a plain HTTP bearer)', STATIC_KEY_PLACEMENTS.bearer, { authorization: `Bearer ${KEY}` }],
    ['slackBot', STATIC_KEY_PLACEMENTS.slackBot, { authorization: `Bearer ${KEY}` }],
    ['anthropic', STATIC_KEY_PLACEMENTS.anthropic, { 'x-api-key': KEY }],
    ['supabase', STATIC_KEY_PLACEMENTS.supabase, { apikey: KEY, authorization: `Bearer ${KEY}` }],
    ['a named header', headerPlacement('X-Api-Key'), { 'x-api-key': KEY }],
  ] as const)('%s puts the key where the service reads it, and nowhere in the record', async (_name, placement, expected) => {
    const d = setup(placement)
    expect(((await connectionFetch(d.deps, call(d.rec), URL_)) as Response).status).toBe(200)
    const sent = new Headers(d.rec.sent[0].init.headers)
    for (const [name, value] of Object.entries(expected)) expect(sent.get(name)).toBe(value)
    expect(JSON.stringify(d.rec.recorded)).not.toContain(KEY)
  })

  it('never notes a mint, so it never writes a refresh streak', async () => {
    const d = setup(STATIC_KEY_PLACEMENTS.bearer)
    await connectionFetch(d.deps, call(d.rec), URL_)
    expect(d.rec.refreshes).toEqual([])
  })

  it.each(['missing', 'not json'])('a login with no key (%s) is malformed: needs_reauth at once, nothing sent (the refused login)', async (login) => {
    const d = setup(STATIC_KEY_PLACEMENTS.bearer, login)
    expect((await refusal(connectionFetch(d.deps, call(d.rec), URL_))).code).toBe('connection_needs_reauth')
    expect(d.rec.needsReauth).toEqual([{ organizationId: ORG, connectionId: CONN, cause: 'login_refused: login_malformed' }])
    expect(d.rec.sent).toEqual([])
  })

  it('a key the service refuses is tried once more and is then needs_reauth (the expired or revoked key)', async () => {
    const d = setup(STATIC_KEY_PLACEMENTS.bearer)
    d.respond(new Response('{"error":"invalid_auth"}', { status: 401 }))
    expect((await refusal(connectionFetch(d.deps, call(d.rec), URL_))).code).toBe('connection_needs_reauth')
    expect(d.rec.sent).toHaveLength(2)
    expect(d.rec.needsReauth[0].cause).toBe('request_refused_after_renew')
  })

  it('a request that never answers is refused at the deadline (the timeout)', async () => {
    const d = setup(STATIC_KEY_PLACEMENTS.bearer)
    d.deps.deadlineMs = 20
    d.deps.fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
    expect((await refusal(connectionFetch(d.deps, call(d.rec), URL_))).code).toBe('connection_timeout')
  })

  it('a 429 is a RequeueAt', async () => {
    const d = setup(STATIC_KEY_PLACEMENTS.slackBot, 'bot_token')
    d.respond(new Response('{"ok":false,"error":"ratelimited"}', { status: 429, headers: { 'retry-after': '3' } }))
    const res = await connectionFetch(d.deps, call(d.rec), URL_)
    expect(res).toBeInstanceOf(RequeueAt)
    expect((res as RequeueAt).notBefore.getTime()).toBe(T0 + 3000)
  })

  it('refuses a header name that is not a token, so a placement cannot smuggle a second header', () => {
    expect(() => headerPlacement('X-Api-Key: x\r\nCookie')).toThrow(/not a header name/)
    expect(() => headerPlacement('')).toThrow(/not a header name/)
  })
})
