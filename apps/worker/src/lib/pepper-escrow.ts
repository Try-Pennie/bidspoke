/**
 * One-time escrow of SSN_HASH_PEPPER (#384).
 *
 * The pepper turns an SSN into the hash the execution archive stores as its
 * erasure resolver (#927), so it can never be rotated: a new value would leave
 * every archived record unfindable by SSN. Cloudflare cannot return a secret's
 * value, and until 2026-09-28 no other copy existed. So the worker seals it once,
 * with RSA-OAEP (SHA-256), to the public key below, whose private half was
 * generated on Dan's Mac and never left it. The ciphertext is useless to anybody
 * else, which is why the route that returns it needs no more than an admin login.
 *
 * The canary hash is the engine's own hashSsn of a value that cannot be a real
 * SSN. The escrowed copy is proved correct by computing the same hash from it,
 * so the pepper itself is never compared, printed or pasted anywhere.
 */
import { hashSsn } from '../engine/persons-crypto'

/** SPKI, base64. The matching private key is held offline by Dan. */
export const PEPPER_ESCROW_PUBLIC_KEY = 'MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAukqnmQL8E3NMrnPCJ7Yj7kPKb7AQT+E7H3tbNL/sAcxBD4konziU4UXFYBkOlQDl8Ubr713/Q14sc2257fNV+EGXO3Jd1nVOLjC8A0UtHeeqjebJoUM9X5Zv0BhXXsWdgkwITnDm+nEZLVDGiiS3yn5Yat9550RIcHv8EGXOnsxFesZlEPTZYX84fbxfpKbYGy04UwzlXFIRSX/pSgUXVl0TnkGLCeJ/3opzWoxP5JmlF23gBpftV5nSQntn9XGzZ8HbkBWJ3jADyOutcbcmvwN5qUquoaGrQi6baTJ2zneQevvZgbnUDqSS4Z6uvTvvAWFan65H9IbEuJ5PpldSNu3GM1QxZMYF/Cli8LtkvJ40Nkutf/tx4ED1ajedJ+ZZffQNjDAXaev7/IEdxQh4R4k+fcpLLLECj9USreKkex1OjdzMc8TRmAMJhrE+Vpo3T5m506OC0sO3L6bCAt//AbHWlq5NDHGVwy2oD4/eSK++VzlWIAqWkJRIiw65qLPnj09KKBJzDQaEXjJsk5E61MU6gY8RqXUm4QO5YiPFundRrc6YqhN/pDVfB5EKJl/EtaaoFED9YnjHsAGDdrKZxeWpFAJk7wG8c6dCQ+mmsZl/eN80N8zZibOHySpudxwyzoxXWL3vA/ZVFVf7o1Esp0AO6KvKOTH2dZ1eX5tcIesCAwEAAQ=='

/** Nine zeros is never issued as an SSN. */
export const PEPPER_ESCROW_CANARY = '000-00-0000'

export interface SealedPepper {
  algorithm: 'RSA-OAEP-SHA256'
  ciphertext: string
  canaryHash: string
}

export async function sealPepper(pepper: string, publicSpkiB64: string = PEPPER_ESCROW_PUBLIC_KEY): Promise<SealedPepper> {
  if (!pepper) throw new Error('SSN_HASH_PEPPER is not set, so there is nothing to escrow')
  const spki = Uint8Array.from(atob(publicSpkiB64), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'])
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(pepper)))
  return {
    algorithm: 'RSA-OAEP-SHA256',
    ciphertext: btoa(String.fromCharCode(...sealed)),
    canaryHash: await hashSsn(PEPPER_ESCROW_CANARY, pepper),
  }
}
