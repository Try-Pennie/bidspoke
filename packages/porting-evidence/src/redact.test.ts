import { describe, expect, it } from 'vitest'
import { redactCapture } from './redact.ts'

const KEY = 'ab'.repeat(32)
const OTHER_KEY = 'cd'.repeat(32)

describe('redactCapture: dropped fields', () => {
  it.each(['Authorization', 'authorization', 'X-API-Key', 'x-api-key', 'Cookie', 'set-cookie', 'Proxy-Authorization'])(
    'drops %s entirely and counts it',
    async (name) => {
      const { value, redactedCount } = await redactCapture({ headers: { [name]: 'Bearer abc', accept: 'json' } }, KEY)
      expect(value).toEqual({ headers: { accept: 'json' } })
      expect(redactedCount).toBe(1)
    },
  )
})

describe('redactCapture: credential names', () => {
  it.each(['password', 'client_secret', 'clientSecret', 'api_key', 'apiKey', 'access_token', 'refresh_token', 'private_key', 'secret'])(
    'replaces the value of %s with a keyed hash of the same length and prefix',
    async (name) => {
      const secret = 'at_9f8e7d6c5b4a39281706'
      const { value, redactedCount } = await redactCapture({ [name]: secret }, KEY)
      const out = (value as Record<string, string>)[name]
      expect(out).not.toBe(secret)
      expect(out.length).toBe(secret.length)
      expect(out.startsWith('at_')).toBe(true)
      expect(out).not.toContain('9f8e7d6c')
      expect(redactedCount).toBe(1)
    },
  )

  it('hashes the same value the same way, so two halves of a comparison still match', async () => {
    const a = await redactCapture({ password: 'hunter2hunter2' }, KEY)
    const b = await redactCapture({ nested: [{ password: 'hunter2hunter2' }] }, KEY)
    expect((a.value as { password: string }).password).toBe(
      (b.value as { nested: Array<{ password: string }> }).nested[0].password,
    )
  })

  it('hashes under the key, so the replacement cannot be recomputed without it', async () => {
    const a = await redactCapture({ password: 'hunter2hunter2' }, KEY)
    const b = await redactCapture({ password: 'hunter2hunter2' }, OTHER_KEY)
    expect(a.value).not.toEqual(b.value)
  })

  it('hashes non string credential values too, rather than leaking a numeric pin', async () => {
    const { value, redactedCount } = await redactCapture({ pin: 1234, password: 987654 }, KEY)
    expect((value as { password: string }).password).not.toBe(987654)
    expect(String((value as { password: string }).password)).toHaveLength(6)
    expect(redactedCount).toBe(1)
  })
})

describe('redactCapture: credential shapes anywhere', () => {
  it.each([
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['a bearer header value', 'Bearer 8a7b6c5d4e3f2a1b0c9d8e7f'],
    ['a Stripe live key', 'sk_live_51HaBcDeFgHiJkLmNoPqRsTuV'],
    ['a Slack token', 'xoxb-1234567890-0987654321-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['a GitHub token', 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'],
    ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ])('replaces %s under an innocent field name', async (_label, secret) => {
    const { value, redactedCount } = await redactCapture({ note: secret }, KEY)
    const out = (value as { note: string }).note
    expect(out).not.toBe(secret)
    expect(out.length).toBe(secret.length)
    expect(out.slice(0, 3)).toBe(secret.slice(0, 3))
    expect(redactedCount).toBe(1)
  })
})

describe('redactCapture: the ambiguous name token', () => {
  it('preserves a real non credential field named token', async () => {
    const input = { token: 'promo-spring-2026', body: { token: 42 } }
    const { value, redactedCount } = await redactCapture(input, KEY)
    expect(value).toEqual(input)
    expect(redactedCount).toBe(0)
  })

  it('still replaces a token field whose value is credential shaped', async () => {
    const secret = '4f1c2a9b8d7e6f5a4b3c2d1e0f9a8b7c'
    const { value, redactedCount } = await redactCapture({ token: secret }, KEY)
    expect((value as { token: string }).token).not.toBe(secret)
    expect(redactedCount).toBe(1)
  })
})

describe('redactCapture: leaves ordinary data alone', () => {
  it('keeps structure, numbers, booleans and nulls', async () => {
    const input = { lead: { first_name: 'Ann', amount: 25000, opted_in: true, middle: null, list: [1, 'two'] } }
    const { value, redactedCount } = await redactCapture(input, KEY)
    expect(value).toEqual(input)
    expect(redactedCount).toBe(0)
  })

  it('does not mutate its input', async () => {
    const input = { password: 'hunter2hunter2', headers: { cookie: 'a=b' } }
    const copy = structuredClone(input)
    await redactCapture(input, KEY)
    expect(input).toEqual(copy)
  })

  it('counts every replacement across a nested document', async () => {
    const { redactedCount } = await redactCapture(
      { a: { password: 'x1x1x1x1' }, b: [{ api_key: 'k1k1k1k1' }, { headers: { Authorization: 'Bearer z' } }] },
      KEY,
    )
    expect(redactedCount).toBe(3)
  })

  it('refuses by name when the key is not usable, rather than storing unredacted', async () => {
    await expect(redactCapture({ password: 'x' }, 'not-hex')).rejects.toThrow(/redaction key/)
  })
})
