/**
 * Each key is imported once, not on every encrypt and decrypt (#2090).
 *
 * The engine decrypts every secret environment variable on every run, and the
 * re-lock route re-encrypts thousands of rows, each call importing the same key
 * again. Under load those imports queue on the same small pool as every other
 * crypto call, which is what made the 1,001 row re-lock test time out under the
 * full suite while passing alone in about 150 ms.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { encryptSecret, decryptSecret } from '../secret-crypto'

const newKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))

afterEach(() => vi.restoreAllMocks())

describe('secret key import', () => {
  it('imports a key once however many values it locks and unlocks', async () => {
    const key = newKey()
    const importKey = vi.spyOn(crypto.subtle, 'importKey')
    const a = await encryptSecret('one', key)
    const b = await encryptSecret('two', key)
    expect(await decryptSecret(a, key)).toBe('one')
    expect(await decryptSecret(b, key)).toBe('two')
    expect(importKey).toHaveBeenCalledTimes(1)
  })

  it('does not keep a failed import, so the next call tries again', async () => {
    const key = newKey()
    const importKey = vi.spyOn(crypto.subtle, 'importKey').mockRejectedValueOnce(new Error('import failed'))
    await expect(encryptSecret('one', key)).rejects.toThrow('import failed')
    const locked = await encryptSecret('one', key)
    expect(await decryptSecret(locked, key)).toBe('one')
    expect(importKey).toHaveBeenCalledTimes(2)
  })

  it('still tells two keys apart', async () => {
    const [k1, k2] = [newKey(), newKey()]
    const locked = await encryptSecret('one', k1)
    await expect(decryptSecret(locked, k2)).rejects.toThrow()
    expect(await decryptSecret(locked, k1)).toBe('one')
  })
})
