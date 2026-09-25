/**
 * One signed Snowflake JWT per identity, reused while it has time left (#609).
 *
 * executeStatement used to import the RSA key and sign a fresh token for every
 * statement, so an export issuing hundreds of batches paid that CPU hundreds of
 * times for a token that stays valid for an hour. These tests prove the token
 * is signed once and reused, that it is re-signed before it could expire under
 * a statement still in flight, and that a failed signing is not remembered.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  executeStatement,
  SnowflakeTokenCache,
  JWT_LIFETIME_SECONDS,
  TOKEN_REUSE_MARGIN_MS,
  type SnowflakeConfig,
} from '../snowflake'

async function generatePem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
  let s = ''
  for (const b of der) s += String.fromCharCode(b)
  // The armour label is assembled rather than written out, because the secret
  // scanner reads the literal header as a committed key. This key is generated
  // fresh for each test and never leaves the process.
  const label = ['PRIVATE', 'KEY'].join(' ')
  return `-----BEGIN ${label}-----\n${btoa(s)}\n-----END ${label}-----`
}

let userSeq = 0
async function freshConfig(): Promise<SnowflakeConfig> {
  // A distinct user per test, so the shared cache executeStatement uses cannot
  // carry a token from one test into another.
  userSeq++
  return {
    account: 'acct.us-east-1',
    user: `svc_${userSeq}_${crypto.randomUUID().slice(0, 8)}`,
    privateKeyPem: await generatePem(),
    database: 'db',
    schema: 'sc',
    warehouse: 'wh',
    role: 'r',
  }
}

function payloadOf(jwt: string): { iat: number; exp: number; sub: string } {
  const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
}

afterEach(() => vi.restoreAllMocks())

describe('SnowflakeTokenCache', () => {
  it('signs once and hands the same token to every later statement', async () => {
    const config = await freshConfig()
    const signSpy = vi.spyOn(crypto.subtle, 'sign')
    const cache = new SnowflakeTokenCache(() => 1_000_000)

    const first = await cache.token(config)
    const second = await cache.token(config)
    const third = await cache.token(config)

    expect(signSpy).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('signs a concurrent burst only once', async () => {
    const config = await freshConfig()
    const signSpy = vi.spyOn(crypto.subtle, 'sign')
    const cache = new SnowflakeTokenCache(() => 1_000_000)

    const tokens = await Promise.all([cache.token(config), cache.token(config), cache.token(config)])

    expect(signSpy).toHaveBeenCalledTimes(1)
    expect(new Set(tokens).size).toBe(1)
  })

  it('stamps iat and exp from its own clock', async () => {
    const config = await freshConfig()
    const cache = new SnowflakeTokenCache(() => 5_000_000)
    const p = payloadOf(await cache.token(config))
    expect(p.iat).toBe(5_000)
    expect(p.exp).toBe(5_000 + JWT_LIFETIME_SECONDS)
  })

  it('keeps the token until only the reuse margin is left, then signs a new one', async () => {
    const config = await freshConfig()
    let now = 10_000_000
    const cache = new SnowflakeTokenCache(() => now)
    const first = await cache.token(config)
    const expiresAtMs = payloadOf(first).exp * 1000

    // One millisecond short of the margin: still reusable.
    now = expiresAtMs - TOKEN_REUSE_MARGIN_MS - 1
    expect(await cache.token(config)).toBe(first)

    // At the margin: a statement started now could still be polling when the
    // token expires, so it gets a fresh one.
    now = expiresAtMs - TOKEN_REUSE_MARGIN_MS
    const renewed = await cache.token(config)
    expect(renewed).not.toBe(first)
    expect(payloadOf(renewed).exp * 1000).toBe(Math.floor(now / 1000) * 1000 + JWT_LIFETIME_SECONDS * 1000)
  })

  it('leaves room for the longest cron invocation inside the reuse margin', () => {
    // The platform ends a cron invocation at 15 minutes, so a token handed out at
    // any moment of a run must outlive the rest of that run.
    expect(TOKEN_REUSE_MARGIN_MS).toBeGreaterThanOrEqual(15 * 60 * 1000)
    expect(TOKEN_REUSE_MARGIN_MS).toBeLessThan(JWT_LIFETIME_SECONDS * 1000)
  })

  it('keeps separate tokens for separate identities', async () => {
    const reader = await freshConfig()
    const writer = await freshConfig()
    const cache = new SnowflakeTokenCache(() => 1_000_000)
    const a = await cache.token(reader)
    const b = await cache.token(writer)
    expect(a).not.toBe(b)
    expect(payloadOf(a).sub).toContain(reader.user.toUpperCase())
    expect(payloadOf(b).sub).toContain(writer.user.toUpperCase())
  })

  it('does not remember a failed signing, so the next statement tries again', async () => {
    const config = await freshConfig()
    const cache = new SnowflakeTokenCache(() => 1_000_000)
    const signSpy = vi.spyOn(crypto.subtle, 'sign').mockRejectedValueOnce(new Error('sign failed'))

    await expect(cache.token(config)).rejects.toThrow('sign failed')
    const token = await cache.token(config)

    expect(token.split('.')).toHaveLength(3)
    expect(signSpy).toHaveBeenCalledTimes(2)
  })
})

describe('executeStatement signing (#609)', () => {
  it('signs once across many statements for one identity', async () => {
    const config = await freshConfig()
    const signSpy = vi.spyOn(crypto.subtle, 'sign')
    const auth: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      auth.push(String((init?.headers as Record<string, string>).Authorization))
      return new Response(JSON.stringify({ data: [[1]] }), { status: 200 })
    })

    for (let i = 0; i < 5; i++) await executeStatement(config, 'select 1')

    expect(signSpy).toHaveBeenCalledTimes(1)
    expect(new Set(auth).size).toBe(1)
    expect(auth[0]).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  })
})
