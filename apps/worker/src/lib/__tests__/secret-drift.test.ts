/**
 * Secret-drift check (#199): detects DB secrets missing from Cloudflare and
 * alerts via Slack. Cloudflare and Slack are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../index'

vi.mock('../cf-secrets', () => ({ listCfSecretNames: vi.fn() }))
vi.mock('../slack', () => ({ getSlackConnection: vi.fn(), sendSecretDriftAlert: vi.fn() }))

import { findMissingSecrets, runSecretDriftCheck, type DbSecret } from '../secret-drift'
import { listCfSecretNames } from '../cf-secrets'
import { getSlackConnection, sendSecretDriftAlert } from '../slack'

const s = (key: string, extra: Partial<DbSecret> = {}): DbSecret => ({
  key, scope: 'global', workflow_id: null, organization_id: 'org-1', ...extra,
})

describe('findMissingSecrets', () => {
  it('returns DB secrets whose key is absent from Cloudflare', () => {
    const db = [s('A'), s('B'), s('C')]
    expect(findMissingSecrets(db, new Set(['A', 'C'])).map((x) => x.key)).toEqual(['B'])
  })

  it('returns nothing when Cloudflare has every DB secret', () => {
    expect(findMissingSecrets([s('A'), s('B')], new Set(['A', 'B', 'EXTRA']))).toEqual([])
  })

  // A workflow's own secret is never written to Cloudflare, because the Worker
  // holds one value per name for every workflow (#1681). Its absence there is
  // the design, so reporting it would be an alert nobody can act on.
  it("does not report a workflow's own secret, which is never mirrored to Cloudflare (#1681)", () => {
    const db = [s('A'), s('WF_TOKEN', { scope: 'workflow', workflow_id: 'wf-9' })]
    expect(findMissingSecrets(db, new Set(['A']))).toEqual([])
  })
})

function makeSupabase(rows: DbSecret[]) {
  const chain: unknown = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve)
      return () => chain
    },
  })
  return { from: () => chain } as never
}

const ENV = { CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't', APP_URL: 'https://app.test' } as unknown as Env

describe('runSecretDriftCheck', () => {
  beforeEach(() => vi.clearAllMocks())

  it('skips when Cloudflare is not configured', async () => {
    vi.mocked(listCfSecretNames).mockResolvedValue(null)
    const r = await runSecretDriftCheck(makeSupabase([s('A')]), ENV)
    expect(r).toMatchObject({ alerted: false, skipped: 'cf-not-configured' })
    expect(vi.mocked(sendSecretDriftAlert)).not.toHaveBeenCalled()
  })

  it('does not alert when every DB secret exists in Cloudflare', async () => {
    vi.mocked(listCfSecretNames).mockResolvedValue(new Set(['A', 'B']))
    const r = await runSecretDriftCheck(makeSupabase([s('A'), s('B')]), ENV)
    expect(r).toMatchObject({ checked: 2, missing: 0, alerted: false })
    expect(vi.mocked(sendSecretDriftAlert)).not.toHaveBeenCalled()
  })

  it('alerts the org Slack connection when a DB secret is missing from Cloudflare', async () => {
    vi.mocked(listCfSecretNames).mockResolvedValue(new Set(['A']))
    vi.mocked(getSlackConnection).mockResolvedValue({ config_alerts_enabled: true } as never)
    vi.mocked(sendSecretDriftAlert).mockResolvedValue(true)
    const r = await runSecretDriftCheck(makeSupabase([s('A'), s('GONE')]), ENV)
    expect(r).toMatchObject({ missing: 1, alerted: true })
    const arg = vi.mocked(sendSecretDriftAlert).mock.calls[0][1]
    expect(arg.map((x) => x.key)).toEqual(['GONE'])
  })

  it('does not alert when the org opted out of config alerts', async () => {
    vi.mocked(listCfSecretNames).mockResolvedValue(new Set(['A']))
    vi.mocked(getSlackConnection).mockResolvedValue({ config_alerts_enabled: false } as never)
    const r = await runSecretDriftCheck(makeSupabase([s('GONE')]), ENV)
    expect(r).toMatchObject({ missing: 1, alerted: false })
    expect(vi.mocked(sendSecretDriftAlert)).not.toHaveBeenCalled()
  })
})
