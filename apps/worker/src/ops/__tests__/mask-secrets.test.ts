/**
 * Masking the secret variables an ops step was given out of what ops keeps
 * (#2982: "Secret values are masked in the step results ops keeps"). Each
 * secret's value is replaced by its name wherever it appears in a string, at
 * any depth, an object's keys included, so the kept result can say which
 * secret was there without holding it.
 */
import { describe, expect, it } from 'vitest'
import { maskSecrets } from '../mask-secrets'

const SECRETS = { API_TOKEN: 'tok-9f8e7d6c5b4a', SIGNING_KEY: 'sk_live_0123456789' }

describe('maskSecrets', () => {
  it('replaces each secret value with its name inside strings, at any depth and in keys', () => {
    const value = {
      header: 'Bearer tok-9f8e7d6c5b4a',
      list: ['sk_live_0123456789', 1, null, true, { deep: 'x tok-9f8e7d6c5b4a y tok-9f8e7d6c5b4a' }],
      'tok-9f8e7d6c5b4a': 'a key that is a secret',
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

  it('returns the value unchanged when there is no secret, and never masks an empty value', () => {
    const value = { a: 'plain', b: [1, 'two'] }
    expect(maskSecrets(value, {})).toEqual(value)
    expect(maskSecrets('plain', { EMPTY: '' })).toBe('plain')
  })

  it('never changes the value it was given', () => {
    const value = { a: 'tok-9f8e7d6c5b4a' }
    maskSecrets(value, SECRETS)
    expect(value).toEqual({ a: 'tok-9f8e7d6c5b4a' })
  })
})
