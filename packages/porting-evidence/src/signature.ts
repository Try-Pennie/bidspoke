/**
 * The one body signature verifier for porting captures (#1705, LESSONS L19).
 *
 * A Pipedream capture step signs the exact bytes it sends with its workflow's
 * key, and the receiver verifies those bytes before it reads, counts or stores
 * anything. Verification goes through `crypto.subtle.verify`, which compares in
 * constant time, so no caller hand rolls a string comparison of two MACs.
 *
 * Each workflow's key is DERIVED, never stored: HMAC(master, hashid). Pipedream
 * environment variables are workspace wide, so a stored per workflow secret
 * would isolate nothing; deriving lets the receiver hold one master secret and
 * still refuse a signature made with another workflow's key.
 */

export const SIGNATURE_HEADER = 'x-porting-signature'
const VERSION = 'v1='

const encoder = new TextEncoder()

const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

const fromHex = (hex: string): Uint8Array<ArrayBuffer> | null => {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const hmacKey = (raw: Uint8Array, usage: 'sign' | 'verify'): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])

/** HMAC-SHA256(master, label), hex encoded. Shared by key derivation and redaction. */
export async function deriveHexKey(master: string, label: string): Promise<string> {
  const key = await hmacKey(encoder.encode(master), 'sign')
  return toHex(await crypto.subtle.sign('HMAC', key, new Uint8Array(encoder.encode(label))))
}

/** The key one workflow's capture steps sign with, hex encoded. */
export async function deriveWorkflowKey(master: string, hashid: string): Promise<string> {
  if (!master) throw new Error('porting capture master secret is empty')
  if (!hashid) throw new Error('porting capture hashid is empty')
  return deriveHexKey(master, `porting-capture:${hashid}`)
}

/** Signs a body for the capture header. Used by tests and by any Bidspoke side sender. */
export async function signBody(keyHex: string, body: Uint8Array): Promise<string> {
  const raw = fromHex(keyHex)
  if (!raw) throw new Error('porting capture key is not hex')
  const key = await hmacKey(raw, 'sign')
  return VERSION + toHex(await crypto.subtle.sign('HMAC', key, new Uint8Array(body)))
}

/**
 * True only when `signature` is a well formed v1 HMAC of `body` under `keyHex`.
 * Every malformed input is false, never a throw, so a caller cannot fail open
 * by catching an exception and carrying on.
 */
export async function verifyBodySignature(
  keyHex: string,
  body: Uint8Array,
  signature: string | null | undefined,
): Promise<boolean> {
  if (typeof signature !== 'string' || !signature.startsWith(VERSION)) return false
  const mac = fromHex(signature.slice(VERSION.length))
  const raw = fromHex(keyHex)
  if (!mac || mac.length !== 32 || !raw) return false
  const key = await hmacKey(raw, 'verify')
  return crypto.subtle.verify('HMAC', key, mac, new Uint8Array(body))
}
