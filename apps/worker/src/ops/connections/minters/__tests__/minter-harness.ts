/**
 * Doubles for the minters (#2335): a token endpoint that records what it was
 * sent and answers from a queue, an RSA signing key made on every run (no key
 * is ever committed), and the ServiceRules a catalogue entry would build from
 * a minter plus its declared hosts.
 */
import type { MinterRules, ServiceRules } from '../../service-rules'

export interface TokenCall {
  url: string
  method: string
  body: URLSearchParams
  headers: Headers
  redirect: RequestInit['redirect']
}

export type TokenAnswer = Response | Error | 'hang'

export interface TokenEndpoint {
  calls: TokenCall[]
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  /** Replace what the next token requests answer, in order; the last repeats. */
  respond: (...answers: TokenAnswer[]) => void
}

export function tokenEndpoint(...initial: TokenAnswer[]): TokenEndpoint {
  let answers: TokenAnswer[] = initial.length > 0 ? initial : [Response.json({ access_token: 'unset' })]
  const calls: TokenCall[] = []
  return {
    calls,
    respond: (...a) => {
      answers = a
    },
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: new URLSearchParams(String(init?.body ?? '')),
        headers: new Headers(init?.headers),
        redirect: init?.redirect,
      })
      const answer = answers.length > 1 ? answers.shift()! : answers[0]
      if (answer === 'hang') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      if (answer instanceof Error) throw answer
      return answer.clone()
    },
  }
}

/** A catalogue entry's rules: the minter's auth and expiry, with test hosts. */
export function rulesOf(service: string, minter: MinterRules, hosts: (target: unknown) => readonly string[]): ServiceRules {
  return { service, declaredHosts: (target) => hosts(target), ...minter }
}

function base64(bytes: ArrayBuffer): string {
  let binary = ''
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b)
  return btoa(binary)
}

export interface SigningKey {
  /** PKCS#8 PEM, as a Snowflake key pair or a Google service account key carries it. */
  pem: string
  publicKey: CryptoKey
}

/** A 2048 bit RSASSA key, made per test file. */
export async function makeSigningKey(): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const der = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer
  return { pem: `-----BEGIN PRIVATE KEY-----\n${base64(der).match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey }
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** A compact JWT's header and payload, and whether its RS256 signature verifies under `publicKey`. */
export async function readJwt(jwt: string, publicKey: CryptoKey): Promise<{ header: Record<string, unknown>; payload: Record<string, unknown>; verified: boolean }> {
  const [h, p, s] = jwt.split('.')
  const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as Record<string, unknown>
  const verified = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, publicKey, fromBase64Url(s), new TextEncoder().encode(`${h}.${p}`))
  return { header: decode(h), payload: decode(p), verified }
}
