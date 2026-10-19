/**
 * ConnectionTokenObject, live for person bound logins (#2335, PR 5 of phase 5
 * of #1689; Dan's decision 1), against the real wrangler.ops.toml in workerd:
 * real SQLite backed storage, a real alarm, real eviction.
 *
 * What is proven, by the plan's done line:
 *  - a refresh is single flight: a waiter never calls the token endpoint;
 *  - the in flight marker is clear after a failure, so the next call asks again;
 *  - a rotated refresh token is in the object's storage before the access token
 *    is returned, so a crash after the token call keeps it (the object is
 *    evicted, and the next refresh spends the rotated token, not the old one);
 *  - the write back to the declared home is a compare and set through
 *    OPS_GATEWAY.storeRotatedEnvelope, retried by the alarm while bidding is
 *    down, and an answer lost on the way back is recognised by its iv;
 *  - a Reconnect or a removal on bidding makes the object give its login up.
 *
 * The object's clock is a field set in the FUTURE (CLAUDE.md, #1410): workerd
 * fires an alarm whose time has passed at once, underneath the test, so every
 * alarm here is run by runDurableObjectAlarm, never by the runtime.
 */
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { open, seal, type SealedEnvelope } from '@bidspoke/connection-seal'
import { beforeAll, describe, expect, it } from 'vitest'
import type { StoreRotatedEnvelopeAnswer } from '../../lib/ops-gateway-contract'
import {
  CONNECTION_TOKEN_OBJECT_RPC_ONLY, ConnectionTokenObject, WRITE_BACK_RETRY_MAX_MS, WRITE_BACK_RETRY_MIN_MS, type StoredLogin,
} from '../connection-token-object'
import type { AccessTokenAnswer, ExchangeAnswer } from '../connections/token-object-contract'
import { KID, makeKeys, ORG, type TestKeys } from '../connections/__tests__/harness'
import type { OpsEnv } from '../index'

const opsEnv = env as unknown as OpsEnv

/** 2027-11-04 15:00 UTC: in the future, so no alarm fires on its own. */
const T = Date.UTC(2027, 10, 4, 15, 0)
const SERVICE = 'google_user'
const TOKEN_URL = 'https://oauth2.example.test/token'
const APP = { client_id: 'app-client-2335', client_secret: 'app-secret-2335' }
const R1 = 'refresh-token-one-2335'
const R2 = 'refresh-token-two-2335'
const R3 = 'refresh-token-three-2335'

let keys: TestKeys
beforeAll(async () => {
  keys = await makeKeys()
}, 120_000)

let n = 0
/** A fresh connection, so every test has its own object and storage. */
function connection(): string {
  n += 1
  return `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`
}

function stubFor(connectionId: string): DurableObjectStub<ConnectionTokenObject> {
  return opsEnv.CONNECTION_TOKENS!.get(opsEnv.CONNECTION_TOKENS!.idFromName(connectionId)) as DurableObjectStub<ConnectionTokenObject>
}

async function sealFor(connectionId: string, generation: number, login: Record<string, unknown>): Promise<SealedEnvelope> {
  return seal(keys.publicKeys, JSON.stringify(login), { organization_id: ORG, connection_id: connectionId, service: SERVICE, generation, kid: KID })
}

async function openStored(connectionId: string, stored: StoredLogin): Promise<Record<string, unknown>> {
  return JSON.parse(await open(keys.privateKeys, stored.envelope, {
    organization_id: ORG, connection_id: connectionId, service: SERVICE, generation: stored.generation, kid: KID,
  })) as Record<string, unknown>
}

interface TokenCall { grant: string | null; refresh: string | null; code: string | null }

/**
 * The provider's token endpoint: answers in order (the last repeats), each
 * optionally held until released. Each answer is a factory, so its Response is
 * made inside the object's own request: workerd refuses a body made in the
 * test's request and read in the object's.
 */
function tokenEndpoint(...answers: Array<(init?: RequestInit) => Response | Promise<Response>>) {
  const calls: TokenCall[] = []
  return {
    calls,
    fetch: async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = new URLSearchParams(String(init?.body ?? ''))
      calls.push({ grant: body.get('grant_type'), refresh: body.get('refresh_token'), code: body.get('code') })
      const answer = answers.length > 1 ? answers.shift()! : answers[0]
      return answer(init)
    },
  }
}

/** A token endpoint that never answers, and gives up only when the request is aborted, as a real fetch does. */
const neverAnswers = (init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
})

/** Waits until a caller is parked on the refresh in flight, so a release cannot overtake its arrival. */
async function untilWaiting(stub: DurableObjectStub<ConnectionTokenObject>, count: number): Promise<void> {
  await expect.poll(() => runInDurableObject(stub, (o: ConnectionTokenObject) => o.waitingOnFlight())).toBe(count)
}

const tokens = (access: string, refresh?: string, expiresIn = 3600) => () =>
  Response.json({ access_token: access, token_type: 'Bearer', expires_in: expiresIn, ...(refresh ? { refresh_token: refresh } : {}) })

/** OPS_GATEWAY as the object reaches it: answers in order (the last repeats); an Error is thrown. */
function gateway(...answers: Array<StoreRotatedEnvelopeAnswer | Error | ((request: unknown) => StoreRotatedEnvelopeAnswer)>) {
  const requests: Array<Record<string, unknown>> = []
  return {
    requests,
    binding: {
      opsWorkflows: async () => { throw new Error('not used') },
      opsTickStarted: async () => { throw new Error('not used') },
      opsTickCompleted: async () => { throw new Error('not used') },
      opsConnections: async () => { throw new Error('not used') },
      moneyIdentities: async () => { throw new Error('not used') },
      replaceConnectionEnvelope: async () => { throw new Error('not used') },
      storeRotatedEnvelope: async (request: unknown) => {
        requests.push(request as Record<string, unknown>)
        const answer = answers.length > 1 ? answers.shift()! : answers[0]
        if (answer instanceof Error) throw answer
        return typeof answer === 'function' ? answer(request) : answer
      },
    },
  }
}

/** Points the object at the doubles and the future clock. Run again after an eviction: fields do not survive one. */
async function wire(stub: DurableObjectStub<ConnectionTokenObject>, opts: { endpoint: ReturnType<typeof tokenEndpoint>; gw?: ReturnType<typeof gateway>; now?: () => number }) {
  await runInDurableObject(stub, (o: ConnectionTokenObject) => {
    o.clock = opts.now ?? (() => T)
    o.fetchToken = opts.endpoint.fetch
    o.sealKeys = () => ({ privateKeys: keys.privateKeys, publicKeys: keys.publicKeys, kid: KID })
    o.gateway = () => opts.gw?.binding
  })
}

function request(connectionId: string, generation: number, envelope: SealedEnvelope, rejectedTokenId: string | null = null) {
  return { organizationId: ORG, connectionId, service: SERVICE, generation, envelope, tokenUrl: TOKEN_URL, rejectedTokenId }
}

async function stored(stub: DurableObjectStub<ConnectionTokenObject>): Promise<StoredLogin | undefined> {
  return runInDurableObject(stub, (_o: ConnectionTokenObject, state: DurableObjectState) => state.storage.get<StoredLogin>('login'))
}

async function alarmAt(stub: DurableObjectStub<ConnectionTokenObject>): Promise<number | null> {
  return runInDurableObject(stub, (_o: ConnectionTokenObject, state: DurableObjectState) => state.storage.getAlarm())
}

function ok(answer: AccessTokenAnswer): Extract<AccessTokenAnswer, { ok: true }> {
  if (!answer.ok) throw new Error(`expected a token, got ${answer.kind}: ${answer.reason}`)
  return answer
}

describe('ConnectionTokenObject in workerd (#2334, #2335)', () => {
  it('constructs from the CONNECTION_TOKENS binding, on SQLite backed storage, and serves no HTTP', async () => {
    const stub = stubFor(connection())
    await runInDurableObject(stub, (instance: ConnectionTokenObject, state: DurableObjectState) => {
      expect(instance).toBeInstanceOf(ConnectionTokenObject)
      expect(state.storage.sql.exec<{ n: number }>('SELECT 1 AS n').one().n).toBe(1)
    })
    const res = await stub.fetch('https://connection-token-object/token', { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: CONNECTION_TOKEN_OBJECT_RPC_ONLY })
  })
})

describe('a refresh is single flight', () => {
  it('two callers at once cause one token request, and the waiter never calls the endpoint', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const endpoint = tokenEndpoint(async () => { await held; return tokens('access-one')() })
    await wire(stub, { endpoint })
    const envelope = await sealFor(conn, 1, { ...APP, refresh_token: R1 })
    const first = stub.accessToken(request(conn, 1, envelope))
    // The holder is inside the token request before the second caller arrives.
    await expect.poll(() => endpoint.calls.length).toBe(1)
    const second = stub.accessToken(request(conn, 1, envelope))
    await untilWaiting(stub, 1)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(endpoint.calls).toHaveLength(1)
    expect(ok(a).token).toBe('access-one')
    expect(ok(b).token).toBe('access-one')
    expect(ok(a).minted).toBe(true)
    // Held now: a third call is answered from the object without asking again, and says so.
    const third = ok(await stub.accessToken(request(conn, 1, envelope)))
    expect(third).toMatchObject({ token: 'access-one', minted: false })
    expect(endpoint.calls).toHaveLength(1)
  })

  it('drops a token the service rejected only when it still holds that one, then asks again', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    const endpoint = tokenEndpoint(tokens('access-one'), tokens('access-two'))
    await wire(stub, { endpoint })
    const envelope = await sealFor(conn, 1, { ...APP, refresh_token: R1 })
    const first = ok(await stub.accessToken(request(conn, 1, envelope)))
    // An id the object does not hold changes nothing.
    expect(ok(await stub.accessToken(request(conn, 1, envelope, 'some-other-token-id'))).token).toBe('access-one')
    const renewed = ok(await stub.accessToken(request(conn, 1, envelope, first.tokenId)))
    expect(renewed.token).toBe('access-two')
    expect(endpoint.calls).toHaveLength(2)
  })
})

describe('a failure clears the in flight marker', () => {
  it.each([
    ['invalid_client', () => Response.json({ error: 'invalid_client' }, { status: 401 }), 'refused', 'invalid_client'],
    ['invalid_grant', () => Response.json({ error: 'invalid_grant' }, { status: 400 }), 'refused', 'invalid_grant'],
    ['a 5xx', () => new Response('upstream', { status: 503 }), 'unavailable', 'token_endpoint_5xx'],
  ] as const)('%s is answered by kind, and the next call asks the endpoint again', async (_what, failing, kind, reason) => {
    const conn = connection()
    const stub = stubFor(conn)
    const endpoint = tokenEndpoint(failing, tokens('access-after'))
    await wire(stub, { endpoint })
    const envelope = await sealFor(conn, 1, { ...APP, refresh_token: R1 })
    const failed = await stub.accessToken(request(conn, 1, envelope))
    expect(failed).toEqual({ ok: false, kind, reason, retryAtMs: null })
    await runInDurableObject(stub, (o: ConnectionTokenObject) => { expect(o.inFlightSince()).toBeNull() })
    expect(ok(await stub.accessToken(request(conn, 1, envelope))).token).toBe('access-after')
    expect(endpoint.calls).toHaveLength(2)
    expect(await stored(stub)).toBeUndefined()
  })

  it('a token endpoint that never answers is a timeout, and the marker is clear after it', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    const endpoint = tokenEndpoint(neverAnswers, tokens('access-after'))
    await wire(stub, { endpoint })
    await runInDurableObject(stub, (o: ConnectionTokenObject) => { o.tokenTimeoutMs = 50 })
    const envelope = await sealFor(conn, 1, { ...APP, refresh_token: R1 })
    expect(await stub.accessToken(request(conn, 1, envelope))).toEqual({ ok: false, kind: 'unavailable', reason: 'token_endpoint_timeout', retryAtMs: null })
    await runInDurableObject(stub, (o: ConnectionTokenObject) => { expect(o.inFlightSince()).toBeNull() })
    expect(ok(await stub.accessToken(request(conn, 1, envelope))).token).toBe('access-after')
  })

  it('a waiter is answered the holder\'s failure, and still never calls the endpoint', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const endpoint = tokenEndpoint(async () => { await held; return Response.json({ error: 'invalid_grant' }, { status: 400 }) })
    await wire(stub, { endpoint })
    const envelope = await sealFor(conn, 1, { ...APP, refresh_token: R1 })
    const first = stub.accessToken(request(conn, 1, envelope))
    await expect.poll(() => endpoint.calls.length).toBe(1)
    const second = stub.accessToken(request(conn, 1, envelope))
    await untilWaiting(stub, 1)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toMatchObject({ ok: false, kind: 'refused', reason: 'invalid_grant' })
    expect(b).toMatchObject({ ok: false, kind: 'refused', reason: 'invalid_grant' })
    expect(endpoint.calls).toHaveLength(1)
  })

  it('a login that is not a person bound login is refused before anything is asked', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    const endpoint = tokenEndpoint(tokens('never'))
    await wire(stub, { endpoint })
    const envelope = await sealFor(conn, 1, { ...APP })
    expect(await stub.accessToken(request(conn, 1, envelope))).toMatchObject({ ok: false, kind: 'refused', reason: 'login_malformed' })
    expect(endpoint.calls).toEqual([])
  })

  it('a malformed request or one naming another organization is refused by name', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    const endpoint = tokenEndpoint(tokens('never'))
    await wire(stub, { endpoint })
    const envelope = await sealFor(conn, 1, { ...APP, refresh_token: R1 })
    expect(await stub.accessToken({ ...request(conn, 1, envelope), tokenUrl: 'http://oauth2.example.test/token' }))
      .toMatchObject({ ok: false, kind: 'token_object_unavailable', reason: 'token_object_refused' })
    // The AAD names ORG, so another organization's call cannot open it.
    expect(await stub.accessToken({ ...request(conn, 1, envelope), organizationId: '22222222-2222-4222-8222-222222222222' }))
      .toMatchObject({ ok: false, kind: 'token_object_unavailable' })
    expect(endpoint.calls).toEqual([])
  })
})

describe('a rotated refresh token is stored before the access token is returned', () => {
  it('a crash after the token call keeps the rotated token, and the next refresh spends it', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    const gw = gateway(new Error('the bidding Worker is down'))
    await wire(stub, { endpoint: tokenEndpoint(tokens('access-one', R2, 60)), gw })
    const envelope = await sealFor(conn, 1, { ...APP, refresh_token: R1 })
    const answer = ok(await stub.accessToken(request(conn, 1, envelope)))
    expect(answer.token).toBe('access-one')

    // Already in storage when the token came back: generation 2, pending, an alarm set.
    const kept = (await stored(stub))!
    expect(kept).toMatchObject({ organizationId: ORG, connectionId: conn, service: SERVICE, generation: 2, committedGeneration: 1, writeBack: 'pending' })
    expect(await openStored(conn, kept)).toEqual({ ...APP, refresh_token: R2 })
    expect(await alarmAt(stub)).toBe(T)
    // Nothing tried the write back yet: it is the alarm's.
    expect(gw.requests).toEqual([])

    // The crash: the object is evicted before any write back, losing everything in memory.
    await evictDurableObject(stub)
    const later = T + 5 * 60_000
    const endpoint = tokenEndpoint(tokens('access-two'))
    await wire(stub, { endpoint, gw, now: () => later })
    // The caller still holds the copy at generation 1, whose refresh token is now dead.
    expect(ok(await stub.accessToken(request(conn, 1, envelope))).token).toBe('access-two')
    expect(endpoint.calls).toEqual([{ grant: 'refresh_token', refresh: R2, code: null }])
  })

  it('a refresh that does not rotate stores nothing', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    await wire(stub, { endpoint: tokenEndpoint(tokens('access-one', R1)) })
    const envelope = await sealFor(conn, 1, { ...APP, refresh_token: R1 })
    ok(await stub.accessToken(request(conn, 1, envelope)))
    expect(await stored(stub)).toBeUndefined()
    expect(await alarmAt(stub)).toBeNull()
  })

  it('a rotation it could not keep is never asked for: with no key to seal to, the endpoint is not called', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    const endpoint = tokenEndpoint(tokens('access-one', R2))
    await wire(stub, { endpoint })
    await runInDurableObject(stub, (o: ConnectionTokenObject) => {
      o.sealKeys = () => ({ privateKeys: keys.privateKeys, publicKeys: keys.publicKeys, kid: null })
    })
    const envelope = await sealFor(conn, 1, { ...APP, refresh_token: R1 })
    expect(await stub.accessToken(request(conn, 1, envelope))).toMatchObject({ ok: false, kind: 'token_object_unavailable', reason: 'token_object_failed' })
    expect(endpoint.calls).toEqual([])
  })
})

describe('the write back: a compare and set through OPS_GATEWAY.storeRotatedEnvelope, retried by the alarm', () => {
  async function rotated(gw: ReturnType<typeof gateway>) {
    const conn = connection()
    const stub = stubFor(conn)
    await wire(stub, { endpoint: tokenEndpoint(tokens('access-one', R2, 60), tokens('access-two', R3, 60)), gw })
    const envelope = await sealFor(conn, 1, { ...APP, refresh_token: R1 })
    ok(await stub.accessToken(request(conn, 1, envelope)))
    return { conn, stub, envelope }
  }

  it('sends the rotated envelope with the generation it last knew, and the row is authoritative again once it lands', async () => {
    const gw = gateway({ outcome: 'stored', current_generation: 2, current_iv: 'set-below' })
    const { conn, stub } = await rotated(gw)
    const pending = (await stored(stub))!
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(gw.requests).toEqual([{ organization_id: ORG, connection_id: conn, expected_generation: 1, generation: 2, envelope: pending.envelope }])
    expect((await stored(stub))!).toMatchObject({ generation: 2, committedGeneration: 2, writeBack: 'landed' })
    // Nothing left to send.
    expect(await alarmAt(stub)).toBeNull()
  })

  it('while bidding is down, keeps the login and retries later, backing off, until it lands', async () => {
    const gw = gateway(new Error('bidding is down'), new Error('bidding is down'), { outcome: 'stored', current_generation: 2, current_iv: 'x' })
    const { stub } = await rotated(gw)
    await runDurableObjectAlarm(stub)
    expect((await stored(stub))!).toMatchObject({ writeBack: 'pending', attempts: 1 })
    expect(await alarmAt(stub)).toBe(T + WRITE_BACK_RETRY_MIN_MS)
    await runDurableObjectAlarm(stub)
    expect((await stored(stub))!).toMatchObject({ writeBack: 'pending', attempts: 2 })
    expect(await alarmAt(stub)).toBe(T + 2 * WRITE_BACK_RETRY_MIN_MS)
    await runDurableObjectAlarm(stub)
    expect((await stored(stub))!).toMatchObject({ writeBack: 'landed', committedGeneration: 2, attempts: 0 })
    expect(gw.requests).toHaveLength(3)
    expect(WRITE_BACK_RETRY_MAX_MS).toBeGreaterThan(WRITE_BACK_RETRY_MIN_MS)
  })

  it('a binding that is missing, or an answer it cannot read, is retried the same way, never read as landed', async () => {
    const gw = gateway({ outcome: 'perhaps' } as unknown as StoreRotatedEnvelopeAnswer)
    const { stub } = await rotated(gw)
    await runDurableObjectAlarm(stub)
    expect((await stored(stub))!).toMatchObject({ writeBack: 'pending', attempts: 1 })
    await runInDurableObject(stub, (o: ConnectionTokenObject) => { o.gateway = () => undefined })
    await runDurableObjectAlarm(stub)
    expect((await stored(stub))!).toMatchObject({ writeBack: 'pending', attempts: 2 })
  })

  it('an earlier write whose answer was lost is recognised by its iv, and the newer login is sent on top of it', async () => {
    // The first send lands on bidding but its answer never comes back; then the
    // login rotates again; the next send (expecting generation 1) is answered
    // moved, naming generation 2 and the first send's iv.
    let firstIv = ''
    const gw = gateway(
      new Error('the answer was lost'),
      () => ({ outcome: 'moved', current_generation: 2, current_iv: firstIv }),
      { outcome: 'stored', current_generation: 3, current_iv: 'x' },
    )
    const { conn, stub, envelope } = await rotated(gw)
    firstIv = (await stored(stub))!.envelope.iv
    await runDurableObjectAlarm(stub)
    // The token expires, and the next refresh rotates again from R2.
    await runInDurableObject(stub, (o: ConnectionTokenObject) => { o.clock = () => T + 10 * 60_000 })
    ok(await stub.accessToken(request(conn, 1, envelope)))
    expect((await stored(stub))!).toMatchObject({ generation: 3, committedGeneration: 1, writeBack: 'pending' })
    await runDurableObjectAlarm(stub)
    // Recognised as its own: the row is at 2, so the next send expects 2.
    expect((await stored(stub))!).toMatchObject({ generation: 3, committedGeneration: 2, writeBack: 'pending' })
    await runDurableObjectAlarm(stub)
    expect(gw.requests.map((r) => [r.expected_generation, r.generation])).toEqual([[1, 2], [1, 3], [2, 3]])
    expect((await stored(stub))!).toMatchObject({ generation: 3, committedGeneration: 3, writeBack: 'landed' })
    expect(await openStored(conn, (await stored(stub))!)).toEqual({ ...APP, refresh_token: R3 })
  })

  it.each([
    ['moved by somebody else (a Reconnect)', { outcome: 'moved', current_generation: 2, current_iv: 'a-reconnect-iv' } as const],
    ['not_found (the connection was removed)', { outcome: 'not_found', current_generation: null, current_iv: null } as const],
  ])('gives its login up when the row was %s, and the copy is the authority again', async (_what, answer) => {
    const gw = gateway(answer)
    const { conn, stub } = await rotated(gw)
    await runDurableObjectAlarm(stub)
    expect(await stored(stub)).toBeUndefined()
    // The next call is answered from the copy the caller holds, not from the given up login.
    const reconnected = await sealFor(conn, 2, { ...APP, refresh_token: 'refresh-token-after-reconnect' })
    const endpoint = tokenEndpoint(tokens('access-after-reconnect'))
    await wire(stub, { endpoint, gw })
    expect(ok(await stub.accessToken(request(conn, 2, reconnected))).token).toBe('access-after-reconnect')
    expect(endpoint.calls).toEqual([{ grant: 'refresh_token', refresh: 'refresh-token-after-reconnect', code: null }])
  })

  it('gives its login up when the copy it is handed is ahead of it, so a Reconnect wins without waiting for the write back', async () => {
    const gw = gateway(new Error('bidding is down'))
    const { conn, stub } = await rotated(gw)
    const reconnected = await sealFor(conn, 2, { ...APP, refresh_token: 'refresh-token-after-reconnect' })
    const endpoint = tokenEndpoint(tokens('access-after-reconnect'))
    await wire(stub, { endpoint, gw })
    // Generation 2 on both sides, different envelopes: the row took a Reconnect, not this object's login.
    expect(ok(await stub.accessToken(request(conn, 2, reconnected))).token).toBe('access-after-reconnect')
    expect(endpoint.calls[0].refresh).toBe('refresh-token-after-reconnect')
    expect(await stored(stub)).toBeUndefined()
  })
})

describe('exchangeOAuthCode inside the object', () => {
  const VERIFIER = 'v'.repeat(43)

  function exchange(conn: string, generation: number, envelope: SealedEnvelope, code = 'auth-code-2335') {
    return { organizationId: ORG, connectionId: conn, service: SERVICE, generation, envelope, tokenUrl: TOKEN_URL, code, verifier: VERIFIER, redirectUri: 'https://bidspoke.trypennie.dev/oauth/callback' }
  }

  it('stores the new login with its refresh token before it answers, answers only a generation, and serves the token it got', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    const endpoint = tokenEndpoint(tokens('access-from-consent', R1))
    const gw = gateway({ outcome: 'stored', current_generation: 2, current_iv: 'x' })
    await wire(stub, { endpoint, gw })
    // The row holds the app's login alone, at generation 1, before the consent.
    const app = await sealFor(conn, 1, APP)
    const answer: ExchangeAnswer = await stub.exchange(exchange(conn, 1, app))
    expect(answer).toEqual({ ok: true, generation: 2 })
    expect(JSON.stringify(answer)).not.toContain('access-from-consent')
    expect(endpoint.calls).toEqual([{ grant: 'authorization_code', refresh: null, code: 'auth-code-2335' }])
    const kept = (await stored(stub))!
    expect(kept).toMatchObject({ generation: 2, committedGeneration: 1, writeBack: 'pending' })
    expect(await openStored(conn, kept)).toEqual({ ...APP, refresh_token: R1 })
    expect(await alarmAt(stub)).toBe(T)
    // A step's first call, still on the copy at generation 1, is served the consent's token.
    expect(ok(await stub.accessToken(request(conn, 1, app)))).toMatchObject({ token: 'access-from-consent', minted: false })
    await runDurableObjectAlarm(stub)
    expect(gw.requests[0]).toMatchObject({ expected_generation: 1, generation: 2 })
  })

  it('a consent arriving during a rotating refresh waits for it, then seals above the generation the refresh stored', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const endpoint = tokenEndpoint(async () => { await held; return tokens('access-refresh', R2)() }, tokens('access-from-consent', R3))
    await wire(stub, { endpoint })
    const refreshing = stub.accessToken(request(conn, 1, await sealFor(conn, 1, { ...APP, refresh_token: R1 })))
    await expect.poll(() => endpoint.calls.length).toBe(1)
    const consent = stub.exchange(exchange(conn, 1, await sealFor(conn, 1, APP)))
    await untilWaiting(stub, 1)
    release()
    ok(await refreshing)
    // The refresh stored generation 2, so the consent, read after it, takes 3: never the same generation twice.
    expect(await consent).toEqual({ ok: true, generation: 3 })
    expect(endpoint.calls.map((c) => c.grant)).toEqual(['refresh_token', 'authorization_code'])
    const kept = (await stored(stub))!
    expect(kept).toMatchObject({ generation: 3, committedGeneration: 1, writeBack: 'pending' })
    expect(await openStored(conn, kept)).toEqual({ ...APP, refresh_token: R3 })
  })

  it('a consent answered with no refresh token is refused, and nothing is stored', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    await wire(stub, { endpoint: tokenEndpoint(tokens('access-from-consent')) })
    const answer = await stub.exchange(exchange(conn, 1, await sealFor(conn, 1, APP)))
    expect(answer).toEqual({ ok: false, kind: 'refused', reason: 'refresh_token_missing', retryAtMs: null })
    expect(await stored(stub)).toBeUndefined()
  })

  it('a refused code is answered by kind, and nothing is stored', async () => {
    const conn = connection()
    const stub = stubFor(conn)
    await wire(stub, { endpoint: tokenEndpoint(() => Response.json({ error: 'invalid_grant' }, { status: 400 })) })
    expect(await stub.exchange(exchange(conn, 1, await sealFor(conn, 1, APP)))).toMatchObject({ ok: false, kind: 'refused', reason: 'invalid_grant' })
    expect(await stored(stub)).toBeUndefined()
  })
})
