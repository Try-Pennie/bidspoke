/**
 * Secret decrypt-health check (#404): for every is_secret env var, attempt to
 * decrypt the stored ciphertext and alert via Slack on the ones that fail (created
 * pre-encryption / post key-rotation = silently skipped by env-loader). Decryption
 * and Slack are mocked. The "not synced to Cloudflare" direction is owned by the
 * secret-drift check (#199), not here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../index'

// Only decryptSecret is stood in for; secretKeys stays real (L727).
vi.mock('../secret-crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../secret-crypto')>()),
  decryptSecret: vi.fn(),
}))
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
  scope: 'global',
  workflow_id: null,
  workflows: null,
})

// A secret saved against one workflow, with the workflow the read embeds.
const own = (key: string, workflowName: string, deletedAt: string | null = null): SecretRow => ({
  ...r(key),
  scope: 'workflow',
  workflow_id: 'wf-9',
  workflows: { name: workflowName, deleted_at: deletedAt },
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

// Applies the equality filters the check sends, so a filter that drops the rows
// it is meant to cover shows up as a missed alert rather than passing unseen.
// Every row here is a secret, as the table's rows are when the check reads them.
function makeSupabase(rows: SecretRow[], error: { message: string } | null = null) {
  const filters: Array<[string, unknown]> = []
  const chain: unknown = new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'eq')
          return (col: string, val: unknown) => {
            filters.push([col, val])
            return chain
          }
        if (prop === 'then') {
          const stored = rows.map((row) => ({ ...row, is_secret: true }) as Record<string, unknown>)
          const matched = stored.filter((row) => filters.every(([c, v]) => row[c] === v))
          return (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: error ? null : matched, error }).then(resolve)
        }
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
    expect(vi.mocked(sendSecretDecryptAlert).mock.calls[0][1]).toEqual([{ key: 'GONE', workflow: null }])
  })

  // #1681: the loader now decrypts a workflow's own secrets too, and withholds
  // one it cannot decrypt from that workflow's runs. This check exists so that a
  // credential the loader drops is never dropped silently, so it covers the same
  // set, and names the workflow, because the same key can be the org's as well.
  it("alerts a workflow's own secret that fails to decrypt, naming the workflow it was saved for", async () => {
    decryptExcept(['cipher-PARTNER_TOKEN'])
    vi.mocked(getSlackConnection).mockResolvedValue({ config_alerts_enabled: true } as never)
    vi.mocked(sendSecretDecryptAlert).mockResolvedValue(true)
    const res = await runSecretDecryptHealthCheck(makeSupabase([r('A'), own('PARTNER_TOKEN', 'Main Flow')]), ENV)
    expect(res).toMatchObject({ checked: 2, undecryptable: 1, alerted: true })
    expect(vi.mocked(sendSecretDecryptAlert).mock.calls[0][1]).toEqual([{ key: 'PARTNER_TOKEN', workflow: 'Main Flow' }])
  })

  it('does not alert a secret saved for a deleted workflow, which no run can read', async () => {
    decryptExcept(['cipher-PARTNER_TOKEN'])
    vi.mocked(getSlackConnection).mockResolvedValue({ config_alerts_enabled: true } as never)
    const res = await runSecretDecryptHealthCheck(makeSupabase([own('PARTNER_TOKEN', 'Old Flow', '2026-09-01T00:00:00Z')]), ENV)
    expect(res).toMatchObject({ checked: 0, undecryptable: 0, alerted: false })
    expect(vi.mocked(sendSecretDecryptAlert)).not.toHaveBeenCalled()
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
