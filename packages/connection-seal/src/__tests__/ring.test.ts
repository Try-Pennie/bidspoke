import { beforeAll, describe, expect, it } from 'vitest'
import { open, privateKeyRing, seal, type ConnectionAad } from '../index'
import { ecPair, KEYGEN_TIMEOUT_MS, rsaPair, type PemPair } from './fixtures'

/**
 * Which private key opens which kid, during a rotation of the ops key (#2333).
 *
 * The ops Worker holds its private keys as two secrets that carry no kid,
 * OPS_CONNECTIONS_PRIVATE_KEY and, during a rotation only,
 * OPS_CONNECTIONS_PRIVATE_KEY_NEXT, and which kid each one opens changes as the
 * rotation moves on: in step 3 the new kid is current while its key is still
 * held in NEXT. So the ring is built by matching each private key to the
 * committed public key whose modulus it shares, never by assuming which secret
 * holds which kid.
 */

let a: PemPair
let b: PemPair
let stranger: PemPair

beforeAll(async () => {
  ;[a, b, stranger] = await Promise.all([rsaPair(4096), rsaPair(4096), rsaPair(4096)])
}, KEYGEN_TIMEOUT_MS)

const aad = (kid: string): ConnectionAad => ({
  organization_id: '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60',
  connection_id: '00000000-0000-4000-8000-000000002333',
  service: 'example',
  generation: 3,
  kid,
})

describe('privateKeyRing', () => {
  it('maps the one key to the one committed kid it opens (no rotation)', () => {
    expect(privateKeyRing([a.privatePem], { 'ops-a': a.publicPem })).toEqual({ 'ops-a': a.privatePem })
  })

  it('maps each key to its own kid whichever secret holds it (rotation step 3: NEXT holds the current kid)', () => {
    const publicKeys = { 'ops-a': a.publicPem, 'ops-b': b.publicPem }
    expect(privateKeyRing([a.privatePem, b.privatePem], publicKeys)).toEqual({ 'ops-a': a.privatePem, 'ops-b': b.privatePem })
    expect(privateKeyRing([b.privatePem, a.privatePem], publicKeys)).toEqual({ 'ops-a': a.privatePem, 'ops-b': b.privatePem })
  })

  it('maps nothing for a key whose public half is not committed yet (rotation step 1)', () => {
    expect(privateKeyRing([a.privatePem, b.privatePem], { 'ops-a': a.publicPem })).toEqual({ 'ops-a': a.privatePem })
  })

  it('maps a kid once when both secrets hold the same key (rotation step 4, mid change)', () => {
    expect(privateKeyRing([b.privatePem, b.privatePem], { 'ops-a': a.publicPem, 'ops-b': b.publicPem })).toEqual({ 'ops-b': b.privatePem })
  })

  it('leaves out a kid no held key opens, rather than putting a wrong key under it', () => {
    expect(privateKeyRing([stranger.privatePem], { 'ops-a': a.publicPem })).toEqual({})
  })

  it('skips a key that cannot be read, and never throws: the minute key check names it', async () => {
    const ec = await ecPair()
    const unreadable = ['', '   ', 'not a key', a.publicPem, ec.privatePem, `${a.privatePem.slice(0, 200)}\n-----END PRIVATE KEY-----`]
    expect(privateKeyRing([...unreadable, a.privatePem], { 'ops-a': a.publicPem, 'ops-ec': ec.publicPem, 'ops-bad': 'not a key' })).toEqual({ 'ops-a': a.privatePem })
  })

  it('opens with the ring what each kid sealed', async () => {
    const publicKeys = { 'ops-a': a.publicPem, 'ops-b': b.publicPem }
    const ring = privateKeyRing([b.privatePem, a.privatePem], publicKeys)
    for (const kid of ['ops-a', 'ops-b']) {
      const envelope = await seal(publicKeys, `login under ${kid}`, aad(kid))
      await expect(open(ring, envelope, aad(kid))).resolves.toBe(`login under ${kid}`)
    }
  })

  it('reads own kids only, so a kid named like an object property maps nothing', () => {
    expect(privateKeyRing([a.privatePem], Object.create({ inherited: a.publicPem }) as Record<string, string>)).toEqual({})
  })
})
