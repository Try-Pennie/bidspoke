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

// Review of #1711: anchoring the JWT shape on what precedes `eyJ` (to keep it
// linear) stopped catching a JWT glued to a word, an underscore or a hyphen.
describe('redactCapture: a JWT glued to the text before it', () => {
  const jwt = fake('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')
  it.each([['tok_'], ['id-'], ['access_token'], ['x.y.'], ['abcde.fghij.']])('replaces a JWT after %s, keeping what precedes it', async (glue) => {
    const { value, redactedCount } = await redactCapture({ note: `${glue}${jwt} end` }, KEY)
    const out = (value as { note: string }).note
    expect(out.startsWith(`${glue}eyJ`)).toBe(true)
    expect(out).not.toContain('eyJzdWIiOiIxMjM0NTY3ODkwIn0')
    expect(out).not.toContain('dozjgNryP4J3')
    expect(out).toHaveLength(glue.length + jwt.length + 4)
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

describe('redactCapture: sensitive personal fields inside serialised text', () => {
  it('scrambles date of birth and account numbers inside a body held as a string', async () => {
    const body = JSON.stringify({ dob: '1990-04-12', account_number: '000123456789', routingNumber: '021000021', city: 'Austin' })
    const { value } = await redactCapture({ body }, KEY)
    const out = (value as { body: string }).body
    expect(out).not.toContain('1990-04-12')
    expect(out).not.toContain('000123456789')
    expect(out).not.toContain('021000021')
    expect(out).toContain('"city":"Austin"')
  })

  it('scrambles an SSN and date of birth in doubly encoded JSON', async () => {
    const inner = JSON.stringify({ ssn: '123456789', date_of_birth: '04/12/1990' })
    const body = JSON.stringify({ payload: inner })
    const { value } = await redactCapture({ body }, KEY)
    const out = (value as { body: string }).body
    expect(out).not.toContain('123456789')
    expect(out).not.toContain('04/12/1990')
  })

  it('scrambles a form encoded body', async () => {
    const { value } = await redactCapture({ body: 'first=Ada&ssn=123-45-6789&dob=1990-04-12&zip=73301' }, KEY)
    const out = (value as { body: string }).body
    expect(out).not.toContain('6789')
    expect(out).not.toContain('1990-04-12')
    expect(out).toContain('first=Ada')
    expect(out).toContain('zip=73301')
  })
})

// Field names measured in the 2026-09-30 Pipedream export.
describe('redactCapture: the field names the real workflows use', () => {
  it.each([
    'formattedSSN', 'formattedSsn', 'ssnRaw', 'socialNum', 'Applicant_SSN__c', 'SSN__c',
    'SocialSecurityNumber__c', 'Social_Security_Number_SO__c', 'formattedDOB', 'formattedDob',
    'DOB', 'BirthDate__c', 'Date_of_Birth_SO__c', 'birthdate', 'dateOfBirth', 'account_number',
    'routing_number',
  ])('scrambles %s as an object field', async (name) => {
    const raw = '1990-04-12'
    const { value } = await redactCapture({ [name]: raw }, KEY)
    expect((value as Record<string, string>)[name]).not.toBe(raw)
  })

  it.each(['SocialSecurityNumber__c', 'BirthDate__c', 'Applicant_SSN__c', 'formattedDOB'])(
    'scrambles %s inside a body held as a string',
    async (name) => {
      const body = JSON.stringify({ [name]: '19900412', LastName: 'Lovelace' })
      const { value } = await redactCapture({ body }, KEY)
      const out = (value as { body: string }).body
      expect(out).not.toContain('19900412')
      expect(out).toContain('"LastName":"Lovelace"')
    },
  )

  it('leaves routing names that are not bank routing numbers alone', async () => {
    const input = { routingPartner: 'tripoint', External_Routing_Code__c: 'ENG-7', task_routing: 'main' }
    const { value } = await redactCapture(input, KEY)
    expect(value).toEqual(input)
  })
})

// Review of #1711: matching a sensitive word anywhere inside the normalised name
// scrambled ordinary fields whose letters happen to contain it (business_name
// holds "ssn" once the underscore is gone, adobe_id holds "dob"). Names are
// matched on their TOKENS instead.
describe('redactCapture: names that only contain a sensitive word by accident', () => {
  const READABLE = ['business_name', 'class_name', 'address_number', 'adobe_id', 'cardobject', 'routingPartner', 'External_Routing_Code__c']

  it.each(READABLE)('keeps %s readable as an object field', async (name) => {
    const input = { [name]: 'ordinary-value-1990' }
    const { value, redactedCount } = await redactCapture(input, KEY)
    expect(value).toEqual(input)
    expect(redactedCount).toBe(0)
  })

  it.each(READABLE)('keeps %s readable inside a body held as a string', async (name) => {
    const body = JSON.stringify({ [name]: 'ordinaryvalue1990' })
    const { value, redactedCount } = await redactCapture({ body }, KEY)
    expect((value as { body: string }).body).toBe(body)
    expect(redactedCount).toBe(0)
  })

  it('still scrambles a sensitive key that sits inside another value in a form body', async () => {
    const { value } = await redactCapture({ body: 'note=ssn:123456789&zip=73301' }, KEY)
    const out = (value as { body: string }).body
    expect(out).not.toContain('123456789')
    expect(out).toContain('zip=73301')
  })
})

// #1718: names are matched on their tokens, so a sensitive word run together
// with another inside one lower case token (`userssn`, `bankaccountnumber`) was
// one unknown token and its value was stored readable. Inside a single token the
// long words match anywhere, and the short ones (ssn, dob) only at the token's
// start or end, so `adobe`, `cardobject` and `businessname` stay readable.
describe('redactCapture: sensitive words run together inside one token', () => {
  const SENSITIVE = [
    'bankaccountnumber', 'borrowerdob', 'userssn', 'customerdob', 'lastfourssn', 'ssnlast4', 'dobraw',
    'applicantdateofbirth', 'applicantbirthdate', 'primarysocialsecurity', 'bankroutingnumber',
  ]
  const READABLE = ['businessname', 'classname', 'addressnumber', 'adobeid', 'cardobject', 'routingpartner', 'accountname']

  it.each(SENSITIVE)('scrambles %s as an object field', async (name) => {
    const { value, redactedCount } = await redactCapture({ [name]: '123456789' }, KEY)
    expect((value as Record<string, string>)[name]).not.toBe('123456789')
    expect(redactedCount).toBe(1)
  })

  it.each(SENSITIVE)('scrambles %s inside a body held as a string', async (name) => {
    const body = JSON.stringify({ [name]: '123456789' })
    const { value } = await redactCapture({ body }, KEY)
    expect((value as { body: string }).body).not.toContain('123456789')
  })

  it.each(READABLE)('keeps %s readable', async (name) => {
    const input = { [name]: 'ordinary-value-1990', body: JSON.stringify({ [name]: 'ordinaryvalue1990' }) }
    const { value, redactedCount } = await redactCapture(input, KEY)
    expect(value).toEqual(input)
    expect(redactedCount).toBe(0)
  })
})

// Review of #1711, the serialised text pass: values cut short at a space or
// comma, key spellings the object path scrambles but the text path missed, and
// literals replaced inside JSON so the body no longer parsed.
describe('redactCapture: whole values inside serialised text', () => {
  const bodyOf = async (body: string) => ((await redactCapture({ body }, KEY)).value as { body: string }).body

  it('takes the whole quoted value, spaces and commas included', async () => {
    const out = await bodyOf(JSON.stringify({ dob: 'April 12, 1990', city: 'Austin' }))
    expect(out).not.toMatch(/April|12|1990/)
    expect(JSON.parse(out)).toMatchObject({ city: 'Austin' })
    expect((JSON.parse(out) as { dob: string }).dob).toHaveLength('April 12, 1990'.length)
  })

  it('honours an escaped quote inside a quoted value', async () => {
    const out = await bodyOf(JSON.stringify({ ssn: 'say "123" 456789', city: 'Austin' }))
    expect(out).not.toMatch(/456789|123/)
    expect(JSON.parse(out)).toMatchObject({ city: 'Austin' })
  })

  it('takes the whole quoted value in doubly encoded JSON', async () => {
    const out = await bodyOf(JSON.stringify({ payload: JSON.stringify({ dob: 'April 12, 1990', zip: '73301' }) }))
    expect(out).not.toMatch(/April|1990/)
    expect(JSON.parse((JSON.parse(out) as { payload: string }).payload)).toMatchObject({ zip: '73301' })
  })

  it('runs an unquoted form value to the next ampersand', async () => {
    const out = await bodyOf('dob=April 12 1990&zip=73301')
    expect(out).not.toMatch(/April|1990/)
    expect(out.endsWith('&zip=73301')).toBe(true)
  })

  it('runs an unquoted form value to the end of the text', async () => {
    const out = await bodyOf('zip=73301&dob=April 12 1990')
    expect(out).not.toMatch(/April|1990/)
    expect(out.startsWith('zip=73301&dob=')).toBe(true)
  })
})

describe('redactCapture: key spellings inside serialised text', () => {
  it.each([
    ['date-of-birth=1990-04-12&zip=73301', '1990-04-12'],
    ['account-number=000123456789&zip=73301', '000123456789'],
    ['X-SSN=123456789&zip=73301', '123456789'],
    [JSON.stringify({ 'account number': '000123456789', zip: '73301' }), '000123456789'],
    [JSON.stringify({ 'Date Of Birth': '04/12/1990', zip: '73301' }), '04/12/1990'],
  ])('scrambles the value in %s', async (body, secret) => {
    const out = ((await redactCapture({ body }, KEY)).value as { body: string }).body
    expect(out).not.toContain(secret)
    expect(out).toContain('73301')
  })
})

describe('redactCapture: literals and numbers inside serialised JSON', () => {
  it('leaves null, true and false alone and keeps the body valid JSON', async () => {
    const input = { ssn: null, dob: false, routing_number: true, city: 'Austin' }
    const body = JSON.stringify(input)
    const { value, redactedCount } = await redactCapture({ body }, KEY)
    expect((value as { body: string }).body).toBe(body)
    expect(redactedCount).toBe(0)
  })

  it('replaces a number with a number of the same length, so the body still parses', async () => {
    const body = JSON.stringify({ ssn: 123456789, account_number: -42, city: 'Austin' })
    const out = ((await redactCapture({ body }, KEY)).value as { body: string }).body
    const parsed = JSON.parse(out) as { ssn: number; account_number: number; city: string }
    expect(typeof parsed.ssn).toBe('number')
    expect(parsed.ssn).not.toBe(123456789)
    expect(String(parsed.ssn)).toHaveLength(9)
    expect(parsed.account_number).not.toBe(-42)
    expect(String(parsed.account_number)).toHaveLength(3)
    expect(parsed.city).toBe('Austin')
  })

  it('leaves prose such as "dob: unknown" alone, and still scrambles "ssn: 123456789" in prose', async () => {
    const out = ((await redactCapture({ note: 'dob: unknown, ssn: 123456789' }, KEY)).value as { note: string }).note
    expect(out).toContain('dob: unknown')
    expect(out).not.toContain('123456789')
  })

  it('leaves undefined alone in a form body', async () => {
    const { value, redactedCount } = await redactCapture({ body: 'dob=undefined&zip=73301' }, KEY)
    expect((value as { body: string }).body).toBe('dob=undefined&zip=73301')
    expect(redactedCount).toBe(0)
  })
})

// Review of #1711: the serialised text pass opened with an unbounded letter run,
// so a long run of letters cost time quadratic in its length, and a 1 MiB body
// could burn the Worker's CPU. Each body here is 1 MiB; a linear scan finishes in
// milliseconds, so a one second ceiling is generous headroom, not a tight budget.
describe('redactCapture: time is linear in the size of serialised text', () => {
  const MIB = 1024 * 1024
  it.each([
    ['letters', 'a'.repeat(MIB)],
    ['a repeated sensitive word', 'ssn'.repeat(MIB / 4)],
    ['a repeated JWT opening', 'eyJ'.repeat(MIB / 3)],
    ['dotted runs of JWT openings', ('eyJabcde'.repeat(100) + '.').repeat(Math.floor(MIB / 801))],
    ['glued JWT openings', 'x_eyJ'.repeat(Math.floor(MIB / 5))],
    ['many sensitive key value pairs', 'ssn=123456789&'.repeat(Math.floor(MIB / 14))],
    ['separators', ':='.repeat(MIB / 2)],
    ['quoted keys with no values', '"date of birth":'.repeat(MIB / 16)],
    ['escaped quoted sensitive pairs', '\\"ssn\\":\\"1 2\\",'.repeat(Math.floor(MIB / 16))],
    ['long keys before separators', ('k'.repeat(200) + '=').repeat(Math.floor(MIB / 201))],
    ['prose keys whose values are rejected', 'dob: unknown '.repeat(Math.floor(MIB / 13))],
  ])('redacts 1 MiB of %s in well under a second', async (_label, body) => {
    const started = performance.now()
    await redactCapture({ body }, KEY)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('redactCapture: a sensitive key holding an object or a list', () => {
  it.each([
    ['an object', { ssn: { last4: '6789', verified: true }, city: 'Austin' }],
    ['a list', { dob: ['1990', '04', '12'], city: 'Austin' }],
    ['an empty object', { account_number: {}, city: 'Austin' }],
  ])('keeps a serialised body that holds %s valid JSON', async (_label, inner) => {
    const body = JSON.stringify(inner)
    const { value } = await redactCapture({ body }, KEY)
    const out = (value as { body: string }).body
    expect(() => JSON.parse(out) as unknown).not.toThrow()
    expect((JSON.parse(out) as { city: string }).city).toBe('Austin')
  })

  const bodyOf = async (body: string) => ((await redactCapture({ body }, KEY)).value as { body: string }).body

  it('scrambles every string and number inside an object, keeping its keys, literals and shape', async () => {
    const out = await bodyOf(JSON.stringify({ ssn: { last4: '6789', verified: true, n: 12345, gone: null }, city: 'Austin' }))
    expect(out).not.toMatch(/6789|12345/)
    const parsed = JSON.parse(out) as { ssn: { last4: string; verified: boolean; n: number; gone: null }; city: string }
    expect(Object.keys(parsed.ssn)).toEqual(['last4', 'verified', 'n', 'gone'])
    expect(parsed.ssn.last4).toHaveLength(4)
    expect(parsed.ssn.verified).toBe(true)
    expect(parsed.ssn.gone).toBeNull()
    expect(String(parsed.ssn.n)).toHaveLength(5)
    expect(parsed.city).toBe('Austin')
  })

  it('scrambles every item inside a list, nested ones included', async () => {
    const out = await bodyOf(JSON.stringify({ dob: ['1990', '04', 12, ['x1990', { y: '1990' }]], city: 'Austin' }))
    expect(out).not.toContain('1990')
    const parsed = JSON.parse(out) as { dob: [string, string, number, [string, { y: string }]]; city: string }
    expect(parsed.dob).toHaveLength(4)
    expect(parsed.dob[0]).toHaveLength(4)
    expect(typeof parsed.dob[2]).toBe('number')
    expect(parsed.dob[3][1].y).toHaveLength(4)
    expect(parsed.city).toBe('Austin')
  })

  it('is not fooled by brackets and escaped quotes inside a string in the object', async () => {
    const out = await bodyOf(JSON.stringify({ ssn: { note: 'a } ] { "q" 6789' }, city: 'Austin' }))
    expect(out).not.toContain('6789')
    expect((JSON.parse(out) as { city: string }).city).toBe('Austin')
  })

  it('scrambles an object inside doubly encoded JSON and keeps both levels valid', async () => {
    const out = await bodyOf(JSON.stringify({ payload: JSON.stringify({ ssn: { last4: '6789' }, zip: '73301' }) }))
    expect(out).not.toContain('6789')
    const inner = JSON.parse((JSON.parse(out) as { payload: string }).payload) as { ssn: { last4: string }; zip: string }
    expect(inner.ssn.last4).toHaveLength(4)
    expect(inner.zip).toBe('73301')
  })

  it.each([
    ['a form value', 'ssn=[123456789]&zip=73301', '123456789'],
    ['prose', 'note dob: {1990-04-12}; zip 73301', '1990-04-12'],
  ])('still scrambles a bracketed %s whole', async (_label, body, secret) => {
    const out = await bodyOf(body)
    expect(out).not.toContain(secret)
    expect(out).toContain('73301')
  })

  it.each([
    ['unclosed objects', '{"ssn":{'.repeat(Math.floor((1024 * 1024) / 8))],
    ['unclosed strings in lists', '{"dob":["a'.repeat(Math.floor((1024 * 1024) / 10))],
    ['deep nesting', '{"ssn":' + '['.repeat(1024 * 1024) ],
  ])('stays linear on 1 MiB of %s', async (_label, body) => {
    const started = performance.now()
    await redactCapture({ body }, KEY)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

// #1816: the recorder captures Pipedream's `steps.trigger.event`, whose `url`
// carries the inbound query raw. The keyed text pass read a key back from `=`
// over key characters only, so a percent encoded name (`lead%5Bssn%5D=`,
// `date%20of%20birth=`) was not recognised, and a fully encoded nested address
// had no `=` at all. The text is now also read percent decoded, layer by layer,
// and every replacement lands on the ORIGINAL text, so the rest of the address
// keeps its encoding byte for byte.
describe('redactCapture: percent encoded query strings', () => {
  const bodyOf = async (body: string) => ((await redactCapture({ body }, KEY)).value as { body: string }).body

  // The date of birth case matters on its own: a nine digit SSN is also caught
  // by the bare nine digit rule, so only a value of another shape proves the
  // bracketed key itself is recognised.
  it.each([
    ['lead%5Bssn%5D', '123456789'],
    ['lead%5Bdob%5D', '1990-04-12'],
    ['lead%5bdate_of_birth%5d', '04/12/1990'],
  ])('scrambles a value under the bracketed, percent encoded key %s and keeps the key as written', async (key, secret) => {
    const out = await bodyOf(`https://in.example/lead?${key}=${secret}&zip=73301`)
    expect(out).not.toContain(secret)
    expect(out).toContain(`${key}=`)
    expect(out.endsWith('&zip=73301')).toBe(true)
  })

  it('scrambles a value under a plain bracketed key', async () => {
    const out = await bodyOf('lead[applicant][dob]=1990-04-12&zip=73301')
    expect(out).not.toContain('1990-04-12')
    expect(out).toContain('zip=73301')
  })

  it.each([
    ['%20', 'date%20of%20birth=1990-04-12&zip=73301'],
    ['+', 'date+of+birth=1990-04-12&zip=73301'],
    ['%20 in an account number', 'bank%20account%20number=000123456789&zip=73301'],
  ])('scrambles a value under a key spaced with %s', async (_label, body) => {
    const out = await bodyOf(body)
    expect(out).not.toMatch(/1990-04-12|000123456789/)
    expect(out.endsWith('&zip=73301')).toBe(true)
  })

  it('scrambles a value inside a fully encoded nested address, which has no = of its own', async () => {
    const nested = encodeURIComponent('https://x.example/p?ssn=123456789&zip=73301')
    const body = `https://in.example/go?next=${nested}&first=Ada`
    expect(body).not.toMatch(/ssn=/)
    const out = await bodyOf(body)
    expect(out).not.toContain('123456789')
    expect(out).toContain('ssn%3D')
    expect(out).toContain('zip%3D73301')
    expect(out.endsWith('&first=Ada')).toBe(true)
  })

  it('scrambles a value inside a doubly encoded nested address', async () => {
    const nested = encodeURIComponent(encodeURIComponent('https://x.example/p?dob=1990-04-12&zip=73301'))
    const out = await bodyOf(`next=${nested}&first=Ada`)
    expect(out).not.toContain('1990-04-12')
    expect(out).toContain('dob%253D')
    expect(out).toContain('zip%253D73301')
  })

  it('reaches a value under five levels of encoding', async () => {
    let nested = 'ssn=123456789&zip=73301'
    for (let i = 0; i < 5; i++) nested = encodeURIComponent(nested)
    const out = await bodyOf(`next=${nested}`)
    expect(out).not.toContain('123456789')
    expect(out).toContain('73301')
  })

  it('scrambles a percent encoded value the same way as the same value written plainly', async () => {
    const encoded = await bodyOf('ssn=123%2D45%2D6789&zip=73301')
    const plain = await bodyOf('ssn=123-45-6789&zip=73301')
    expect(encoded).not.toContain('6789')
    expect(encoded).toBe(plain)
  })

  it('scrambles a percent encoded formatted SSN in a free text query value', async () => {
    const out = await bodyOf('note=applicant%20123%2D45%2D6789%20called&zip=73301')
    expect(out).not.toContain('6789')
    expect(out).toContain('note=applicant%20')
    expect(out).toContain('%20called&zip=73301')
  })

  it('scrambles a bare nine digit value in an address whatever its name', async () => {
    const out = await bodyOf('https://in.example/lead?ref=123456789&first=Ada')
    expect(out).not.toContain('123456789')
    expect(out.endsWith('&first=Ada')).toBe(true)
  })

  it('scrambles a bare nine digit value under an ordinary name inside a nested address', async () => {
    const nested = encodeURIComponent('https://x.example/p?applicant=123456789&zip=73301')
    const out = await bodyOf(`next=${nested}`)
    expect(out).not.toContain('123456789')
    expect(out).toContain('zip%3D73301')
  })

  it('keeps a nine digit ZIP+4, a phone number and longer or shorter digit runs readable', async () => {
    const body = 'zip=733011234&postal_code=733011234&phone=5125550142&lead_id=1234567890&amount=12345678'
    const { value, redactedCount } = await redactCapture({ body }, KEY)
    expect((value as { body: string }).body).toBe(body)
    expect(redactedCount).toBe(0)
  })

  it('keeps name, address, phone and email readable in an encoded query', async () => {
    const body = 'https://in.example/lead?first=Ada%20Lovelace&address=12+Main+St&phone=%2B1%20512%20555%200142&email=ada%40example.com&state=TX'
    const { value, redactedCount } = await redactCapture({ body }, KEY)
    expect((value as { body: string }).body).toBe(body)
    expect(redactedCount).toBe(0)
  })

  it.each([
    ['a truncated multibyte sequence', 'ssn=%E0%A4%A&first=Ada'],
    ['a percent with no hex after it', 'ssn=%zz9&first=Ada'],
    ['a trailing percent', 'first=Ada&ssn=12%'],
    ['a lone surrogate encoding', 'ssn=%ED%A0%80&first=Ada'],
  ])('does not throw on %s, and still scrambles the value', async (_label, body) => {
    const out = await bodyOf(body)
    expect(out).toContain('first=Ada')
    expect(out).not.toBe(body)
  })

  it('scrambles an object field whose name is percent encoded or bracketed', async () => {
    const input = { 'date%20of%20birth': '1990-04-12', 'lead[ssn]': '123456789', 'first+name': 'Ada' }
    const { value } = await redactCapture(input, KEY)
    const out = value as Record<string, string>
    expect(out['date%20of%20birth']).not.toBe('1990-04-12')
    expect(out['lead[ssn]']).not.toBe('123456789')
    expect(out['first+name']).toBe('Ada')
  })

  it('scrubs the shape Pipedream records for an HTTP trigger', async () => {
    const event = {
      method: 'GET',
      path: '/',
      query: { 'lead[ssn]': '123456789', first: 'Ada' },
      url: 'https://abc.m.pipedream.net/?lead%5Bssn%5D=123456789&first=Ada&next=' + encodeURIComponent('https://x.example/?dob=1990-04-12'),
    }
    const { value } = await redactCapture({ trigger: { event } }, KEY)
    const text = JSON.stringify(value)
    expect(text).not.toMatch(/123456789|1990-04-12/)
    expect(text).toContain('first=Ada')
  })
})

describe('redactCapture: percent decoding stays linear', () => {
  const MIB = 1024 * 1024
  it.each([
    ['encoded percents', '%25'.repeat(Math.floor(MIB / 3))],
    ['one deeply encoded percent', '%' + '25'.repeat(Math.floor(MIB / 2))],
    ['plus signs', 'a+'.repeat(MIB / 2)],
    ['encoded sensitive pairs', 'lead%5Bssn%5D=123456789&'.repeat(Math.floor(MIB / 24))],
    ['encoded separators', '%3D'.repeat(Math.floor(MIB / 3))],
    ['bare nine digit values', 'a=123456789&'.repeat(Math.floor(MIB / 12))],
    ['spaced keys before separators', ('k '.repeat(100) + '=').repeat(Math.floor(MIB / 201))],
  ])('redacts 1 MiB of %s in well under a second', async (_label, body) => {
    const started = performance.now()
    await redactCapture({ body }, KEY)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
