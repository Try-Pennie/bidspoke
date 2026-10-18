import { beforeAll, describe, expect, it } from 'vitest'
import { checkPrivateKeyOpens, SealError } from '../index'
import { KEYGEN_TIMEOUT_MS, rsaPair, type PemPair } from './fixtures'

/**
 * Whether a private key opens what bidding seals under a kid (#2333). The ops
 * minute tick asks this every minute, so that a sound key which is not the
 * committed public key's other half is named before a login fails to open. It
 * seals and opens only its own probe, so it can never open a stored login, and
 * the ops Worker's key check reaches it without importing `open`.
 */

let pair: PemPair
let other: PemPair

beforeAll(async () => {
  ;[pair, other] = await Promise.all([rsaPair(4096), rsaPair(4096)])
}, KEYGEN_TIMEOUT_MS)

describe('checkPrivateKeyOpens', () => {
  it('resolves when the private key is the other half of the public key under the kid', async () => {
    await expect(checkPrivateKeyOpens(pair.privatePem, { 'ops-test': pair.publicPem }, 'ops-test')).resolves.toBeUndefined()
  })

  it('refuses a sound key of another pair as seal_unwrap_failed', async () => {
    const refused = await checkPrivateKeyOpens(other.privatePem, { 'ops-test': pair.publicPem }, 'ops-test').catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(SealError)
    expect((refused as SealError).code).toBe('seal_unwrap_failed')
  })

  it('refuses a kid the public ring does not hold as seal_unknown_kid', async () => {
    const refused = await checkPrivateKeyOpens(pair.privatePem, { 'ops-test': pair.publicPem }, 'ops-missing').catch((e: unknown) => e)
    expect((refused as SealError).code).toBe('seal_unknown_kid')
  })

  it('never carries the key text in its refusal', async () => {
    const refused = (await checkPrivateKeyOpens(other.privatePem, { 'ops-test': pair.publicPem }, 'ops-test').catch((e: unknown) => e)) as SealError
    const body = other.privatePem.split('\n').filter((l) => l && !l.startsWith('-----'))
    for (const line of body) expect(`${refused.message} ${refused.stack}`).not.toContain(line.slice(0, 24))
  })
})
