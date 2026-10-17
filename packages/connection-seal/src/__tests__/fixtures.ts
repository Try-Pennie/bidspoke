/**
 * Keys for the connection seal tests, generated in memory on every run (#2333).
 *
 * No private key is ever committed to this package, not even a throwaway one:
 * the no private key material scan in keys.test.ts would refuse it, and a
 * committed test key is one paste away from being used for real.
 */

export interface PemPair {
  publicPem: string
  privatePem: string
  /** The private half as a JWK, for the scanner's positive control. */
  privateJwk: JsonWebKey
}

function base64(bytes: ArrayBuffer): string {
  let binary = ''
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** Wraps DER in a PEM block, 64 characters a line, as openssl writes it. */
export function toPem(der: ArrayBuffer, label: string): string {
  const body = base64(der).match(/.{1,64}/g)!.join('\n')
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

export async function rsaPair(modulusLength: number): Promise<PemPair> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  )
  return {
    publicPem: toPem(await crypto.subtle.exportKey('spki', pair.publicKey), 'PUBLIC KEY'),
    privatePem: toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY'),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  }
}

/** An elliptic curve pair: a real key, of the wrong family. */
export async function ecPair(): Promise<Omit<PemPair, 'privateJwk'>> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  return {
    publicPem: toPem(await crypto.subtle.exportKey('spki', pair.publicKey), 'PUBLIC KEY'),
    privatePem: toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY'),
  }
}

/** RSA generation at 4096 bits takes a second or two, so a file makes each pair once. */
export const KEYGEN_TIMEOUT_MS = 120_000
