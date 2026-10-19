import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { CURRENT_OPS_KID, importPublicKey, KID_PATTERN, OPS_CONNECTION_PUBLIC_KEYS, SealError } from '../index'
import { ecPair, KEYGEN_TIMEOUT_MS, rsaPair, type PemPair } from './fixtures'

/**
 * The public key registry, and the rule that no private key ever lives in this
 * package (#2333).
 *
 * The public keys are a code constant so their integrity comes from review: a
 * key fetched from ops at seal time could be swapped. That makes this package
 * the one place a careless paste could also put the PRIVATE half, which would
 * hand every ops login to anyone who can read the repository. So the registry
 * is checked key by key, and every file in the package is scanned for private
 * key material in each form it is written in.
 *
 * Both checks are proven against planted bad input in this file on every run,
 * because the real registry is empty until the key is generated and an empty
 * registry passes any check (L1, L98).
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Problems with a registry, one sentence each. Empty means it is sound. */
async function registryProblems(registry: Readonly<Record<string, string>>, currentKid: string | null): Promise<string[]> {
  const problems: string[] = []
  for (const [kid, pem] of Object.entries(registry)) {
    if (!KID_PATTERN.test(kid)) problems.push(`kid ${kid} does not match ${String(KID_PATTERN)}`)
    try {
      const key = await importPublicKey(pem)
      const algorithm = key.algorithm as RsaHashedKeyAlgorithm
      if (algorithm.name !== 'RSA-OAEP') problems.push(`kid ${kid} imports as ${algorithm.name}, not RSA-OAEP`)
      if (algorithm.modulusLength < 4096) problems.push(`kid ${kid} is ${algorithm.modulusLength} bits`)
    } catch (err) {
      if (!(err instanceof SealError)) throw err
      problems.push(`kid ${kid} does not import: ${err.code}`)
    }
  }
  const bodies = Object.values(registry).map((pem) => pem.replace(/\s|-----[A-Z ]+-----/g, ''))
  if (new Set(bodies).size !== bodies.length) problems.push('one public key is registered under two kids')
  const kids = Object.keys(registry)
  for (const shorter of kids) {
    for (const longer of kids) {
      if (longer !== shorter && longer.startsWith(shorter)) problems.push(`kid ${shorter} is a prefix of kid ${longer}`)
    }
  }
  if (currentKid !== null && !Object.hasOwn(registry, currentKid)) problems.push(`the current kid ${currentKid} is not registered`)
  if (currentKid === null && Object.keys(registry).length > 0) problems.push('keys are registered but no kid is current')
  return problems
}

describe('the public key registry', () => {
  let strong: PemPair
  let weak: PemPair
  let ecPublic: string
  let other: string

  beforeAll(async () => {
    ;[strong, weak] = await Promise.all([rsaPair(4096), rsaPair(2048)])
    ecPublic = (await ecPair()).publicPem
    // A second sound 4096 bit public key that costs no key generation: one
    // the registry already holds.
    other = Object.values(OPS_CONNECTION_PUBLIC_KEYS)[0]
  }, KEYGEN_TIMEOUT_MS)

  it('holds only RSA-OAEP public keys of at least 4096 bits, under well formed kids', async () => {
    expect(await registryProblems(OPS_CONNECTION_PUBLIC_KEYS, CURRENT_OPS_KID)).toEqual([])
  })

  it('accepts a sound planted registry, so the check is not refusing everything', async () => {
    expect(await registryProblems({ 'ops-2026-10': strong.publicPem }, 'ops-2026-10')).toEqual([])
  })

  it.each([
    ['a 2048 bit key', () => ({ 'ops-2026-10': weak.publicPem }), /does not import: seal_key_too_small/],
    ['an elliptic curve key', () => ({ 'ops-2026-10': ecPublic }), /does not import: seal_key_not_rsa/],
    ['the private half pasted in', () => ({ 'ops-2026-10': strong.privatePem }), /does not import: seal_key_wrong_kind/],
    ['a kid with spaces', () => ({ 'ops key': strong.publicPem }), /does not match/],
    [
      'one key under two kids',
      () => ({ 'ops-2026-10': strong.publicPem, 'ops-2027-01': strong.publicPem }),
      /registered under two kids/,
    ],
  ])('flags a planted registry holding %s', async (_label, registry, problem) => {
    const problems = await registryProblems(registry(), 'ops-2026-10')
    expect(problems.join('\n')).toMatch(problem)
  })

  // A kid that begins another kid lets a test matching a message by the
  // shorter kid pass against the longer one: ops-2026-10 and ops-2026-10-19
  // were both registered during the practice rotation, and two tests passed
  // against the wrong kid (#2509). Two distinct keys, so the duplicate key
  // check cannot be what fires.
  it('flags a planted registry where one kid is a prefix of another', async () => {
    const problems = await registryProblems(
      { 'ops-2026-10': strong.publicPem, 'ops-2026-10-19': other },
      'ops-2026-10-19',
    )
    expect(problems).toEqual(['kid ops-2026-10 is a prefix of kid ops-2026-10-19'])
  })

  it('accepts a sound planted registry of two kids where neither is a prefix of the other', async () => {
    expect(await registryProblems({ 'ops-2026-10-19': other, 'ops-2027-01-05': strong.publicPem }, 'ops-2027-01-05')).toEqual([])
  })

  it('flags a current kid that is not registered, and keys with no current kid', async () => {
    expect(await registryProblems({}, 'ops-2026-10')).toEqual(['the current kid ops-2026-10 is not registered'])
    // A kid every object answers to through its prototype is still not registered.
    expect(await registryProblems({}, 'constructor')).toEqual(['the current kid constructor is not registered'])
    expect(await registryProblems({ 'ops-2026-10': strong.publicPem }, null)).toEqual([
      'keys are registered but no kid is current',
    ])
  })
})

// The needles are assembled at run time so that this file, which the scan
// also reads, does not itself contain what it looks for.
const PEM_PRIVATE_HEADER = new RegExp('-{5}BEGIN [A-Z ]*' + 'PRIVATE' + ' KEY-{5}')
const JWK_PRIVATE_EXPONENT = new RegExp('["\']?\\b' + 'd' + '["\']?\\s*:\\s*["\'][A-Za-z0-9_-]{40,}')
const BASE64_RUN = /[A-Za-z0-9+/=\n\r]{200,}/g

/**
 * The DER a private key starts with, whatever its PEM header says or if it has
 * none: PKCS#8 (SEQUENCE, then INTEGER 0, then SEQUENCE) and PKCS#1 (SEQUENCE,
 * then INTEGER 0, then INTEGER). A public key's DER has no version INTEGER.
 */
function looksLikePrivateDer(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0x30) return false
  const lengthBytes = bytes[1] & 0x80 ? (bytes[1] & 0x7f) + 2 : 2
  const v = bytes.subarray(lengthBytes)
  return v[0] === 0x02 && v[1] === 0x01 && v[2] === 0x00 && (v[3] === 0x30 || v[3] === 0x02)
}

/** Every form of private key material in some text, one reason each. */
function privateKeyMaterial(text: string): string[] {
  const found: string[] = []
  if (PEM_PRIVATE_HEADER.test(text)) found.push('a private key PEM header')
  if (JWK_PRIVATE_EXPONENT.test(text)) found.push('a JWK private exponent member')
  for (const run of text.match(BASE64_RUN) ?? []) {
    const compact = run.replace(/[\n\r]/g, '')
    const usable = compact.slice(0, compact.length - (compact.length % 4))
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(atob(usable), (c) => c.charCodeAt(0))
    } catch {
      continue
    }
    if (looksLikePrivateDer(bytes)) {
      found.push('base64 private key DER with no header')
      break
    }
  }
  return found
}

function packageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? packageFiles(path) : [path]
  })
}

describe('no private key material anywhere in the package', () => {
  let pair: PemPair

  beforeAll(async () => {
    pair = await rsaPair(4096)
  }, KEYGEN_TIMEOUT_MS)

  it('finds the files it scans, so it cannot pass by reading nothing', () => {
    const files = packageFiles(PACKAGE_ROOT).map((f) => relative(PACKAGE_ROOT, f))
    expect(files).toEqual(expect.arrayContaining(['package.json', 'src/keys.ts', 'src/__tests__/keys.test.ts']))
  })

  it('finds none in any file', () => {
    const offenders = packageFiles(PACKAGE_ROOT)
      .map((file) => ({ file: relative(PACKAGE_ROOT, file), found: privateKeyMaterial(readFileSync(file, 'utf8')) }))
      .filter(({ found }) => found.length > 0)
    expect(offenders).toEqual([])
  })

  it('would see a private key pasted as PEM', () => {
    expect(privateKeyMaterial(`export const K = \`${pair.privatePem}\``)).toContain('a private key PEM header')
  })

  it('would see a PKCS#1 PEM, as older openssl writes it', () => {
    const relabelled = pair.privatePem.replace(/PRIVATE KEY/g, 'RSA PRIVATE KEY')
    expect(privateKeyMaterial(relabelled)).toContain('a private key PEM header')
  })

  it('would see a private key pasted with its header lines stripped', () => {
    const body = pair.privatePem.split('\n').filter((line) => line && !line.startsWith('-----')).join('\n')
    expect(privateKeyMaterial(`const K = '${body}'`)).toEqual(['base64 private key DER with no header'])
  })

  it('would see a private key pasted as a JWK, quoted or as a code object', () => {
    expect(privateKeyMaterial(JSON.stringify(pair.privateJwk))).toContain('a JWK private exponent member')
    expect(privateKeyMaterial(`const k = { kty: 'RSA', d: '${String(pair.privateJwk.d)}' }`)).toContain(
      'a JWK private exponent member',
    )
  })

  it('does not mistake a public key for a private one, in any form', async () => {
    const publicJwk = await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey(
      'spki',
      Uint8Array.from(atob(pair.publicPem.replace(/-----[A-Z ]+-----|\s/g, '')), (c) => c.charCodeAt(0)),
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      true,
      ['encrypt'],
    ))
    const publicBody = pair.publicPem.split('\n').filter((line) => line && !line.startsWith('-----')).join('\n')
    expect(privateKeyMaterial(pair.publicPem)).toEqual([])
    expect(privateKeyMaterial(publicBody)).toEqual([])
    expect(privateKeyMaterial(JSON.stringify(publicJwk))).toEqual([])
  })

  it('reads a DER length in short form as well as the long form real keys use', () => {
    expect(looksLikePrivateDer(new Uint8Array([0x30, 0x05, 0x02, 0x01, 0x00, 0x30, 0x00]))).toBe(true)
    expect(looksLikePrivateDer(new Uint8Array([0x30, 0x05, 0x30, 0x0d, 0x06, 0x09, 0x2a]))).toBe(false)
  })
})
