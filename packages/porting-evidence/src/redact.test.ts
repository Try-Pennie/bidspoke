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

// Credential shaped fixtures are assembled from parts so the secret scanner in CI
// does not read these obviously fake values as leaked keys. The values the tests
// see are unchanged.
const fake = (...parts: string[]): string => parts.join('')

describe('redactCapture: credential names', () => {
  it.each(['password', 'client_secret', 'clientSecret', 'api_key', 'apiKey', 'access_token', 'refresh_token', 'private_key', 'secret'])(
    'replaces the value of %s with a keyed hash of the same length and prefix',
    async (name) => {
      const secret = fake('at_', '9f8e7d6c', '5b4a39281706')
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
    ['a JWT', fake('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')],
    ['a bearer header value', 'Bearer 8a7b6c5d4e3f2a1b0c9d8e7f'],
    ['a Stripe live key', fake('sk_', 'live_', '51HaBcDeFgHiJkLmNoPqRsTuV')],
    ['a Slack token', fake('xox', 'b-1234567890-0987654321-AbCdEfGhIjKlMnOpQrStUvWx')],
    ['a GitHub token', fake('gh', 'p_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789')],
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
    const secret = fake('4f1c2a9b8d7e6f5a', '4b3c2d1e0f9a8b7c')
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

// Dan, 2026-10-01: SSN, date of birth and account numbers are scrambled like
// credentials; name, address, phone and email stay readable for debugging.
describe('redactCapture: the most sensitive personal fields', () => {
  it.each(['ssn', 'SSN', 'social_security_number', 'socialSecurityNumber', 'dob', 'date_of_birth', 'dateOfBirth', 'birthDate', 'account_number', 'accountNumber', 'bank_account_number', 'routing_number'])(
    'scrambles the value of %s, keeping its length',
    async (name) => {
      const raw = '123-45-6789'
      const { value, redactedCount } = await redactCapture({ [name]: raw }, KEY)
      const out = (value as Record<string, string>)[name]
      expect(out).not.toBe(raw)
      expect(out).toHaveLength(raw.length)
      expect(out).not.toContain('6789')
      expect(redactedCount).toBe(1)
    },
  )

  it('scrambles a formatted SSN inside free text, whatever the field is called', async () => {
    const { value, redactedCount } = await redactCapture({ note: 'applicant 123-45-6789 called' }, KEY)
    const out = (value as { note: string }).note
    expect(out).not.toContain('123-45-6789')
    expect(out.startsWith('applicant ')).toBe(true)
    expect(out.endsWith(' called')).toBe(true)
    expect(redactedCount).toBe(1)
  })

  it('scrambles an unformatted SSN inside a serialised request body', async () => {
    const body = JSON.stringify({ ssn: '123456789', firstName: 'Ada' })
    const { value } = await redactCapture({ body }, KEY)
    const out = (value as { body: string }).body
    expect(out).not.toContain('123456789')
    expect(out).toContain('"firstName":"Ada"')
  })

  it('scrambles the same SSN the same way on both halves of a comparison', async () => {
    const a = await redactCapture({ ssn: '123456789' }, KEY)
    const b = await redactCapture({ lead: { SSN: '123456789' } }, KEY)
    expect((a.value as { ssn: string }).ssn).toBe((b.value as { lead: { SSN: string } }).lead.SSN)
  })

  it('keeps name, address, phone and email readable', async () => {
    const input = {
      firstName: 'Ada', lastName: 'Lovelace', address: '12 Main St', city: 'Austin',
      state: 'TX', zip: '73301', phone: '512-555-0142', email: 'ada@example.com',
    }
    const { value, redactedCount } = await redactCapture(input, KEY)
    expect(value).toEqual(input)
    expect(redactedCount).toBe(0)
  })
})
