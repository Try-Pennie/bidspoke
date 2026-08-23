// AES-GCM encryption + peppered SHA-256 hashing.
// AES-GCM uses SECRET_ENCRYPTION_KEY (shared with secret-crypto.ts).
// Peppered SHA-256 uses SSN_HASH_PEPPER.
//
// THIS FILE IS NOT DORMANT, whatever older notes say (#977). It was described
// that way after #765 removed the `persons` writer, kept only so a future
// reveal-PII surface would be cheap to re-enable. That stopped being true when
// the execution archive started using it:
//
//   hashSsn   -> lib/execution-archive.ts, on the live hourly archive path.
//                It writes the archive's ONLY person resolver (#927), and after
//                A5 (#873) removes the Postgres source, a row archived without
//                one can never be given one. An erasure request would then find
//                nothing, months later, with nothing having reported a problem.
//   formatSsn -> engine/index.ts and routes/api/admin.ts, on the live sightings
//                path.
//
// So the next dead-code sweep must not read "dormant" as permission to delete
// this. encryptPii and decryptPii genuinely have no live caller and are the only
// part kept for a future reveal surface.

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

// Expects the raw iv||ciphertext bytes encryptPii produced.
//
// RESOLVED(#90) by #765: the writer that produced the mismatched rows is gone. It
// base64'd the bytes before insert, and PostgREST wrote that string into BYTEA
// without a \x prefix, so the column held the ASCII bytes of the base64 string
// and this function could not round-trip a stored row. Nothing writes persons
// now, so no new rows can be in that format. If persons is ever revived as a
// readable store, write proper \x-hex bytea at the new write site.
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
