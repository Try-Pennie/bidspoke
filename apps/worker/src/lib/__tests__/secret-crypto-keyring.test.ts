/**
 * Rotating SECRET_ENCRYPTION_KEY without a window where secrets go missing (#384).
 *
 * The engine decrypts every secret environment variable on every run
 * (env-loader), so the key cannot simply be swapped: every row locked with the
 * old key would be skipped until each value was re-entered by hand. Instead a
 * second key, SECRET_ENCRYPTION_KEY_NEXT, is set first. While it is set, new
 * writes are locked with NEXT and reads accept either key, so the stored rows
 * can be re-locked in place and the primary then swapped with nothing failing
 * to decrypt at any moment.
 */
import { describe, it, expect } from 'vitest'
import { decryptSecret, encryptSecret, secretKeys } from '../secret-crypto'

function newKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
}

describe('secretKeys', () => {
  it('uses the primary key alone when no next key is set', () => {
    const primary = newKey()
    expect(secretKeys({ SECRET_ENCRYPTION_KEY: primary })).toEqual({ encryptWith: primary, decryptWith: [primary] })
  })

  it('locks with the next key and reads with either while a rotation is under way', () => {
    const primary = newKey()
    const next = newKey()
    expect(secretKeys({ SECRET_ENCRYPTION_KEY: primary, SECRET_ENCRYPTION_KEY_NEXT: next })).toEqual({
      encryptWith: next,
      decryptWith: [next, primary],
    })
  })

  it('treats a blank next key as unset', () => {
    const primary = newKey()
    expect(secretKeys({ SECRET_ENCRYPTION_KEY: primary, SECRET_ENCRYPTION_KEY_NEXT: '  ' })).toEqual({
      encryptWith: primary,
      decryptWith: [primary],
    })
  })

  it('does not list one key twice once the primary has been swapped to the next value', () => {
    const k = newKey()
    expect(secretKeys({ SECRET_ENCRYPTION_KEY: k, SECRET_ENCRYPTION_KEY_NEXT: k })).toEqual({
      encryptWith: k,
      decryptWith: [k],
    })
  })
})

describe('encryptSecret and decryptSecret with a key ring', () => {
  it('reads a value locked with the old key during a rotation', async () => {
    const primary = newKey()
    const next = newKey()
    const old = await encryptSecret('equifax-password', primary)
    expect(await decryptSecret(old, secretKeys({ SECRET_ENCRYPTION_KEY: primary, SECRET_ENCRYPTION_KEY_NEXT: next }))).toBe(
      'equifax-password',
    )
  })

  it('locks a new value with the next key, which the next key alone can read', async () => {
    const primary = newKey()
    const next = newKey()
    const locked = await encryptSecret('scout-key', secretKeys({ SECRET_ENCRYPTION_KEY: primary, SECRET_ENCRYPTION_KEY_NEXT: next }))
    expect(await decryptSecret(locked, next)).toBe('scout-key')
    await expect(decryptSecret(locked, primary)).rejects.toThrow()
  })

  it('still refuses a value no key in the ring can read', async () => {
    const locked = await encryptSecret('x', newKey())
    await expect(decryptSecret(locked, secretKeys({ SECRET_ENCRYPTION_KEY: newKey(), SECRET_ENCRYPTION_KEY_NEXT: newKey() }))).rejects.toThrow()
  })

  it('behaves exactly as before when given a single key string', async () => {
    const k = newKey()
    expect(await decryptSecret(await encryptSecret('v', k), k)).toBe('v')
  })
})
