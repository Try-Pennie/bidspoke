/**
 * Secret decrypt-health check (#404): for every is_secret env var, attempt to
 * decrypt the stored ciphertext and alert via Slack on the ones that fail (created
 * pre-encryption / post key-rotation = silently skipped by env-loader). Decryption
 * and Slack are mocked. The "not synced to Cloudflare" direction is owned by the
 * secret-drift check (#199), not here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../index'

vi.mock('../secret-crypto', () => ({ decryptSecret: vi.fn() }))
vi.mock('../slack', () => ({ getSlackConnection: vi.fn(), sendSecretDecryptAlert: vi.fn() }))

import {
  findUndecryptableSecrets,
  runSecretDecryptHealthCheck,
  type SecretRow,
} from '../secret-decrypt-health'
import { decryptSecret } from '../secret-crypto'
import { getSlackConnection, sendSecretDecryptAlert } from '../slack'

const r = (key: string, value: string | null = `cipher-${key}`, org = 'org-1'): SecretRow => ({
  key,
  value,
  organization_id: org,
})

// decryptSecret throws for any value listed in `bad`, resolves otherwise.
function decryptExcept(bad: string[]) {
  vi.mocked(decryptSecret).mockImplementation(async (v: string) => {
    if (bad.includes(v)) throw new Error('OperationError')
    return `plain:${v}`
  })
}

describe('findUndecryptableSecrets', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns rows whose ciphertext fails to decrypt', async () => {
    decryptExcept(['cipher-B'])
    const bad = await findUndecryptableSecrets([r('A'), r('B'), r('C')], 'key')
    expect(bad.map((x) => x.key)).toEqual(['B'])
  })

  it('returns nothing when every secret decrypts', async () => {
    decryptExcept([])
    expect(await findUndecryptableSecrets([r('A'), r('B')], 'key')).toEqual([])
  })

  it('skips empty/null values (not a decrypt failure)', async () => {
    decryptExcept([])
    const bad = await findUndecryptableSecrets([r('A', null), r('B', '')], 'key')
    expect(bad).toEqual([])
    expect(vi.mocked(decryptSecret)).not.toHaveBeenCalled()
  })
})

function makeSupabase(rows: SecretRow[], error: { message: string } | null = null) {
  const chain: unknown = new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'then')
          return (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: error ? null : rows, error }).then(resolve)
        return () => chain
      },
    },
  )
  return { from: () => chain } as never
}

const ENV = { SECRET_ENCRYPTION_KEY: 'k', APP_URL: 'https://app.test' } as unknown as Env

describe('runSecretDecryptHealthCheck', () => {
  beforeEach(() => vi.clearAllMocks())

  it('skips when no encryption key is configured', async () => {
    const env = { APP_URL: 'https://app.test' } as unknown as Env
    const res = await runSecretDecryptHealthCheck(makeSupabase([r('A')]), env)
    expect(res).toMatchObject({ alerted: false, skipped: 'no-encryption-key' })
    expect(vi.mocked(decryptSecret)).not.toHaveBeenCalled()
  })

  it('does not alert when every secret decrypts', async () => {
    decryptExcept([])
    const res = await runSecretDecryptHealthCheck(makeSupabase([r('A'), r('B')]), ENV)
    expect(res).toMatchObject({ checked: 2, undecryptable: 0, alerted: false })
    expect(vi.mocked(sendSecretDecryptAlert)).not.toHaveBeenCalled()
  })

  it('alerts the org Slack connection with the keys that fail to decrypt', async () => {
    decryptExcept(['cipher-GONE'])
    vi.mocked(getSlackConnection).mockResolvedValue({ config_alerts_enabled: true } as never)
    vi.mocked(sendSecretDecryptAlert).mockResolvedValue(true)
    const res = await runSecretDecryptHealthCheck(makeSupabase([r('A'), r('GONE')]), ENV)
    expect(res).toMatchObject({ checked: 2, undecryptable: 1, alerted: true })
    expect(vi.mocked(sendSecretDecryptAlert).mock.calls[0][1]).toEqual(['GONE'])
  })

  it('does not alert when the org opted out of config alerts', async () => {
    decryptExcept(['cipher-GONE'])
    vi.mocked(getSlackConnection).mockResolvedValue({ config_alerts_enabled: false } as never)
    const res = await runSecretDecryptHealthCheck(makeSupabase([r('GONE')]), ENV)
    expect(res).toMatchObject({ undecryptable: 1, alerted: false })
    expect(vi.mocked(sendSecretDecryptAlert)).not.toHaveBeenCalled()
  })

  it('does not raise an alert on a transient DB error (inverse of #391)', async () => {
    const res = await runSecretDecryptHealthCheck(makeSupabase([], { message: 'pool timeout' }), ENV)
    expect(res).toMatchObject({ alerted: false, skipped: 'db-error' })
    expect(vi.mocked(sendSecretDecryptAlert)).not.toHaveBeenCalled()
  })
})
