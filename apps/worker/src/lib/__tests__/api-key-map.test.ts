import { describe, it, expect } from 'vitest'
import { sourceForApiKey } from '../api-key-map'

describe('sourceForApiKey (#1702)', () => {
  const keyMap = JSON.parse('{"sk_real":"engine","sk_blank":"","sk_number":7}') as Record<string, unknown>

  it('returns the source for a key the map holds', () => {
    expect(sourceForApiKey(keyMap, 'sk_real')).toBe('engine')
  })

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'])(
    'refuses %s, which only exists on Object.prototype',
    (name) => {
      expect(sourceForApiKey(keyMap, name)).toBeNull()
    }
  )

  it('refuses an unknown key', () => {
    expect(sourceForApiKey(keyMap, 'sk_unknown')).toBeNull()
  })

  it('refuses a key mapped to an empty or non-string source', () => {
    expect(sourceForApiKey(keyMap, 'sk_blank')).toBeNull()
    expect(sourceForApiKey(keyMap, 'sk_number')).toBeNull()
  })
})
