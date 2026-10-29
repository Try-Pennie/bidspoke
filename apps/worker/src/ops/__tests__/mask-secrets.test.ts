/**
 * Masking the secret variables an ops step was given out of what ops keeps
 * (#2982: "Secret values are masked in the step results ops keeps"). Each
 * secret's value is replaced by its name wherever it appears in a string, at
 * any depth, an object's keys included, so the kept result can say which
 * secret was there without holding it.
 */
import { describe, expect, it } from 'vitest'
import { holdsSecret, maskSecrets, maskSecretsForRefill, refillSecrets } from '../mask-secrets'

const SECRETS = { API_TOKEN: 'fake-api-token-value', SIGNING_KEY: 'fake-signing-key-for-masking-tests' }

describe('maskSecrets', () => {
  it('replaces each secret value with its name inside strings, at any depth and in keys', () => {
    const value = {
      header: 'Bearer fake-api-token-value',
      list: ['fake-signing-key-for-masking-tests', 1, null, true, { deep: 'x fake-api-token-value y fake-api-token-value' }],
      'fake-api-token-value': 'a key that is a secret',
    }
    expect(maskSecrets(value, SECRETS)).toEqual({
      header: 'Bearer API_TOKEN',
      list: ['SIGNING_KEY', 1, null, true, { deep: 'x API_TOKEN y API_TOKEN' }],
      API_TOKEN: 'a key that is a secret',
    })
  })

  it('masks a longer secret before a shorter one it contains, so no part of the longer is left', () => {
    expect(maskSecrets('abc-long-abc', { SHORT: 'abc', LONG: 'abc-long-abc' })).toBe('LONG')
  })

  it('masks a secret in the escaped forms a request carries it in: a JSON string, a URL and a form body', () => {
    const KEY = '-----BEGIN KEY-----\nab"c\\d e&f=g/h\n-----END KEY-----'
    const json = JSON.stringify({ key: KEY, note: 'kept' })
    const url = `https://api.example.test/x?key=${encodeURIComponent(KEY)}&q=1`
    const form = new URLSearchParams({ key: KEY, q: '1' }).toString()
    const masked = maskSecrets({ json, url, form, raw: KEY }, { PRIVATE_KEY: KEY }) as Record<string, string>
    expect(masked).toEqual({
      json: '{"key":"PRIVATE_KEY","note":"kept"}',
      url: 'https://api.example.test/x?key=PRIVATE_KEY&q=1',
      form: 'key=PRIVATE_KEY&q=1',
      raw: 'PRIVATE_KEY',
    })
    for (const text of Object.values(masked)) {
      expect(text).not.toContain('ab')
      expect(text).not.toContain('BEGIN')
    }
  })

  it('returns the value unchanged when there is no secret, and never masks an empty value', () => {
    const value = { a: 'plain', b: [1, 'two'] }
    expect(maskSecrets(value, {})).toEqual(value)
    expect(maskSecrets('plain', { EMPTY: '' })).toBe('plain')
  })

  it('never changes the value it was given', () => {
    const value = { a: 'fake-api-token-value' }
    maskSecrets(value, SECRETS)
    expect(value).toEqual({ a: 'fake-api-token-value' })
  })
})

// #2998: a run's checkpoint is never written holding a secret, so the walk asks first.
describe('holdsSecret', () => {
  it('says whether a secret, raw or in an escaped form, is anywhere in a value, keys included', () => {
    expect(holdsSecret([{ output: { t: 'x fake-api-token-value' } }], SECRETS)).toBe(true)
    expect(holdsSecret({ 'fake-signing-key-for-masking-tests': 1 }, SECRETS)).toBe(true)
    expect(holdsSecret({ url: `https://x.test/?k=${encodeURIComponent('a b&c')}` }, { K: 'a b&c' })).toBe(true)
    expect(holdsSecret([{ output: { t: 'nothing here' } }], SECRETS)).toBe(false)
    expect(holdsSecret({ t: 'fake-api-token-value' }, {})).toBe(false)
    expect(holdsSecret('plain', { EMPTY: '' })).toBe(false)
  })
})

// #3024: a run's checkpoint is written with every secret masked, and refilled
// from the secrets served to the slice that resumes it, so the mask must come
// back off exactly, and only where a secret was.
describe('maskSecretsForRefill and refillSecrets', () => {
  const KEY = '-----BEGIN KEY-----\nab"c\\d e&f=g/h\n-----END KEY-----'
  const planted = () => ({
    header: 'Bearer fake-api-token-value',
    list: ['fake-signing-key-for-masking-tests', 1, null, true, { deep: 'x fake-api-token-value y fake-api-token-value' }],
    'fake-api-token-value': 'a key that is a secret',
    json: JSON.stringify({ key: KEY, note: 'kept' }),
    url: `https://api.example.test/x?key=${encodeURIComponent(KEY)}&q=1`,
    form: new URLSearchParams({ key: KEY, q: '1' }).toString(),
    plain: 'nothing secret',
  })
  const ALL = { ...SECRETS, PRIVATE_KEY: KEY }

  it('masks every secret, raw or escaped, in values and keys, and refills the exact value given the same secrets', () => {
    const masked = maskSecretsForRefill(planted(), ALL)
    expect(holdsSecret(masked, ALL)).toBe(false)
    expect(JSON.stringify(masked)).not.toContain('fake-api-token-value')
    expect(JSON.stringify(masked)).not.toContain('BEGIN')
    expect(refillSecrets(masked, ALL)).toEqual({ kind: 'refilled', value: planted() })
  })

  it('refills with the values served now, each in the form it was found in', () => {
    const masked = maskSecretsForRefill({ url: `https://x.test/?k=${encodeURIComponent('old value&1')}`, raw: 'old value&1' }, { K: 'old value&1' })
    expect(refillSecrets(masked, { K: 'new value&2' })).toEqual({
      kind: 'refilled', value: { url: `https://x.test/?k=${encodeURIComponent('new value&2')}`, raw: 'new value&2' },
    })
  })

  it('refuses, naming the variable, a value served now that would be written differently in a form the masked one read the same in: it never guesses the escaping', () => {
    // Inside a JSON string, a value with no quote reads the same raw and escaped, so which one the step wrote cannot be told.
    const body = JSON.stringify({ token: 'fake-token-no-quote' })
    const masked = maskSecretsForRefill({ body }, { API_TOKEN: 'fake-token-no-quote' })
    expect(refillSecrets(masked, { API_TOKEN: 'fake-token-"quoted"' })).toEqual({ kind: 'changed', names: ['API_TOKEN'] })
    // One that reads the same in all those forms too is refilled.
    expect(refillSecrets(masked, { API_TOKEN: 'fake-token-also-plain' })).toEqual({ kind: 'refilled', value: { body: JSON.stringify({ token: 'fake-token-also-plain' }) } })
  })

  it('never mistakes a real string for a mask: the name maskSecrets writes, and the exact text a mask is stored as, both come back unchanged', () => {
    const storedMask = maskSecretsForRefill('fake-api-token-value', SECRETS) as string
    expect(storedMask).not.toBe('fake-api-token-value')
    const real = { name: 'API_TOKEN', looksMasked: storedMask, [storedMask]: 'a key shaped like a mask', lead: '\u0000 starts with the mark' }
    const masked = maskSecretsForRefill(real, SECRETS)
    expect(refillSecrets(masked, SECRETS)).toEqual({ kind: 'refilled', value: real })
    // Refilled with other secrets, only a real mask would change: these are data, so nothing does.
    expect(refillSecrets(masked, { API_TOKEN: 'fake-other-token-value', SIGNING_KEY: 'fake-other-signing-key' })).toEqual({ kind: 'refilled', value: real })
  })

  it('leaves a value with no secret as it was, and keeps numbers, booleans and null', () => {
    const value = { a: 'plain', b: [1, 'two', false, null] }
    expect(maskSecretsForRefill(value, SECRETS)).toEqual(value)
    expect(refillSecrets(value, SECRETS)).toEqual({ kind: 'refilled', value })
  })

  it('names every masked secret the refill was not given, or was given empty, and never refills with the mask', () => {
    const masked = maskSecretsForRefill({ a: 'fake-api-token-value', b: 'fake-signing-key-for-masking-tests' }, SECRETS)
    expect(refillSecrets(masked, { SIGNING_KEY: 'fake-signing-key-for-masking-tests' })).toEqual({ kind: 'unserved', names: ['API_TOKEN'] })
    expect(refillSecrets(masked, { API_TOKEN: '', SIGNING_KEY: '' })).toEqual({ kind: 'unserved', names: ['API_TOKEN', 'SIGNING_KEY'] })
  })

  it('refuses a stored mask it cannot read, by name, rather than guessing', () => {
    for (const bad of ['\u0000m', '\u0000mnot json', '\u0000m[{"secret":"A","forms":["rot13"]}]', '\u0000m[{"secret":"A","forms":[]}]', '\u0000m[3]', '\u0000m[{"secret":"A"}]', '\u0000x', '\u0000']) {
      expect(refillSecrets({ v: bad }, SECRETS), JSON.stringify(bad)).toMatchObject({ kind: 'malformed' })
    }
  })

  it('never changes the value it was given', () => {
    const value = { a: 'fake-api-token-value' }
    maskSecretsForRefill(value, SECRETS)
    expect(value).toEqual({ a: 'fake-api-token-value' })
  })
})
