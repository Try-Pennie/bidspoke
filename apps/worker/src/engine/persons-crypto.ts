// AES-GCM encryption + peppered SHA-256 hashing for the persons table.
// AES-GCM uses SECRET_ENCRYPTION_KEY (shared with secret-crypto.ts).
// Peppered SHA-256 uses SSN_HASH_PEPPER for indexed dedup lookups.

const PEPPER_SEPARATOR = ':'

async function importAesKey(keyB64: string): Promise<CryptoKey> {
  const keyBytes = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0))
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

// Encrypts a string to a Uint8Array (BYTEA-compatible).
// Layout: iv[12] || ciphertext.
export async function encryptPii(plaintext: string, keyB64: string): Promise<Uint8Array> {
  const key = await importAesKey(keyB64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  const out = new Uint8Array(12 + ciphertext.byteLength)
  out.set(iv)
  out.set(new Uint8Array(ciphertext), 12)
  return out
}

export async function decryptPii(encrypted: Uint8Array, keyB64: string): Promise<string> {
  const key = await importAesKey(keyB64)
  const iv = encrypted.slice(0, 12)
  const ciphertext = encrypted.slice(12)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new TextDecoder().decode(plaintext)
}

// Peppered SHA-256 of a normalized SSN. Returns lowercase hex.
// Pepper is concatenated with a fixed separator so an attacker who learns the
// pepper can't trivially rainbow-table arbitrary 9-digit strings.
export async function hashSsn(ssn: string, pepper: string): Promise<string> {
  const normalized = ssn.replace(/\D/g, '')
  const input = `${pepper}${PEPPER_SEPARATOR}${normalized}`
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Format a 9-digit SSN as XXX-XX-XXXX. Pass-through if already formatted.
export function formatSsn(ssn: string): string {
  const digits = ssn.replace(/\D/g, '')
  if (digits.length !== 9) return ssn
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
}
