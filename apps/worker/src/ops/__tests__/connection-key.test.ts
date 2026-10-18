/**
 * The ops private key check the minute tick runs (#2333): an unset key, one
 * that does not import as an RSA-OAEP private key of at least 4096 bits, or one
 * that is not the private half of the committed public key (with NEXT allowed
 * to be, mid rotation), is named, so the bidding Worker pages with that secret's remedy before the first
 * ops connection needs the key.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { opsConnectionKeyProblems } from '../connection-key'
import type { OpsEnv } from '../index'
import { KEYGEN_TIMEOUT_MS, opsKeyPair, type OpsKeyPair } from './ops-key-fixture'

/** A registry holding the pair's own public half, as the committed one holds the real key's. */
const registryOf = (pair: OpsKeyPair) => ({ currentKid: 'ops-test', publicKeys: { 'ops-test': pair.publicPem } })

const env = (over: Partial<Record<'OPS_CONNECTIONS_PRIVATE_KEY' | 'OPS_CONNECTIONS_PRIVATE_KEY_NEXT', string | undefined>>) =>
  ({ LANE: 'ops', ...over }) as unknown as OpsEnv

describe('opsConnectionKeyProblems', () => {
  let strong: OpsKeyPair
  let weak: OpsKeyPair
  let other: OpsKeyPair

  beforeAll(async () => {
    ;[strong, weak, other] = await Promise.all([opsKeyPair(4096), opsKeyPair(2048), opsKeyPair(4096)])
  }, KEYGEN_TIMEOUT_MS)

  it('finds nothing wrong with a 4096 bit RSA private key and no NEXT key', async () => {
    expect(await opsConnectionKeyProblems(env({ OPS_CONNECTIONS_PRIVATE_KEY: strong.privatePem }), registryOf(strong))).toEqual([])
  })

  it('names a sound key that is not the private half of the public key committed under the current kid', async () => {
    const problems = await opsConnectionKeyProblems(env({ OPS_CONNECTIONS_PRIVATE_KEY: strong.privatePem }), registryOf(other))
    expect(problems).toEqual([{
      secret: 'OPS_CONNECTIONS_PRIVATE_KEY',
      problem: expect.stringMatching(/^OPS_CONNECTIONS_PRIVATE_KEY is set on bidspoke-worker-ops but is not the private half of the public key committed as kid ops-test \(seal_unwrap_failed/),
    }])
  })

  it('checks against the committed registry when none is passed, so a key other than ops-2026-10 is named', async () => {
    const problems = await opsConnectionKeyProblems(env({ OPS_CONNECTIONS_PRIVATE_KEY: strong.privatePem }))
    expect(problems).toEqual([{ secret: 'OPS_CONNECTIONS_PRIVATE_KEY', problem: expect.stringContaining('committed as kid ops-2026-10') }])
  })

  it('accepts the current kid opened by NEXT, as in rotation step 3 when the kid has moved and the secrets have not', async () => {
    expect(await opsConnectionKeyProblems(env({ OPS_CONNECTIONS_PRIVATE_KEY: strong.privatePem, OPS_CONNECTIONS_PRIVATE_KEY_NEXT: other.privatePem }), registryOf(other))).toEqual([])
  })

  it('names both secrets when a NEXT key is set and neither opens the current kid', async () => {
    const problems = await opsConnectionKeyProblems(env({ OPS_CONNECTIONS_PRIVATE_KEY: strong.privatePem, OPS_CONNECTIONS_PRIVATE_KEY_NEXT: strong.privatePem }), registryOf(other))
    expect(problems).toEqual([{
      secret: 'OPS_CONNECTIONS_PRIVATE_KEY',
      problem: expect.stringMatching(/^Neither OPS_CONNECTIONS_PRIVATE_KEY nor OPS_CONNECTIONS_PRIVATE_KEY_NEXT on bidspoke-worker-ops is the private half of the public key committed as kid ops-test/),
    }])
  })

  it('checks only that the key imports while no kid is current, since nothing is sealed then', async () => {
    expect(await opsConnectionKeyProblems(env({ OPS_CONNECTIONS_PRIVATE_KEY: strong.privatePem }), { currentKid: null, publicKeys: {} })).toEqual([])
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['only whitespace', '  \n'],
  ])('names the key when it is %s', async (_label, value) => {
    expect(await opsConnectionKeyProblems(env({ OPS_CONNECTIONS_PRIVATE_KEY: value }))).toEqual([{
      secret: 'OPS_CONNECTIONS_PRIVATE_KEY',
      problem: 'OPS_CONNECTIONS_PRIVATE_KEY is not set on bidspoke-worker-ops, so no ops connection can be opened.',
    }])
  })

  it.each([
    ['text that is not a key', () => 'this is not a key', 'seal_key_malformed'],
    ['a PEM cut short', () => strong.privatePem.slice(0, 400) + '\n-----END PRIVATE KEY-----\n', 'seal_key_malformed'],
    ['a 2048 bit key', () => weak.privatePem, 'seal_key_too_small'],
    ['the public half', () => strong.publicPem, 'seal_key_wrong_kind'],
  ])('names the key when it is %s, with the refusal\'s code', async (_label, value, code) => {
    const problems = await opsConnectionKeyProblems(env({ OPS_CONNECTIONS_PRIVATE_KEY: value() }))
    expect(problems).toHaveLength(1)
    expect(problems[0].secret).toBe('OPS_CONNECTIONS_PRIVATE_KEY')
    expect(problems[0].problem).toMatch(/^OPS_CONNECTIONS_PRIVATE_KEY is set on bidspoke-worker-ops but does not import as an RSA-OAEP private key of at least 4096 bits/)
    expect(problems[0].problem).toContain(`(${code}`)
  })

  it('never carries any of the secret\'s text in what it reports', async () => {
    const pasted = strong.privatePem.slice(0, 400) + '\n-----END PRIVATE KEY-----\n'
    const body = pasted.split('\n').filter((l) => l && !l.startsWith('-----'))
    const problems = await opsConnectionKeyProblems(env({ OPS_CONNECTIONS_PRIVATE_KEY: pasted }))
    const said = JSON.stringify(problems)
    expect(body.length).toBeGreaterThan(0)
    for (const line of body) expect(said).not.toContain(line.slice(0, 24))
  })

  it('leaves an unset NEXT key alone: it exists only during a rotation', async () => {
    expect(await opsConnectionKeyProblems(env({ OPS_CONNECTIONS_PRIVATE_KEY: strong.privatePem, OPS_CONNECTIONS_PRIVATE_KEY_NEXT: undefined }), registryOf(strong))).toEqual([])
  })

  it('accepts a sound NEXT key, and names a NEXT key that does not import', async () => {
    expect(await opsConnectionKeyProblems(env({ OPS_CONNECTIONS_PRIVATE_KEY: strong.privatePem, OPS_CONNECTIONS_PRIVATE_KEY_NEXT: strong.privatePem }), registryOf(strong))).toEqual([])
    const problems = await opsConnectionKeyProblems(env({ OPS_CONNECTIONS_PRIVATE_KEY: strong.privatePem, OPS_CONNECTIONS_PRIVATE_KEY_NEXT: weak.privatePem }), registryOf(strong))
    expect(problems).toEqual([{ secret: 'OPS_CONNECTIONS_PRIVATE_KEY_NEXT', problem: expect.stringMatching(/^OPS_CONNECTIONS_PRIVATE_KEY_NEXT is set on bidspoke-worker-ops but does not import .*seal_key_too_small/) }])
  })

  it('names both when both are unusable, the current key first', async () => {
    const problems = await opsConnectionKeyProblems(env({ OPS_CONNECTIONS_PRIVATE_KEY: undefined, OPS_CONNECTIONS_PRIVATE_KEY_NEXT: 'not a key' }))
    expect(problems.map((p) => p.secret)).toEqual(['OPS_CONNECTIONS_PRIVATE_KEY', 'OPS_CONNECTIONS_PRIVATE_KEY_NEXT'])
  })
})
