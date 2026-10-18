import { fromBase64, modulusBits } from './bytes'
import { SealError } from './errors'

/**
 * Importing the ops key pair, with every way a key can be wrong refused by
 * name at import (#2333).
 *
 * The private key reaches the ops Worker as a secret someone pasted, and the
 * public keys reach this package as text someone committed, so each is checked
 * for what it actually is before it is used: one PEM block, of the right kind
 * (a public key is never accepted where a private one belongs, or the reverse),
 * of the RSA family, at least MIN_MODULUS_BITS long. A key that fails is
 * refused loudly here rather than producing envelopes nobody can open later.
 *
 * Formats are the ones `openssl genpkey` and `openssl pkey -pubout` write:
 * PKCS#8 ("PRIVATE KEY") and SubjectPublicKeyInfo ("PUBLIC KEY"). Web Crypto
 * cannot import the older PKCS#1 form, so it is refused with the conversion
 * named.
 */

export const MIN_MODULUS_BITS = 4096

/** RSA-OAEP with SHA-256 wraps the per seal AES-256-GCM key. */
export const RSA_OAEP = { name: 'RSA-OAEP', hash: 'SHA-256' } as const

type KeyKind = 'public' | 'private'

const PEM_BLOCK = /^-----BEGIN ([A-Z0-9 ]+)-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n?-----END \1-----$/

const LABELS: Record<KeyKind, string> = { public: 'PUBLIC KEY', private: 'PRIVATE KEY' }

/** rsaEncryption, 1.2.840.113549.1.1.1, as DER content bytes. */
const RSA_ENCRYPTION_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]

function malformed(kind: KeyKind, detail: string): never {
  throw new SealError('seal_key_malformed', `the ${kind} key ${detail}`)
}

function decodePem(pem: string, kind: KeyKind): Uint8Array<ArrayBuffer> {
  if (typeof pem !== 'string' || pem.trim() === '') malformed(kind, 'is empty')
  const match = PEM_BLOCK.exec(pem.trim())
  if (!match) malformed(kind, 'is not a single PEM block')
  const label = match[1]
  const otherKind: KeyKind = kind === 'public' ? 'private' : 'public'
  if (label.includes(kind === 'public' ? 'PRIVATE' : 'PUBLIC')) {
    throw new SealError('seal_key_wrong_kind', `a ${otherKind} key was given where the ${kind} key belongs`)
  }
  if (label === `RSA ${LABELS[kind]}`) {
    malformed(kind, `is PKCS#1 ("${label}"); convert it with \`openssl pkey\`, which writes "${LABELS[kind]}"`)
  }
  if (label !== LABELS[kind]) malformed(kind, `is a "${label}" block, not "${LABELS[kind]}"`)
  const der = fromBase64(match[2].replace(/[\r\n]/g, ''))
  if (!der) malformed(kind, 'body is not base64')
  return der
}

interface Tlv {
  tag: number
  start: number
  end: number
}

/** Reads one DER tag, length and value at offset, refusing any that runs past its container. */
function readTlv(der: Uint8Array, offset: number, limit: number, kind: KeyKind): Tlv {
  if (offset + 2 > limit) malformed(kind, 'DER ends early')
  const tag = der[offset]
  let length = der[offset + 1]
  let start = offset + 2
  if (length & 0x80) {
    const count = length & 0x7f
    if (count === 0 || count > 4 || start + count > limit) malformed(kind, 'DER has a bad length')
    length = 0
    for (let i = 0; i < count; i++) length = length * 256 + der[start + i]
    start += count
  }
  const end = start + length
  if (end > limit) malformed(kind, 'DER is cut short')
  return { tag, start, end }
}

/**
 * The algorithm OID inside a SubjectPublicKeyInfo or a PKCS#8 PrivateKeyInfo,
 * read before Web Crypto sees the key so that a key of another family is named
 * as such, not reported as unreadable.
 */
function algorithmOid(der: Uint8Array, kind: KeyKind): Uint8Array {
  const outer = readTlv(der, 0, der.length, kind)
  if (outer.tag !== 0x30 || outer.end !== der.length) malformed(kind, 'DER is not one SEQUENCE')
  let cursor = outer.start
  if (kind === 'private') {
    const version = readTlv(der, cursor, outer.end, kind)
    if (version.tag !== 0x02) malformed(kind, 'DER has no PKCS#8 version')
    cursor = version.end
  }
  const algorithm = readTlv(der, cursor, outer.end, kind)
  if (algorithm.tag !== 0x30) malformed(kind, 'DER has no algorithm identifier')
  const oid = readTlv(der, algorithm.start, algorithm.end, kind)
  if (oid.tag !== 0x06) malformed(kind, 'DER has no algorithm OID')
  return der.subarray(oid.start, oid.end)
}

async function importKey(pem: string, kind: KeyKind): Promise<CryptoKey> {
  const der = decodePem(pem, kind)
  const oid = algorithmOid(der, kind)
  if (oid.length !== RSA_ENCRYPTION_OID.length || RSA_ENCRYPTION_OID.some((b, i) => oid[i] !== b)) {
    throw new SealError('seal_key_not_rsa', `the ${kind} key is not an RSA key`)
  }
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey(kind === 'public' ? 'spki' : 'pkcs8', der, RSA_OAEP, false, [
      kind === 'public' ? 'encrypt' : 'decrypt',
    ])
  } catch {
    // The platform's message is dropped on purpose: it is not ours to promise
    // it never echoes input.
    malformed(kind, 'did not import as an RSA-OAEP key')
  }
  const bits = modulusBits(key)
  if (bits < MIN_MODULUS_BITS) {
    throw new SealError('seal_key_too_small', `the ${kind} key is ${bits} bits, and must be at least ${MIN_MODULUS_BITS}`)
  }
  return key
}

/** Imports an ops public key (SPKI PEM) for sealing only. */
export function importPublicKey(pem: string): Promise<CryptoKey> {
  return importKey(pem, 'public')
}

/** Imports an ops private key (PKCS#8 PEM) for opening only. It can never be exported again. */
export function importPrivateKey(pem: string): Promise<CryptoKey> {
  return importKey(pem, 'private')
}
