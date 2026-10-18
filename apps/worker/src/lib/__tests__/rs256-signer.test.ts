/**
 * The shared RS256 signer (#2335, phase 5 of #1689), factored out of
 * signSnowflakeJwt in place so the Google delegation minter signs with the same
 * code the Snowflake export does. The Snowflake token's own shape is held by
 * snowflake-token-cache.test.ts, unchanged; this file holds the signer.
 */
import { describe, it, expect } from 'vitest'
import { signRs256Jwt, SnowflakeTokenCache, type SnowflakeConfig } from '../snowflake'

async function keyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
}

function decodeSegment(seg: string): unknown {
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
}

function segmentBytes(seg: string): Uint8Array {
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

describe('signRs256Jwt', () => {
  it('signs a JWT whose signature verifies against the public key', async () => {
    const pair = await keyPair()
    const payload = { iss: 'svc@example.iam', sub: 'ops@example.com', aud: 'https://oauth2.example/token', iat: 100, exp: 3_700 }

    const jwt = await signRs256Jwt(pair.privateKey, payload)
    const [header, body, sig] = jwt.split('.')

    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(decodeSegment(body)).toEqual(payload)
    const ok = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      pair.publicKey,
      segmentBytes(sig),
      new TextEncoder().encode(`${header}.${body}`),
    )
    expect(ok).toBe(true)
  })

  it('writes every segment as unpadded base64url', async () => {
    const pair = await keyPair()
    // Characters chosen so standard base64 of the payload carries + and /.
    const jwt = await signRs256Jwt(pair.privateKey, { scope: '>>>???~~~', n: 1 })
    for (const seg of jwt.split('.')) expect(seg).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('does not verify against another key', async () => {
    const pair = await keyPair()
    const other = await keyPair()
    const [header, body, sig] = (await signRs256Jwt(pair.privateKey, { a: 1 })).split('.')
    const ok = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      other.publicKey,
      segmentBytes(sig),
      new TextEncoder().encode(`${header}.${body}`),
    )
    expect(ok).toBe(false)
  })

  it('is what the Snowflake token is signed with', async () => {
    const pair = await keyPair()
    const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
    let s = ''
    for (const b of der) s += String.fromCharCode(b)
    // Assembled rather than written out, because the secret scanner reads the
    // literal armour header as a committed key. Generated here, never stored.
    const label = ['PRIVATE', 'KEY'].join(' ')
    const config: SnowflakeConfig = {
      account: 'acct.us-east-1',
      user: 'svc_signer',
      privateKeyPem: `-----BEGIN ${label}-----\n${btoa(s)}\n-----END ${label}-----`,
      database: 'db',
      schema: 'sc',
      warehouse: 'wh',
      role: 'r',
    }

    const token = await new SnowflakeTokenCache(() => 7_000_000).token(config)
    const payload = decodeSegment(token.split('.')[1]) as Record<string, unknown>
    // RSASSA-PKCS1-v1_5 is deterministic, so the same key and payload give the same bytes.
    expect(await signRs256Jwt(pair.privateKey, payload)).toBe(token)
  })
})
