/**
 * The ops Worker's own key ring through every step of a rotation of the ops key
 * (#2333, docs/disaster-recovery.md, rotating the ops private key).
 *
 * Before this, the ring put OPS_CONNECTIONS_PRIVATE_KEY under CURRENT_OPS_KID
 * and nothing else, so in rotation step 3, where the new kid is current while
 * its key is still held in OPS_CONNECTIONS_PRIVATE_KEY_NEXT, the new kid was
 * tried with the old key and no login of either kid opened. Each kid now gets
 * the held key that is its own private half, whichever secret holds it.
 */
import { CURRENT_OPS_KID, open, seal, type ConnectionAad } from '@bidspoke/connection-seal'
import { beforeAll, describe, expect, it } from 'vitest'
import { opsSealKeys } from '../connection-token-object'
import { KEYGEN_TIMEOUT_MS, opsKeyPair, type OpsKeyPair } from './ops-key-fixture'

let a: OpsKeyPair
let b: OpsKeyPair

beforeAll(async () => {
  ;[a, b] = await Promise.all([opsKeyPair(4096), opsKeyPair(4096)])
}, KEYGEN_TIMEOUT_MS)

const env = (current?: string, next?: string) => ({ OPS_CONNECTIONS_PRIVATE_KEY: current, OPS_CONNECTIONS_PRIVATE_KEY_NEXT: next })

const aad = (kid: string): ConnectionAad => ({
  organization_id: '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60',
  connection_id: '00000000-0000-4000-8000-000000002333',
  service: 'example',
  generation: 2,
  kid,
})

describe('opsSealKeys through a rotation', () => {
  it('normal: the one key opens the one kid, and seals go to it', () => {
    const keys = opsSealKeys(env(a.privatePem), { currentKid: 'ops-a', publicKeys: { 'ops-a': a.publicPem } })
    expect(keys).toEqual({ privateKeys: { 'ops-a': a.privatePem }, publicKeys: { 'ops-a': a.publicPem }, kid: 'ops-a' })
  })

  it('step 1, NEXT set before its public half is committed: nothing changes', () => {
    const keys = opsSealKeys(env(a.privatePem, b.privatePem), { currentKid: 'ops-a', publicKeys: { 'ops-a': a.publicPem } })
    expect(keys.privateKeys).toEqual({ 'ops-a': a.privatePem })
  })

  it('step 2, both kids committed and the old one current: both open, seals stay on the old kid', () => {
    const keys = opsSealKeys(env(a.privatePem, b.privatePem), { currentKid: 'ops-a', publicKeys: { 'ops-a': a.publicPem, 'ops-b': b.publicPem } })
    expect(keys.privateKeys).toEqual({ 'ops-a': a.privatePem, 'ops-b': b.privatePem })
    expect(keys.kid).toBe('ops-a')
  })

  it('step 3, the new kid current while NEXT still holds its key: both open, and seals go to the new kid', async () => {
    const publicKeys = { 'ops-a': a.publicPem, 'ops-b': b.publicPem }
    const keys = opsSealKeys(env(a.privatePem, b.privatePem), { currentKid: 'ops-b', publicKeys })
    expect(keys.privateKeys).toEqual({ 'ops-a': a.privatePem, 'ops-b': b.privatePem })
    expect(keys.kid).toBe('ops-b')
    for (const kid of ['ops-a', 'ops-b']) {
      await expect(open(keys.privateKeys, await seal(publicKeys, `login ${kid}`, aad(kid)), aad(kid))).resolves.toBe(`login ${kid}`)
    }
  })

  it('step 4, mid change (both secrets hold the new key, the old kid still committed): the new kid opens and the old one is named unknown', () => {
    const keys = opsSealKeys(env(b.privatePem, b.privatePem), { currentKid: 'ops-b', publicKeys: { 'ops-a': a.publicPem, 'ops-b': b.publicPem } })
    expect(keys.privateKeys).toEqual({ 'ops-b': b.privatePem })
  })

  it('step 4, secrets changed before the old kid is removed (the new key in PRIMARY, NEXT deleted, both kids committed): the new kid opens from PRIMARY', async () => {
    const publicKeys = { 'ops-a': a.publicPem, 'ops-b': b.publicPem }
    const keys = opsSealKeys(env(b.privatePem), { currentKid: 'ops-b', publicKeys })
    expect(keys.privateKeys).toEqual({ 'ops-b': b.privatePem })
    expect(keys.kid).toBe('ops-b')
    await expect(open(keys.privateKeys, await seal(publicKeys, 'login ops-b', aad('ops-b')), aad('ops-b'))).resolves.toBe('login ops-b')
  })

  it('step 4, done: the new key alone, under the new kid alone, opened from PRIMARY', async () => {
    const publicKeys = { 'ops-b': b.publicPem }
    const keys = opsSealKeys(env(b.privatePem), { currentKid: 'ops-b', publicKeys })
    expect(keys.privateKeys).toEqual({ 'ops-b': b.privatePem })
    expect(keys.kid).toBe('ops-b')
    await expect(open(keys.privateKeys, await seal(publicKeys, 'login ops-b', aad('ops-b')), aad('ops-b'))).resolves.toBe('login ops-b')
  })

  it('a key that is not the committed public key\'s other half opens nothing, rather than being tried under the current kid', () => {
    expect(opsSealKeys(env(b.privatePem), { currentKid: 'ops-a', publicKeys: { 'ops-a': a.publicPem } }).privateKeys).toEqual({})
  })

  it('with no kid current nothing is sealed, and the held keys still open their kids', () => {
    const keys = opsSealKeys(env(a.privatePem), { currentKid: null, publicKeys: { 'ops-a': a.publicPem } })
    expect(keys).toEqual({ privateKeys: { 'ops-a': a.privatePem }, publicKeys: { 'ops-a': a.publicPem }, kid: null })
  })

  it('unset or blank secrets give an empty ring, and the committed registry is the default', () => {
    expect(opsSealKeys(env()).privateKeys).toEqual({})
    expect(opsSealKeys(env('  ', '')).privateKeys).toEqual({})
    // The committed public key's private half is in 1Password, not here, so no test key matches it.
    expect(opsSealKeys(env(a.privatePem)).privateKeys).toEqual({})
    expect(opsSealKeys(env(a.privatePem)).kid).toBe(CURRENT_OPS_KID)
  })
})
