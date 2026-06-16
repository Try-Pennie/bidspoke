/**
 * verifyJwt — Supabase JWKS verification (#102).
 *
 * Guards: reject expired AND missing-exp tokens, validate aud, and refetch the
 * JWKS (rate-limited) when a token presents an unknown kid so signing-key
 * rotation self-heals instead of bricking auth.
 *
 * Tokens are signed with a real EC P-256 key generated per test, and fetch is
 * stubbed to serve the matching JWKS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { verifyJwt, _resetJwksCacheForTest } from '../jwt'

const JWKS_URL = 'https://fake.supabase/jwks'
const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlJson(obj: unknown): string {
  return b64url(enc.encode(JSON.stringify(obj)))
}

async function makeKey(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: 'ES256', use: 'sig' } }
}

async function signJwt(privateKey: CryptoKey, kid: string, payload: Record<string, unknown>): Promise<string> {
  const header = b64urlJson({ alg: 'ES256', typ: 'JWT', kid })
  const body = b64urlJson(payload)
  const data = `${header}.${body}`
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(data))
  return `${data}.${b64url(new Uint8Array(sig))}`
}

function jwksResponse(jwks: unknown[]) {
  // A fresh Response per call — a Response body can only be read once, so the
  // refetch-on-unknown-kid path needs a new one each fetch.
  return () => Promise.resolve(new Response(JSON.stringify({ keys: jwks }), { status: 200 }))
}
function stubJwks(...jwks: unknown[]) {
  const fetchMock = vi.fn().mockImplementation(jwksResponse(jwks))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const future = () => Math.floor(Date.now() / 1000) + 3600
const past = () => Math.floor(Date.now() / 1000) - 3600
const claims = (over: Record<string, unknown> = {}) => ({ sub: 'u1', aud: 'authenticated', exp: future(), iat: Math.floor(Date.now() / 1000), ...over })

beforeEach(() => {
  _resetJwksCacheForTest()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('verifyJwt (#102)', () => {
  it('verifies a valid token', async () => {
    const { privateKey, jwk } = await makeKey('k1')
    stubJwks(jwk)
    const token = await signJwt(privateKey, 'k1', claims())
    const payload = await verifyJwt(token, JWKS_URL)
    expect(payload.sub).toBe('u1')
  })

  it('rejects an expired token', async () => {
    const { privateKey, jwk } = await makeKey('k1')
    stubJwks(jwk)
    const token = await signJwt(privateKey, 'k1', claims({ exp: past() }))
    await expect(verifyJwt(token, JWKS_URL)).rejects.toThrow(/expired/)
  })

  it('rejects a token with no exp (the original bug)', async () => {
    const { privateKey, jwk } = await makeKey('k1')
    stubJwks(jwk)
    const c = claims() as Record<string, unknown>
    delete c.exp
    const token = await signJwt(privateKey, 'k1', c)
    await expect(verifyJwt(token, JWKS_URL)).rejects.toThrow(/exp/)
  })

  it('rejects a token whose aud does not match', async () => {
    const { privateKey, jwk } = await makeKey('k1')
    stubJwks(jwk)
    const token = await signJwt(privateKey, 'k1', claims({ aud: 'some-other-service' }))
    await expect(verifyJwt(token, JWKS_URL)).rejects.toThrow(/aud/)
  })

  it('accepts when aud is an array containing the expected value', async () => {
    const { privateKey, jwk } = await makeKey('k1')
    stubJwks(jwk)
    const token = await signJwt(privateKey, 'k1', claims({ aud: ['authenticated', 'other'] }))
    const payload = await verifyJwt(token, JWKS_URL)
    expect(payload.sub).toBe('u1')
  })

  it('rejects a token with a tampered signature', async () => {
    const { privateKey, jwk } = await makeKey('k1')
    stubJwks(jwk)
    const token = await signJwt(privateKey, 'k1', claims())
    const tampered = token.slice(0, -4) + 'AAAA'
    await expect(verifyJwt(tampered, JWKS_URL)).rejects.toThrow(/signature|Invalid/)
  })

  it('refetches the JWKS when a token presents an unknown kid (rotation self-heals)', async () => {
    // Isolate warmed with the OLD key.
    const oldKey = await makeKey('old')
    const fetchMock = stubJwks(oldKey.jwk)
    await verifyJwt(await signJwt(oldKey.privateKey, 'old', claims()), JWKS_URL)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Rotation: a NEW key signs the token, and the JWKS now serves it.
    const newKey = await makeKey('new')
    fetchMock.mockImplementation(jwksResponse([newKey.jwk]))
    const payload = await verifyJwt(await signJwt(newKey.privateKey, 'new', claims()), JWKS_URL)
    expect(payload.sub).toBe('u1')
    expect(fetchMock).toHaveBeenCalledTimes(2) // refetched on the unknown kid
  })

  it('rate-limits refetches so repeated unknown kids do not hammer the JWKS endpoint', async () => {
    const oldKey = await makeKey('old')
    const fetchMock = stubJwks(oldKey.jwk)
    await verifyJwt(await signJwt(oldKey.privateKey, 'old', claims()), JWKS_URL) // 1 fetch, warms cache

    // Two tokens with an unknown kid the JWKS never serves. First triggers a
    // refetch; the second is within the cooldown and must NOT refetch again.
    const ghost = await makeKey('ghost')
    const t = await signJwt(ghost.privateKey, 'ghost', claims())
    await expect(verifyJwt(t, JWKS_URL)).rejects.toThrow(/No key/)
    await expect(verifyJwt(t, JWKS_URL)).rejects.toThrow(/No key/)
    expect(fetchMock).toHaveBeenCalledTimes(2) // initial + one refetch, not two
  })
})
