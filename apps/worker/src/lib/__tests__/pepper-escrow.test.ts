/**
 * Sealing SSN_HASH_PEPPER for its one-time copy into escrow (#384).
 *
 * The pepper cannot be rotated (every stored SSN hash would stop matching) and
 * Cloudflare cannot return a secret's value, so the worker hands it over once,
 * encrypted to a public key whose private half never leaves Dan's Mac. What is
 * returned must be useless without that private key, must open to exactly the
 * pepper, and must carry a check value that proves the escrowed copy is right
 * without anybody comparing the pepper itself.
 */
import { describe, it, expect } from 'vitest'
import { PEPPER_ESCROW_CANARY, PEPPER_ESCROW_PUBLIC_KEY, sealPepper } from '../pepper-escrow'
import { hashSsn } from '../../engine/persons-crypto'

async function keyPair() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  )) as CryptoKeyPair
  const spki = new Uint8Array((await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer)
  return { privateKey: pair.privateKey, publicSpkiB64: btoa(String.fromCharCode(...spki)) }
}

async function open(ciphertextB64: string, privateKey: CryptoKey): Promise<string> {
  const bytes = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, bytes))
}

describe('sealPepper', () => {
  it('returns ciphertext that the private key opens to exactly the pepper', async () => {
    const { privateKey, publicSpkiB64 } = await keyPair()
    const sealed = await sealPepper('the-pepper-value', publicSpkiB64)
    expect(await open(sealed.ciphertext, privateKey)).toBe('the-pepper-value')
  })

  it('never returns the pepper in the clear', async () => {
    const { publicSpkiB64 } = await keyPair()
    const sealed = await sealPepper('the-pepper-value', publicSpkiB64)
    expect(JSON.stringify(sealed)).not.toContain('the-pepper-value')
    expect(JSON.stringify(sealed)).not.toContain(btoa('the-pepper-value'))
  })

  it('returns the canary hash the engine itself would compute, so a copy can be checked', async () => {
    const { publicSpkiB64 } = await keyPair()
    const sealed = await sealPepper('the-pepper-value', publicSpkiB64)
    expect(sealed.canaryHash).toBe(await hashSsn(PEPPER_ESCROW_CANARY, 'the-pepper-value'))
    // A different pepper gives a different check value, so a wrong copy is caught.
    expect(sealed.canaryHash).not.toBe(await hashSsn(PEPPER_ESCROW_CANARY, 'another-pepper'))
  })

  it('cannot be opened with a different private key', async () => {
    const sealer = await keyPair()
    const stranger = await keyPair()
    const sealed = await sealPepper('the-pepper-value', sealer.publicSpkiB64)
    await expect(open(sealed.ciphertext, stranger.privateKey)).rejects.toThrow()
  })

  it('refuses an empty pepper rather than escrowing nothing', async () => {
    const { publicSpkiB64 } = await keyPair()
    await expect(sealPepper('', publicSpkiB64)).rejects.toThrow(/not set/)
  })

  it('ships a real 4096 bit RSA public key, and seals with it by default', async () => {
    const key = await crypto.subtle.importKey(
      'spki',
      Uint8Array.from(atob(PEPPER_ESCROW_PUBLIC_KEY), (c) => c.charCodeAt(0)),
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      true,
      ['encrypt'],
    )
    expect((key.algorithm as { modulusLength: number }).modulusLength).toBe(4096)
    const sealed = await sealPepper('p')
    expect(atob(sealed.ciphertext).length).toBe(512)
  })
})
