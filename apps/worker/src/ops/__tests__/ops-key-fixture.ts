/**
 * RSA key pairs for the ops private key tests (#2333), generated in memory on
 * every run and never written anywhere: a committed test key is one paste away
 * from being used for real.
 */

function toPem(der: ArrayBuffer, label: string): string {
  let binary = ''
  for (const b of new Uint8Array(der)) binary += String.fromCharCode(b)
  const body = btoa(binary).match(/.{1,64}/g)!.join('\n')
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

export interface OpsKeyPair {
  /** PKCS#8 PEM, as `openssl genpkey` writes it and the secret holds it. */
  privatePem: string
  /** SPKI PEM, as `openssl pkey -pubout` writes it. */
  publicPem: string
}

export async function opsKeyPair(modulusLength: number): Promise<OpsKeyPair> {
  // The Workers types widen both results to unions; an RSA pair exported as
  // PKCS#8 and SPKI is always a key pair and two ArrayBuffers.
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  )) as CryptoKeyPair
  return {
    privatePem: toPem((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer, 'PRIVATE KEY'),
    publicPem: toPem((await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer, 'PUBLIC KEY'),
  }
}

/** RSA generation at 4096 bits takes a second or two. */
export const KEYGEN_TIMEOUT_MS = 120_000
