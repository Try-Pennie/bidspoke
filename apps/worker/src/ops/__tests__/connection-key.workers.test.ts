/**
 * The ops private key check inside workerd (#2333), where the minute tick runs
 * it. The Node suite (connection-key.test.ts) proves the rules; this proves the
 * runtime's own Web Crypto imports a real RSA-4096 PKCS#8 key through
 * connection-seal's importPrivateKey and refuses a short one, so a sound key is
 * never reported not_configured in production for a reason Node cannot show.
 */
import { describe, expect, it } from 'vitest'
import { opsConnectionKeyProblems } from '../connection-key'
import type { OpsEnv } from '../index'
import { KEYGEN_TIMEOUT_MS, opsKeyPair } from './ops-key-fixture'

describe('the ops private key check (workerd)', () => {
  it('accepts a 4096 bit key and names a 2048 bit one by its refusal', async () => {
    const [strong, weak] = await Promise.all([opsKeyPair(4096), opsKeyPair(2048)])
    const registry = { currentKid: 'ops-test', publicKeys: { 'ops-test': strong.publicPem } }
    expect(await opsConnectionKeyProblems({ OPS_CONNECTIONS_PRIVATE_KEY: strong.privatePem } as unknown as OpsEnv, registry)).toEqual([])
    const refused = await opsConnectionKeyProblems({ OPS_CONNECTIONS_PRIVATE_KEY: weak.privatePem } as unknown as OpsEnv)
    expect(refused).toEqual([{ secret: 'OPS_CONNECTIONS_PRIVATE_KEY', problem: expect.stringMatching(/seal_key_too_small/) }])
  }, KEYGEN_TIMEOUT_MS)
})
