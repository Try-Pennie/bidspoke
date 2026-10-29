/**
 * Masking the secret variables an ops step was given out of what ops keeps
 * (#2982: "Secret values are masked in the step results ops keeps"). Each
 * secret's value is replaced by its name wherever it appears in a string, at
 * any depth, an object's keys included, so the kept result can say which
 * secret was there without holding it.
 */
import { describe, expect, it } from 'vitest'
import { maskSecrets } from '../mask-secrets'

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
