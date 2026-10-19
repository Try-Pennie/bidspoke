import { rsaModulusOf } from './key-import'
import type { KeyRing } from './seal'

/**
 * The ops private keys by kid, built from secrets that carry no kid (#2333).
 *
 * The ops Worker holds OPS_CONNECTIONS_PRIVATE_KEY and, during a rotation only,
 * OPS_CONNECTIONS_PRIVATE_KEY_NEXT. Which kid each opens moves as the rotation
 * moves (docs/disaster-recovery.md, rotating the ops private key): in step 3 the
 * new kid is current while its key is still held in NEXT, and in step 4 the two
 * secrets briefly hold the same key. So no secret is assumed to hold any kid:
 * each committed kid gets the first held key whose RSA modulus is the modulus
 * of that kid's public key, which only its own private half shares.
 *
 * A kid no held key matches is left out, so opening under it is refused by name
 * (seal_unknown_kid) rather than tried with a key that cannot open it. A key
 * that cannot be read is skipped, never thrown: the ring is built on every
 * request that may open a login, and the minute key check
 * (apps/worker/src/ops/connection-key.ts) is what names a key that is unset,
 * unreadable or opens nothing. A modulus match is not proof the key opens (that
 * is the check's real decrypt); it only decides which kid a key is tried for.
 *
 * Synchronous and without Web Crypto: two DER reads per key, so it costs
 * nothing on the paths that build it.
 */
export function privateKeyRing(privatePems: readonly string[], publicKeys: KeyRing): KeyRing {
  const held: { pem: string; modulus: string }[] = []
  for (const pem of privatePems) {
    if (typeof pem !== 'string' || pem.trim() === '') continue
    try {
      held.push({ pem, modulus: hex(rsaModulusOf(pem, 'private')) })
    } catch {
      // Unreadable: the minute key check names it.
    }
  }
  const ring: Record<string, string> = {}
  for (const kid of Object.keys(publicKeys)) {
    let modulus: string
    try {
      modulus = hex(rsaModulusOf(publicKeys[kid], 'public'))
    } catch {
      continue
    }
    const match = held.find((k) => k.modulus === modulus)
    if (match) ring[kid] = match.pem
  }
  return Object.freeze(ring)
}

function hex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}
