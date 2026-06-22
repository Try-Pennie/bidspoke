// JWT verification using Supabase JWKS (EC P-256) — PRD Section 2.7
// We cache the JWKS in module memory; Workers isolates reuse this across requests

import { parseJson } from './json'

interface JwkKey {
  kid: string
  kty: string
  crv: string
  x: string
  y: string
  alg: string
}

interface JwksResponse {
  keys: JwkKey[]
}

interface JwtPayload {
  sub: string
  email?: string
  exp: number
  iat: number
  aud: string | string[]
  [key: string]: unknown
}

let cachedKeys: Map<string, CryptoKey> | null = null
// When did we last refetch the JWKS because a token presented an unknown kid?
// Used to rate-limit refetches so a flood of bogus-kid tokens can't hammer the
// JWKS endpoint. 0 = never, so the first unknown kid always triggers a refetch.
let lastUnknownKidRefetchMs = 0
const UNKNOWN_KID_REFETCH_COOLDOWN_MS = 60_000

// Reset module-level JWKS state. Test-only.
export function _resetJwksCacheForTest(): void {
  cachedKeys = null
  lastUnknownKidRefetchMs = 0
}

async function getJwks(jwksUrl: string, forceRefresh = false): Promise<Map<string, CryptoKey>> {
  if (cachedKeys && !forceRefresh) return cachedKeys

  const res = await fetch(jwksUrl)
  if (!res.ok) throw new Error('Failed to fetch JWKS')
  const { keys } = await parseJson<JwksResponse>(res)

  const keyMap = new Map<string, CryptoKey>()
  for (const jwk of keys) {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    )
    keyMap.set(jwk.kid, key)
  }
  cachedKeys = keyMap
  return keyMap
}

export async function verifyJwt(
  token: string,
  jwksUrl: string,
  expectedAud = 'authenticated'
): Promise<JwtPayload> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT format')

  const [headerB64, payloadB64, signatureB64] = parts

  const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/'))) as { kid: string; alg: string }
  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))) as JwtPayload

  // A token with no (or a non-numeric) exp must NOT be trusted forever —
  // `undefined < now` is false, so the original check silently accepted it.
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('JWT expired or missing exp')
  }

  // Audience must match. Supabase user tokens carry aud 'authenticated'.
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!auds.includes(expectedAud)) {
    throw new Error('JWT aud mismatch')
  }

  let keys = await getJwks(jwksUrl)
  let key = keys.get(header.kid)
  if (!key) {
    // Unknown kid — Supabase likely rotated signing keys. Refetch the JWKS so
    // rotation self-heals instead of bricking auth until isolates recycle,
    // rate-limited so bogus kids can't hammer the endpoint.
    const now = Date.now()
    if (now - lastUnknownKidRefetchMs >= UNKNOWN_KID_REFETCH_COOLDOWN_MS) {
      lastUnknownKidRefetchMs = now
      keys = await getJwks(jwksUrl, true)
      key = keys.get(header.kid)
    }
    if (!key) throw new Error(`No key found for kid: ${header.kid}`)
  }

  const signatureBytes = Uint8Array.from(
    atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0)
  )
  const dataBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`)

  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signatureBytes,
    dataBytes
  )
  if (!valid) throw new Error('Invalid JWT signature')

  return payload
}
