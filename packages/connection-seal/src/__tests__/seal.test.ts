import { beforeAll, describe, expect, it } from 'vitest'
import {
  canonicalAad,
  importPrivateKey,
  importPublicKey,
  MIN_MODULUS_BITS,
  open,
  seal,
  SealError,
  type ConnectionAad,
  type SealedEnvelope,
  type SealErrorCode,
} from '../index'
import { ecPair, KEYGEN_TIMEOUT_MS, rsaPair, type PemPair } from './fixtures'

/**
 * The seal for ops connection logins (#2333, phase 3 of #1689).
 *
 * Bidding seals a login to the ops PUBLIC key the moment it arrives, and only
 * ops, holding the private key, can open it. Every test here is about one way
 * that promise could quietly break: a binding field that is not really bound,
 * an envelope that opens after tampering, a key rotation that strands the
 * envelopes sealed under the new key, or the login leaking into the envelope.
 */

const CURRENT = 'ops-2026-10'
const NEXT = 'ops-2027-01'

let current: PemPair
let next: PemPair

beforeAll(async () => {
  ;[current, next] = await Promise.all([rsaPair(4096), rsaPair(4096)])
}, KEYGEN_TIMEOUT_MS)

const publicRing = () => ({ [CURRENT]: current.publicPem, [NEXT]: next.publicPem })
const privateRing = () => ({ [CURRENT]: current.privatePem, [NEXT]: next.privatePem })

const binding = (kid = CURRENT): ConnectionAad => ({
  organization_id: '6f1c2c1e-0b7a-4d43-9b8f-2a8b8f0e6c11',
  connection_id: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
  service: 'salesforce',
  generation: 3,
  kid,
})

const LOGIN = JSON.stringify({ client_id: '3MVG9-example', client_secret: 'not-a-real-secret-0123456789' })

async function refusal(promise: Promise<unknown>): Promise<SealError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof SealError) return err
    throw err
  }
  throw new Error('expected a refusal, and it opened')
}

function b64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** Flips one bit in the middle of a base64 field, keeping it valid base64 of the same length. */
function flipBit(field: string): string {
  const bytes = b64ToBytes(field)
  bytes[Math.floor(bytes.length / 2)] ^= 0x01
  return bytesToB64(bytes)
}

describe('seal then open', () => {
  it('round trips a login under the current key', async () => {
    const envelope = await seal(publicRing(), LOGIN, binding())
    expect(await open(privateRing(), envelope, binding())).toBe(LOGIN)
  })

  it('writes the envelope shape the plan names, and nothing else', async () => {
    const envelope = await seal(publicRing(), LOGIN, binding())
    expect(Object.keys(envelope).sort()).toEqual(['ct', 'iv', 'kid', 'v', 'wrapped_key'])
    expect(envelope.v).toBe(1)
    expect(envelope.kid).toBe(CURRENT)
    // A 4096 bit RSA-OAEP block is 512 bytes; AES-GCM's iv is 12 bytes; the
    // ciphertext is the plaintext plus a 16 byte tag.
    expect(b64ToBytes(envelope.wrapped_key)).toHaveLength(512)
    expect(b64ToBytes(envelope.iv)).toHaveLength(12)
    expect(b64ToBytes(envelope.ct)).toHaveLength(new TextEncoder().encode(LOGIN).length + 16)
  })

  it('survives a trip through JSON, which is how it is stored', async () => {
    const stored = JSON.stringify(await seal(publicRing(), LOGIN, binding()))
    expect(await open(privateRing(), JSON.parse(stored), binding())).toBe(LOGIN)
  })

  it('uses a fresh key and iv for every seal, so two seals of one login differ', async () => {
    const a = await seal(publicRing(), LOGIN, binding())
    const b = await seal(publicRing(), LOGIN, binding())
    expect(a.iv).not.toBe(b.iv)
    expect(a.wrapped_key).not.toBe(b.wrapped_key)
    expect(a.ct).not.toBe(b.ct)
  })

  it('round trips text outside ASCII byte for byte', async () => {
    const login = 'pässwörd 鍵 \u{1F511}'
    expect(await open(privateRing(), await seal(publicRing(), login, binding()), binding())).toBe(login)
  })

  it('refuses to seal text that UTF-8 cannot carry, rather than sealing a changed login', async () => {
    // A lone surrogate is silently replaced by U+FFFD on encoding, so the
    // login that opened would not be the login that was saved.
    const err = await refusal(seal(publicRing(), 'abc\ud800def', binding()))
    expect(err.code).toBe('seal_plaintext_invalid')
  })

  it('opens an envelope sealed under NEXT with the NEXT private key', async () => {
    const envelope = await seal(publicRing(), LOGIN, binding(NEXT))
    expect(envelope.kid).toBe(NEXT)
    expect(await open(privateRing(), envelope, binding(NEXT))).toBe(LOGIN)
    // Mid rotation ops may hold only NEXT for a NEXT envelope.
    expect(await open({ [NEXT]: next.privatePem }, envelope, binding(NEXT))).toBe(LOGIN)
  })

  it('does not open a NEXT envelope with the current private key filed under NEXT', async () => {
    const envelope = await seal(publicRing(), LOGIN, binding(NEXT))
    const err = await refusal(open({ [NEXT]: current.privatePem }, envelope, binding(NEXT)))
    expect(err.code).toBe('seal_unwrap_failed')
  })
})

describe('the binding is enforced by the cipher, field by field', () => {
  // Each field is changed on its own to a value that is itself valid, so the
  // refusal can only come from the AAD, not from input validation.
  const changes: Array<[keyof ConnectionAad, string | number]> = [
    ['organization_id', '7a2d3d2f-1c8b-4e54-8c9f-3b9c9f1f7d22'],
    ['connection_id', '0192f3a4-5b6c-7d8e-9f01-23456789abce'],
    ['service', 'snowflake'],
    ['generation', 4],
  ]

  it.each(changes)('refuses to open when %s differs from the one sealed', async (field, value) => {
    const envelope = await seal(publicRing(), LOGIN, binding())
    const err = await refusal(open(privateRing(), envelope, { ...binding(), [field]: value }))
    // The OAEP label is checked first, so the wrapped key is what refuses.
    expect(err.code).toBe('seal_unwrap_failed')
  })

  it.each([...changes, ['kid', NEXT] as [keyof ConnectionAad, string]])(
    'binds %s in the ciphertext on its own too, not only through the wrapped key',
    async (field, value) => {
      // Unwrap the content key by hand under the TRUE binding, then try the
      // ciphertext under a changed one. Without this, dropping the GCM
      // additional data would go unnoticed behind the OAEP label.
      const envelope = await seal(publicRing(), LOGIN, binding())
      const label = new TextEncoder().encode(canonicalAad(binding()))
      const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        b64ToBytes(current.privatePem.replace(/-----[A-Z ]+-----|\s/g, '')),
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['decrypt'],
      )
      const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP', label }, privateKey, b64ToBytes(envelope.wrapped_key))
      const contentKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
      const attempt = (aad: ConnectionAad) =>
        crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: b64ToBytes(envelope.iv), additionalData: new TextEncoder().encode(canonicalAad(aad)) },
          contentKey,
          b64ToBytes(envelope.ct),
        )
      // The positive control: the true binding opens it.
      expect(new TextDecoder().decode(await attempt(binding()))).toBe(LOGIN)
      await expect(attempt({ ...binding(), [field]: value })).rejects.toThrow()
    },
  )

  it('refuses to open when the kid asked for differs from the envelope', async () => {
    const envelope = await seal(publicRing(), LOGIN, binding())
    const err = await refusal(open(privateRing(), envelope, binding(NEXT)))
    expect(err.code).toBe('seal_kid_mismatch')
  })

  it('binds the kid in the cipher too, not only in a check beside it', async () => {
    // Relabel a CURRENT envelope as NEXT, ask for NEXT, and file the CURRENT
    // private key under NEXT, so every check outside the cipher agrees. Only
    // the kid inside the AAD still says CURRENT.
    const envelope = await seal(publicRing(), LOGIN, binding())
    const relabelled = { ...envelope, kid: NEXT }
    const err = await refusal(open({ [NEXT]: current.privatePem }, relabelled, binding(NEXT)))
    expect(err.code).toBe('seal_unwrap_failed')
  })
})

describe('tampering is refused', () => {
  it.each(['ct', 'iv', 'wrapped_key'] as const)('refuses an envelope whose %s has one bit flipped', async (field) => {
    const envelope = await seal(publicRing(), LOGIN, binding())
    const tampered: SealedEnvelope = { ...envelope, [field]: flipBit(envelope[field]) }
    const err = await refusal(open(privateRing(), tampered, binding()))
    expect(['seal_unwrap_failed', 'seal_decrypt_failed']).toContain(err.code)
  })

  it('refuses a ciphertext with its tag cut off', async () => {
    const envelope = await seal(publicRing(), LOGIN, binding())
    const short = bytesToB64(b64ToBytes(envelope.ct).slice(0, -16))
    const err = await refusal(open(privateRing(), { ...envelope, ct: short }, binding()))
    expect(err.code).toBe('seal_decrypt_failed')
  })

  it('refuses a wrapped key moved from another envelope of the same connection', async () => {
    const a = await seal(publicRing(), LOGIN, binding())
    const b = await seal(publicRing(), 'another login', binding())
    const err = await refusal(open(privateRing(), { ...a, wrapped_key: b.wrapped_key }, binding()))
    expect(err.code).toBe('seal_decrypt_failed')
  })
})

describe('kids', () => {
  it('refuses to seal under a kid with no public key, naming it', async () => {
    const err = await refusal(seal(publicRing(), LOGIN, binding('ops-1999-01')))
    expect(err.code).toBe('seal_unknown_kid')
    expect(err.message).toContain('ops-1999-01')
  })

  it('does not find a key on the ring object prototype', async () => {
    // "constructor" is a well formed kid and every object answers to it.
    const err = await refusal(seal(publicRing(), LOGIN, binding('constructor')))
    expect(err.code).toBe('seal_unknown_kid')
  })

  it('refuses to open an envelope whose kid has no private key, naming it', async () => {
    const envelope = await seal(publicRing(), LOGIN, binding(NEXT))
    const err = await refusal(open({ [CURRENT]: current.privatePem }, envelope, binding(NEXT)))
    expect(err.code).toBe('seal_unknown_kid')
    expect(err.message).toContain(NEXT)
  })
})

describe('malformed envelopes are refused by name before any decryption', () => {
  const cases: Array<[string, (e: SealedEnvelope) => unknown, SealErrorCode]> = [
    ['null', () => null, 'seal_envelope_malformed'],
    ['a string', (e) => JSON.stringify(e), 'seal_envelope_malformed'],
    ['version 2', (e) => ({ ...e, v: 2 }), 'seal_envelope_version'],
    ['no version', ({ v: _v, ...rest }) => rest, 'seal_envelope_version'],
    ['no ct', ({ ct: _ct, ...rest }) => rest, 'seal_envelope_malformed'],
    ['an extra field', (e) => ({ ...e, plaintext: 'x' }), 'seal_envelope_malformed'],
    ['ct that is not base64', (e) => ({ ...e, ct: 'not base64!' }), 'seal_envelope_malformed'],
    ['an 8 byte iv', (e) => ({ ...e, iv: bytesToB64(new Uint8Array(8)) }), 'seal_envelope_malformed'],
    ['a kid that is a number', (e) => ({ ...e, kid: 7 }), 'seal_envelope_malformed'],
  ]

  it.each(cases)('refuses %s', async (_label, mangle, code) => {
    const envelope = await seal(publicRing(), LOGIN, binding())
    const err = await refusal(open(privateRing(), mangle(envelope), binding()))
    expect(err.code).toBe(code)
  })
})

describe('the login appears nowhere in the envelope', () => {
  // A distinctive canary, long enough that a chance match is impossible.
  const CANARY = 'CANARY-seal-2333-d41d8cd98f00b204e9800998ecf8427e'

  /** The canary as base64 at each of the three byte alignments it could sit at. */
  function base64Forms(text: string): string[] {
    const forms: string[] = []
    for (const pad of ['', 'x', 'xx']) {
      const full = btoa(pad + text)
      // Drop the characters that straddle the padding at either end.
      const core = full.slice(pad.length === 0 ? 0 : 4, -4)
      forms.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'))
    }
    return forms
  }

  it('in any field, as text, base64, base64url or hex', async () => {
    const envelope = await seal(publicRing(), CANARY, binding())
    const whole = JSON.stringify(envelope)
    const hex = [...new TextEncoder().encode(CANARY)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const needles = [CANARY, hex, ...base64Forms(CANARY)]
    for (const needle of needles) {
      expect(whole.toLowerCase()).not.toContain(needle.toLowerCase())
    }
    // And not in the raw bytes of any field once decoded.
    for (const field of ['ct', 'iv', 'wrapped_key'] as const) {
      const raw = String.fromCharCode(...b64ToBytes(envelope[field]))
      expect(raw).not.toContain(CANARY)
    }
    // The positive control: the canary really is what was sealed.
    expect(await open(privateRing(), envelope, binding())).toBe(CANARY)
  })

  it('and the check would see it if it were there', () => {
    // Without this, a needle list that matched nothing would pass for ever.
    const leaky = JSON.stringify({ ct: btoa('xx' + CANARY + 'tail') })
    expect(base64Forms(CANARY).some((form) => leaky.includes(form))).toBe(true)
  })
})

describe('keys are checked at import and fail loud by name', () => {
  let small: PemPair
  let ec: Awaited<ReturnType<typeof ecPair>>

  beforeAll(async () => {
    ;[small, ec] = await Promise.all([rsaPair(2048), ecPair()])
  }, KEYGEN_TIMEOUT_MS)

  it('imports a 4096 bit public key for encryption only', async () => {
    const key = await importPublicKey(current.publicPem)
    expect(key.type).toBe('public')
    expect(key.usages).toEqual(['encrypt'])
    expect((key.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(4096)
    expect(MIN_MODULUS_BITS).toBe(4096)
  })

  it('imports a 4096 bit private key that cannot be exported', async () => {
    const key = await importPrivateKey(current.privatePem)
    expect(key.type).toBe('private')
    expect(key.extractable).toBe(false)
    expect(key.usages).toEqual(['decrypt'])
  })

  it.each([
    ['a 2048 bit public key', () => importPublicKey(small.publicPem), 'seal_key_too_small'],
    ['a 2048 bit private key', () => importPrivateKey(small.privatePem), 'seal_key_too_small'],
    ['an elliptic curve public key', () => importPublicKey(ec.publicPem), 'seal_key_not_rsa'],
    ['an elliptic curve private key', () => importPrivateKey(ec.privatePem), 'seal_key_not_rsa'],
    ['a private key offered as public', () => importPublicKey(current.privatePem), 'seal_key_wrong_kind'],
    ['a public key offered as private', () => importPrivateKey(current.publicPem), 'seal_key_wrong_kind'],
    ['text that is not PEM', () => importPublicKey('hello'), 'seal_key_malformed'],
    ['an empty secret', () => importPrivateKey(''), 'seal_key_malformed'],
    [
      'a PEM whose body is cut short',
      () => importPublicKey(current.publicPem.replace(/\n[^\n]+\n-----END/, '\n-----END')),
      'seal_key_malformed',
    ],
  ] as const)('refuses %s', async (_label, attempt, code) => {
    const err = await refusal(attempt())
    expect(err.code).toBe(code)
  })

  it('refuses a small key at seal time too, not only when imported directly', async () => {
    const err = await refusal(seal({ [CURRENT]: small.publicPem }, LOGIN, binding()))
    expect(err.code).toBe('seal_key_too_small')
  })

  it('never puts key material in a refusal message', async () => {
    const err = await refusal(importPublicKey(current.privatePem))
    const body = current.privatePem.split('\n')[1]
    expect(err.message).not.toContain(body.slice(0, 20))
  })
})
