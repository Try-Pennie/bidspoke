import { fromBase64, isWellFormed, modulusBits, toBase64, utf8 } from './bytes'
import { canonicalAad, KID_PATTERN, type ConnectionAad } from './canonical-json'
import { SealError } from './errors'
import { importPrivateKey, importPublicKey, RSA_OAEP } from './key-import'

/**
 * Sealing an ops connection login to the ops public key, and opening it with
 * the ops private key (#2333, phase 3 of #1689).
 *
 * Why asymmetric: the bidding Worker receives a login and seals it at once,
 * holding only the public key, so a compromise of the bidding Worker or its
 * database reveals no ops login. The ops Worker holds the private key and no
 * bidding secret, so a compromise of the ops key reveals no bidding secret. A
 * symmetric key that bidding held "write only" cannot be write only, so it was
 * rejected.
 *
 * Each seal makes a fresh AES-256-GCM key and iv, encrypts the login with it,
 * and wraps that key with RSA-OAEP (SHA-256) under the public key named by the
 * binding's kid. The canonical binding is both the GCM additional data and the
 * OAEP label, so an envelope opens only under the exact organization,
 * connection, service, generation and kid it was sealed for.
 *
 * Web Crypto only, so the same code runs in both Workers, the browser and Node.
 */

/** Public or private keys as PEM text, by kid. */
export type KeyRing = Readonly<Record<string, string>>

/** What is stored for a sealed login. Every field is safe to store and log. */
export interface SealedEnvelope {
  v: 1
  kid: string
  /** The per seal AES key, RSA-OAEP wrapped, base64. */
  wrapped_key: string
  /** The 12 byte AES-GCM iv, base64. */
  iv: string
  /** The AES-GCM ciphertext with its 16 byte tag appended, base64. */
  ct: string
}

const ENVELOPE_FIELDS = ['ct', 'iv', 'kid', 'v', 'wrapped_key']
const IV_BYTES = 12
const TAG_BYTES = 16
const AES_KEY_BYTES = 32

function keyFor(ring: KeyRing, kid: string, kind: 'public' | 'private'): string {
  // Own properties only: "constructor" is a well formed kid that every object answers to.
  if (typeof ring !== 'object' || ring === null || !Object.hasOwn(ring, kid)) {
    const held = typeof ring === 'object' && ring !== null ? Object.keys(ring).join(', ') : ''
    throw new SealError('seal_unknown_kid', `no ${kind} key for kid ${kid} (this ring holds: ${held || 'none'})`)
  }
  return ring[kid]
}

function malformed(detail: string): never {
  throw new SealError('seal_envelope_malformed', detail)
}

interface ParsedEnvelope {
  kid: string
  wrappedKey: Uint8Array<ArrayBuffer>
  iv: Uint8Array<ArrayBuffer>
  ct: Uint8Array<ArrayBuffer>
}

/** Checks a stored envelope's shape before any key is touched (L50). */
function parseEnvelope(value: unknown): ParsedEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) malformed('the envelope is not an object')
  const record = value as Record<string, unknown>
  if (record.v !== 1) {
    throw new SealError('seal_envelope_version', `the envelope is version ${String(record.v)}, and this code opens version 1`)
  }
  const fields = Object.keys(record).sort()
  if (fields.join(',') !== ENVELOPE_FIELDS.join(',')) {
    malformed(`the envelope has fields [${fields.join(', ')}], and must have exactly [${ENVELOPE_FIELDS.join(', ')}]`)
  }
  if (typeof record.kid !== 'string' || !KID_PATTERN.test(record.kid)) malformed('the envelope kid is not a kid')
  const decodeField = (field: 'wrapped_key' | 'iv' | 'ct'): Uint8Array<ArrayBuffer> => {
    const value = record[field]
    const bytes = typeof value === 'string' ? fromBase64(value) : null
    if (!bytes) malformed(`the envelope ${field} is not base64`)
    return bytes
  }
  const decoded = { wrapped_key: decodeField('wrapped_key'), iv: decodeField('iv'), ct: decodeField('ct') }
  if (decoded.iv.length !== IV_BYTES) malformed(`the envelope iv is ${decoded.iv.length} bytes, not ${IV_BYTES}`)
  if (decoded.ct.length < TAG_BYTES) malformed('the envelope ct is shorter than its tag')
  return { kid: record.kid, wrappedKey: decoded.wrapped_key, iv: decoded.iv, ct: decoded.ct }
}

/** Seals a login under the public key the binding's kid names. */
export async function seal(publicKeys: KeyRing, plaintext: string, aad: ConnectionAad): Promise<SealedEnvelope> {
  const label = utf8(canonicalAad(aad))
  if (typeof plaintext !== 'string' || !isWellFormed(plaintext)) {
    throw new SealError('seal_plaintext_invalid', 'the plaintext is not text UTF-8 can carry unchanged')
  }
  const publicKey = await importPublicKey(keyFor(publicKeys, aad.kid, 'public'))

  // The content key's bytes come straight from the CSPRNG and are imported for
  // encrypt only, so the key never needs to be extractable, and the same calls
  // type check under the DOM types and the Workers types alike.
  const raw = crypto.getRandomValues(new Uint8Array(AES_KEY_BYTES))
  const contentKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt'])
  try {
    const wrapped = await crypto.subtle.encrypt({ ...RSA_OAEP, label }, publicKey, raw)
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: label, tagLength: TAG_BYTES * 8 },
      contentKey,
      utf8(plaintext),
    )
    return { v: 1, kid: aad.kid, wrapped_key: toBase64(wrapped), iv: toBase64(iv), ct: toBase64(ct) }
  } finally {
    raw.fill(0)
  }
}

/**
 * Opens an envelope with the private key its kid names, under the binding the
 * caller expects. The envelope is untrusted input (it comes from storage), so
 * its shape is checked first, and any change to it or to the binding is
 * refused by the cipher.
 */
export async function open(privateKeys: KeyRing, envelope: unknown, aad: ConnectionAad): Promise<string> {
  const parsed = parseEnvelope(envelope)
  const label = utf8(canonicalAad(aad))
  if (parsed.kid !== aad.kid) {
    throw new SealError('seal_kid_mismatch', `the envelope was sealed under kid ${parsed.kid}, not ${aad.kid}`)
  }
  const privateKey = await importPrivateKey(keyFor(privateKeys, parsed.kid, 'private'))
  const blockBytes = modulusBits(privateKey) / 8
  if (parsed.wrappedKey.length !== blockBytes) {
    malformed(`the envelope wrapped_key is ${parsed.wrappedKey.length} bytes, and kid ${parsed.kid} wraps ${blockBytes}`)
  }

  let raw: Uint8Array<ArrayBuffer>
  try {
    raw = new Uint8Array(await crypto.subtle.decrypt({ ...RSA_OAEP, label }, privateKey, parsed.wrappedKey))
  } catch {
    throw new SealError('seal_unwrap_failed', `the wrapped key did not open under kid ${parsed.kid} for this binding`)
  }
  try {
    if (raw.length !== AES_KEY_BYTES) {
      throw new SealError('seal_unwrap_failed', `the wrapped key opened to ${raw.length} bytes, not ${AES_KEY_BYTES}`)
    }
    const contentKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
    let plaintext: ArrayBuffer
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: parsed.iv, additionalData: label, tagLength: TAG_BYTES * 8 },
        contentKey,
        parsed.ct,
      )
    } catch {
      throw new SealError('seal_decrypt_failed', `the ciphertext did not open under kid ${parsed.kid} for this binding`)
    }
    // ignoreBOM false is the default, spelled out because the Workers types require it.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext)
  } finally {
    raw.fill(0)
  }
}
