import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { JWT_LIFETIME_SECONDS } from '../../../../lib/snowflake'
import { connectionFetch, type ConnectionCall } from '../../connection-fetch'
import { ConnectionRefusal, RequeueAt } from '../../refusals'
import { CONN, ORG, T0, makeDoubles, makeKeys, sealLogin, usableCopy, type Recorder, type TestKeys } from '../../__tests__/harness'
import { SNOWFLAKE_REUSE_MARGIN_MS, snowflakeKeyPairAuth } from '../snowflake'
import { makeSigningKey, readJwt, rulesOf, type SigningKey } from './minter-harness'
import { toPem } from '../../../__tests__/ops-key-fixture'

/**
 * The Snowflake key pair minter (#2335, PR 4 of phase 5): a JWT signed with the
 * connection's own private key, for the account and user its target declares,
 * by the same signer the export path uses (lib/snowflake.ts signSnowflakeJwt).
 * There is no token endpoint, so a refused login is Snowflake refusing the JWT
 * on the request, and a timeout is the request's own.
 */

const TARGET = { account: 'ab12345.us-east-1', user: 'ops_reader' }
const URL_ = 'https://ab12345.us-east-1.snowflakecomputing.com/api/v2/statements'
const JWT_REFUSED = () => Response.json({ code: '390144', message: 'JWT token is invalid.' }, { status: 401 })

let keys: TestKeys
let signing: SigningKey
let envelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  signing = await makeSigningKey()
  envelope = await sealLogin(keys, { service: 'snowflake', plaintext: JSON.stringify({ private_key: signing.pem }) })
}, 120_000)

function setup(opts: { login?: SealedEnvelope; target?: unknown } = {}) {
  let now = T0
  const auth = snowflakeKeyPairAuth({ now: () => now })
  const d = makeDoubles(keys, usableCopy(opts.login ?? envelope, { service: 'snowflake', target: opts.target ?? TARGET }), () => [
    rulesOf('snowflake', auth, () => ['ab12345.us-east-1.snowflakecomputing.com']),
  ])
  return { d, advance: (ms: number) => { now += ms; d.now.value = now } }
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

const sentHeaders = (d: ReturnType<typeof setup>['d'], i: number) => new Headers(d.rec.sent[i].init.headers)
const jwtOf = (d: ReturnType<typeof setup>['d'], i: number) => sentHeaders(d, i).get('authorization')!.replace(/^Bearer /, '')

describe('the Snowflake minter: a key pair JWT for the declared account and user', () => {
  it('signs a JWT Snowflake accepts: RS256 under the connection\'s key, for ACCOUNT.USER, valid for an hour', async () => {
    const { d } = setup()
    const res = await connectionFetch(d.deps, call(d.rec), URL_, { method: 'POST', body: '{"statement":"SELECT 1"}' })
    expect((res as Response).status).toBe(200)
    expect(sentHeaders(d, 0).get('x-snowflake-authorization-token-type')).toBe('KEYPAIR_JWT')
    const jwt = await readJwt(jwtOf(d, 0), signing.publicKey)
    expect(jwt.verified).toBe(true)
    expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(jwt.payload.sub).toBe('AB12345.OPS_READER')
    expect(String(jwt.payload.iss)).toMatch(/^AB12345\.OPS_READER\.SHA256:[A-Za-z0-9+/]+=*$/)
    expect(jwt.payload.iat).toBe(T0 / 1000)
    expect(jwt.payload.exp).toBe(T0 / 1000 + JWT_LIFETIME_SECONDS)
  })

  it('reuses the JWT, and signs again once it is within the margin of expiring (the expired token)', async () => {
    const { d, advance } = setup()
    await connectionFetch(d.deps, call(d.rec), URL_)
    await connectionFetch(d.deps, call(d.rec), URL_)
    expect(jwtOf(d, 1)).toBe(jwtOf(d, 0))
    advance(JWT_LIFETIME_SECONDS * 1000 - SNOWFLAKE_REUSE_MARGIN_MS)
    await connectionFetch(d.deps, call(d.rec), URL_)
    expect(jwtOf(d, 2)).not.toBe(jwtOf(d, 0))
  })

  it('signs locally, so it never touches the refresh streak', async () => {
    const { d } = setup()
    await connectionFetch(d.deps, call(d.rec), URL_)
    expect(d.rec.refreshes).toEqual([])
  })

  it('a JWT Snowflake refuses is signed once more and retried once; refused again it is needs_reauth (the refused login)', async () => {
    const { d, advance } = setup()
    d.respond(JWT_REFUSED())
    advance(1000)
    const err = await refusal(connectionFetch(d.deps, call(d.rec), URL_))
    expect(err.code).toBe('connection_needs_reauth')
    expect(d.rec.sent).toHaveLength(2)
    expect(d.rec.needsReauth).toEqual([{ organizationId: ORG, connectionId: CONN, cause: 'request_refused_after_renew' }])
  })

  it('a JWT that expired at Snowflake renews once, and the retry succeeds with a newly signed one', async () => {
    const { d, advance } = setup()
    await connectionFetch(d.deps, call(d.rec), URL_)
    advance(1000)
    d.respond(Response.json({ code: '390318', message: 'JWT token has expired.' }, { status: 401 }), new Response('{}', { status: 200 }))
    expect(((await connectionFetch(d.deps, call(d.rec), URL_)) as Response).status).toBe(200)
    expect(jwtOf(d, 2)).not.toBe(jwtOf(d, 1))
    expect(d.rec.needsReauth).toEqual([])
  })

  it('a private key that does not import is a malformed login: needs_reauth at once, nothing sent', async () => {
    const broken = await sealLogin(keys, { service: 'snowflake', plaintext: JSON.stringify({ private_key: toPem(new TextEncoder().encode('not a key').buffer as ArrayBuffer, 'PRIVATE KEY') }) })
    const { d } = setup({ login: broken })
    expect((await refusal(connectionFetch(d.deps, call(d.rec), URL_))).code).toBe('connection_needs_reauth')
    expect(d.rec.needsReauth[0].cause).toBe('login_refused: login_malformed')
    expect(d.rec.sent).toEqual([])
  })

  it('a request that never answers is refused at connectionFetch\'s deadline (the timeout)', async () => {
    const { d } = setup()
    d.deps.deadlineMs = 20
    d.deps.fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
    expect((await refusal(connectionFetch(d.deps, call(d.rec), URL_))).code).toBe('connection_timeout')
  })

  it('a 429 is a RequeueAt, never a sleep', async () => {
    const { d } = setup()
    d.respond(new Response('Too many requests', { status: 429, headers: { 'retry-after': '5' } }))
    const res = await connectionFetch(d.deps, call(d.rec), URL_)
    expect(res).toBeInstanceOf(RequeueAt)
    expect((res as RequeueAt).notBefore.getTime()).toBe(T0 + 5000)
    expect(d.rec.slept).toEqual([])
  })

  it('a target that does not name its account and user is refused by rule', async () => {
    const { d } = setup({ target: { account: 'ab12345.us-east-1' } })
    const err = await refusal(connectionFetch(d.deps, call(d.rec), URL_))
    expect(err.code).toBe('connection_not_allowed')
    expect(err.message).toContain('target_invalid')
    expect(d.rec.needsReauth).toEqual([])
  })
})
