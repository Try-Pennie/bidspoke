/**
 * AES-GCM encryption for secret env var values.
 * Uses the SECRET_ENCRYPTION_KEY Worker secret (base64-encoded 32-byte key).
 *
 * Format: base64(iv[12] || ciphertext)
 *
 * Rotation (#384). The engine decrypts every secret on every run, so the key is
 * never swapped in one step. SECRET_ENCRYPTION_KEY_NEXT is set first: while it is
 * set, writes are locked with it and reads accept either key, the stored rows are
 * re-locked in place (POST /api/admin/reencrypt-secrets), and only then is the
 * primary set to the same value and NEXT removed. Nothing fails to decrypt at any
 * point. Call sites pass `secretKeys(env)`, never the raw key.
 */

/** The keys a call may use: one to lock with, and every key a read may try. */
export interface SecretKeys {
  encryptWith: string
  decryptWith: string[]
}

/** A single key string, or the ring from `secretKeys(env)`. */
export type SecretKeyInput = string | SecretKeys

export function secretKeys(env: { SECRET_ENCRYPTION_KEY: string; SECRET_ENCRYPTION_KEY_NEXT?: string }): SecretKeys {
  const primary = env.SECRET_ENCRYPTION_KEY
  const next = env.SECRET_ENCRYPTION_KEY_NEXT?.trim()
  if (!next || next === primary) return { encryptWith: primary, decryptWith: [primary] }
  return { encryptWith: next, decryptWith: [next, primary] }
}

function ring(keys: SecretKeyInput): SecretKeys {
  return typeof keys === 'string' ? { encryptWith: keys, decryptWith: [keys] } : keys
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const keyBytes = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0))
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptSecret(plaintext: string, keys: SecretKeyInput): Promise<string> {
  const key = await importKey(ring(keys).encryptWith)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  const combined = new Uint8Array(12 + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), 12)
  return btoa(String.fromCharCode(...combined))
}

export async function decryptSecret(encryptedB64: string, keys: SecretKeyInput): Promise<string> {
  const combined = Uint8Array.from(atob(encryptedB64), (c) => c.charCodeAt(0))
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const candidates = ring(keys).decryptWith
  let lastError: unknown
  for (const keyB64 of candidates) {
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await importKey(keyB64), ciphertext)
      return new TextDecoder().decode(plaintext)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}
