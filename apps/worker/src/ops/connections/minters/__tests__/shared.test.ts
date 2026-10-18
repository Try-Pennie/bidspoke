import { describe, expect, it } from 'vitest'
import { TokenMemo } from '../../../../lib/token-memo'
import { LoginMintError } from '../../refusals'
import type { Authorization, AuthorizeInput } from '../../service-rules'
import { authorizeThroughMemo } from '../memo-authorize'
import { TOKEN_ENDPOINT_TIMEOUT_MS, readAccessToken, requestToken } from '../token-endpoint'
import { tokenEndpoint } from './minter-harness'

/**
 * What every minter that mints shares (#2335): the per isolate memo, keyed so
 * two identities never share a token, and the token endpoint request with its
 * one classification of failures (Dan's decision 2).
 */

const T0 = Date.parse('2026-10-18T09:00:00.000Z')
const ORG = '11111111-1111-4111-8111-111111111111' as AuthorizeInput['organizationId']

function input(overrides: Partial<AuthorizeInput> = {}): AuthorizeInput & { mints: number } {
  const counted = { mints: 0 }
  return Object.assign(counted, {
    organizationId: ORG,
    connectionId: '33333333-3333-4333-8333-333333333333',
    service: 'example',
    generation: 1,
    target: {},
    publicConfig: {},
    login: { plaintext: '{}' },
    candidate: false,
    renew: null,
    noteMint: () => { counted.mints += 1 },
    ...overrides,
  })
}

const auth = (token: string): Authorization => ({ headers: { authorization: `Bearer ${token}` }, secrets: [token] })
const KEY = { connectionId: 'c', generation: 1, sub: '', scope: '' }

describe('authorizeThroughMemo', () => {
  it('mints once and reuses the same Authorization while it has life, noting only the real mint', async () => {
    const memo = new TokenMemo<Authorization>({ now: () => T0, reuseMarginMs: 1000 })
    let n = 0
    const mint = async (at: number) => ({ value: auth(`token-${++n}`), expiresAtMs: at + 60_000 })
    const first = input()
    const a = await authorizeThroughMemo(memo, KEY, first, mint, { asksTokenEndpoint: true, now: () => T0 })
    const second = input()
    const b = await authorizeThroughMemo(memo, KEY, second, mint, { asksTokenEndpoint: true, now: () => T0 })
    expect(b).toBe(a)
    expect(n).toBe(1)
    expect([first.mints, second.mints]).toEqual([1, 0])
  })

  it('a renewal evicts only the token that was rejected, compared by identity, and mints once', async () => {
    const memo = new TokenMemo<Authorization>({ now: () => T0, reuseMarginMs: 1000 })
    let n = 0
    const mint = async (at: number) => ({ value: auth(`token-${++n}`), expiresAtMs: at + 60_000 })
    const old = await authorizeThroughMemo(memo, KEY, input(), mint, { asksTokenEndpoint: true, now: () => T0 })
    const fresh = await authorizeThroughMemo(memo, KEY, input({ renew: { rejected: old } }), mint, { asksTokenEndpoint: true, now: () => T0 })
    expect(fresh).not.toBe(old)
    expect(n).toBe(2)
    // A second caller rejected with the same old token finds the fresh one: no third mint.
    const late = await authorizeThroughMemo(memo, KEY, input({ renew: { rejected: old } }), mint, { asksTokenEndpoint: true, now: () => T0 })
    expect(late).toBe(fresh)
    expect(n).toBe(2)
    // An equal but different object is not the held token, so it evicts nothing.
    const lookalike = { ...fresh }
    expect(await authorizeThroughMemo(memo, KEY, input({ renew: { rejected: lookalike } }), mint, { asksTokenEndpoint: true, now: () => T0 })).toBe(fresh)
    expect(n).toBe(2)
  })

  it('a candidate never reads or fills the memo: it mints for its one call', async () => {
    const memo = new TokenMemo<Authorization>({ now: () => T0, reuseMarginMs: 1000 })
    let n = 0
    const mint = async (at: number) => ({ value: auth(`token-${++n}`), expiresAtMs: at + 60_000 })
    const committed = await authorizeThroughMemo(memo, KEY, input(), mint, { asksTokenEndpoint: true, now: () => T0 })
    const candidate = await authorizeThroughMemo(memo, KEY, input({ candidate: true }), mint, { asksTokenEndpoint: true, now: () => T0 })
    expect(candidate).not.toBe(committed)
    expect(await authorizeThroughMemo(memo, KEY, input(), mint, { asksTokenEndpoint: true, now: () => T0 })).toBe(committed)
    expect(memo.size).toBe(1)
  })

  it('a token past its life less the margin is minted again (the expired token case)', async () => {
    const now = { value: T0 }
    const memo = new TokenMemo<Authorization>({ now: () => now.value, reuseMarginMs: 1000 })
    let n = 0
    const mint = async (at: number) => ({ value: auth(`token-${++n}`), expiresAtMs: at + 60_000 })
    const a = await authorizeThroughMemo(memo, KEY, input(), mint, { asksTokenEndpoint: true, now: () => T0 })
    now.value = T0 + 59_500
    const b = await authorizeThroughMemo(memo, KEY, input(), mint, { asksTokenEndpoint: true, now: () => T0 })
    expect(b).not.toBe(a)
    expect(n).toBe(2)
  })

  it('a signing that asks no token endpoint never notes a mint, so it never writes a refresh streak', async () => {
    const memo = new TokenMemo<Authorization>({ now: () => T0, reuseMarginMs: 1000 })
    const one = input()
    await authorizeThroughMemo(memo, KEY, one, async (at) => ({ value: auth('signed-locally'), expiresAtMs: at + 60_000 }), { asksTokenEndpoint: false, now: () => T0 })
    expect(one.mints).toBe(0)
  })

  it('a failed mint is not remembered: the next call mints again', async () => {
    const memo = new TokenMemo<Authorization>({ now: () => T0, reuseMarginMs: 1000 })
    const failing = async () => { throw new LoginMintError('unavailable', 'token_endpoint_5xx') }
    await expect(authorizeThroughMemo(memo, KEY, input(), failing, { asksTokenEndpoint: true, now: () => T0 })).rejects.toMatchObject({ kind: 'unavailable' })
    expect(memo.size).toBe(0)
  })
})

describe('requestToken: one classification of a token endpoint\'s answer', () => {
  const deps = (endpoint: ReturnType<typeof tokenEndpoint>, timeoutMs?: number) => ({ fetch: endpoint.fetch, now: () => T0, tokenTimeoutMs: timeoutMs })
  const body = () => new URLSearchParams({ grant_type: 'client_credentials' })

  async function failure(promise: Promise<unknown>): Promise<LoginMintError> {
    try {
      await promise
    } catch (err) {
      if (err instanceof LoginMintError) return err
      throw new Error(`expected a LoginMintError, got ${String(err)}`, { cause: err })
    }
    throw new Error('expected a LoginMintError, and the request answered')
  }

  it('posts a form, follows no redirect, and answers the parsed body', async () => {
    const endpoint = tokenEndpoint(Response.json({ access_token: 'abc-token-123', expires_in: 3599 }))
    const json = await requestToken(deps(endpoint), 'https://login.example.test/token', body())
    expect(readAccessToken(json)).toBe('abc-token-123')
    expect(endpoint.calls[0]).toMatchObject({ method: 'POST', redirect: 'manual' })
    expect(endpoint.calls[0].headers.get('content-type')).toBe('application/x-www-form-urlencoded')
  })

  it.each([
    [400, { error: 'invalid_grant' }, 'invalid_grant'],
    [400, { error: 'invalid_client_id' }, 'invalid_client'],
    [401, { error: 'invalid_client' }, 'invalid_client'],
    [401, { error: 'unauthorized_client' }, 'unauthorized_client'],
    [400, { error: 'invalid_scope' }, 'invalid_scope'],
    [403, { error: 'access_denied' }, 'access_denied'],
    [400, { error: 'something new' }, 'login_refused'],
    [400, { error: 'constructor' }, 'login_refused'],
    [404, 'not found', 'login_refused'],
    // A token endpoint that redirects is the wrong address: a person must correct the connection.
    [302, '', 'token_endpoint_redirected'],
  ] as const)('a %i with %j is a refused login: %s', async (status, answer, reason) => {
    const endpoint = tokenEndpoint(typeof answer === 'string' ? new Response(answer, { status }) : Response.json(answer, { status }))
    const err = await failure(requestToken(deps(endpoint), 'https://login.example.test/token', body()))
    expect([err.kind, err.reason]).toEqual(['refused', reason])
  })

  it.each([
    [new Response('upstream', { status: 503 }), 'token_endpoint_5xx'],
    [new Response('boom', { status: 500 }), 'token_endpoint_5xx'],
    [new Response('<!DOCTYPE html><html><body>Edge error</body></html>', { status: 400 }), 'token_endpoint_edge_page'],
    [new TypeError('fetch failed'), 'token_endpoint_unreachable'],
    [Response.json({ token_type: 'Bearer' }), 'token_response_malformed'],
    [new Response('not json', { status: 200 }), 'token_response_malformed'],
  ] as const)('%# is unavailable: %s', async (answer, reason) => {
    const endpoint = tokenEndpoint(answer)
    const err = await failure(requestToken(deps(endpoint), 'https://login.example.test/token', body()).then(readAccessToken))
    expect([err.kind, err.reason]).toEqual(['unavailable', reason])
  })

  it('a token endpoint that never answers is unavailable at its own timeout', async () => {
    const endpoint = tokenEndpoint('hang')
    const err = await failure(requestToken(deps(endpoint, 10), 'https://login.example.test/token', body()))
    expect([err.kind, err.reason]).toEqual(['unavailable', 'token_endpoint_timeout'])
  })

  it('states a timeout inside connectionFetch\'s whole deadline', () => {
    expect(TOKEN_ENDPOINT_TIMEOUT_MS).toBe(10_000)
  })

  it('a 429 is rate limited at its Retry-After, or with no time when it gives none', async () => {
    const at = await failure(requestToken(deps(tokenEndpoint(new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }))), 'https://login.example.test/token', body()))
    expect([at.kind, at.reason, at.retryAt?.getTime()]).toEqual(['rate_limited', 'token_endpoint_rate_limited', T0 + 30_000])
    const none = await failure(requestToken(deps(tokenEndpoint(new Response('slow down', { status: 429 }))), 'https://login.example.test/token', body()))
    expect([none.kind, none.retryAt]).toEqual(['rate_limited', null])
  })

  it('nothing the token endpoint said, nor the request body, rides out on the error (F120)', async () => {
    const secret = 'canary-client-secret-0a1b2c3d'
    const endpoint = tokenEndpoint(Response.json({ error: 'invalid_client', error_description: `bad secret ${secret}` }, { status: 401 }))
    const err = await failure(requestToken(deps(endpoint), 'https://login.example.test/token', new URLSearchParams({ client_secret: secret })))
    expect(`${err.name} ${err.message} ${err.stack} ${JSON.stringify(err)}`).not.toContain(secret)
    expect(err.message).toBe('refused: invalid_client')
  })
})
