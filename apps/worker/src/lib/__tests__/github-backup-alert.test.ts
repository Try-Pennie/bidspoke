import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../slack', () => ({
  getSlackConnection: vi.fn(),
  sendBackupFailureAlert: vi.fn().mockResolvedValue(true),
}))

import {
  recordBackupSuccess,
  recordBackupFailure,
  BACKUP_FAILURE_THRESHOLD,
} from '../github-backup-alert'
import { getSlackConnection, sendBackupFailureAlert } from '../slack'

// In-memory KV honoring get/put/delete (TTL ignored — irrelevant to logic).
function makeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
  }
}

const slackOn = { bot_token: 't', default_channel: '#c', config_alerts_enabled: true, backup_alerts_enabled: true }
const ORG = 'org-1'
const baseInput = (kv: ReturnType<typeof makeKv>, error: unknown = new Error('GitHub push failed (401): Bad credentials')) => ({
  supabase: {} as never,
  kv,
  orgId: ORG,
  workflowId: 'wf-1',
  workflowName: 'Main Flow',
  error,
  appUrl: 'https://app.example.com',
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSlackConnection).mockResolvedValue(slackOn as never)
  vi.mocked(sendBackupFailureAlert).mockResolvedValue(true)
})

describe('recordBackupSuccess', () => {
  it('clears the per-org failure streak', async () => {
    const kv = makeKv({ 'github-backup-failures:org-1': '3' })
    await recordBackupSuccess(kv, ORG)
    expect(kv.delete).toHaveBeenCalledWith('github-backup-failures:org-1')
    expect(kv.store.has('github-backup-failures:org-1')).toBe(false)
  })
})

describe('recordBackupFailure', () => {
  it('does not alert on the first failure (below threshold)', async () => {
    const kv = makeKv()
    const alerted = await recordBackupFailure(baseInput(kv))
    expect(alerted).toBe(false)
    expect(sendBackupFailureAlert).not.toHaveBeenCalled()
    expect(kv.store.get('github-backup-failures:org-1')).toBe('1')
  })

  it(`alerts once the streak reaches the threshold (${BACKUP_FAILURE_THRESHOLD})`, async () => {
    const kv = makeKv({ 'github-backup-failures:org-1': String(BACKUP_FAILURE_THRESHOLD - 1) })
    const alerted = await recordBackupFailure(baseInput(kv))
    expect(alerted).toBe(true)
    expect(sendBackupFailureAlert).toHaveBeenCalledTimes(1)
    const [, payload] = vi.mocked(sendBackupFailureAlert).mock.calls[0]
    expect(payload).toMatchObject({
      workflow_name: 'Main Flow',
      consecutive_failures: BACKUP_FAILURE_THRESHOLD,
      error_message: 'GitHub push failed (401): Bad credentials',
    })
    // cooldown set after delivery
    expect(kv.store.has('github-backup-alert-cooldown:org-1')).toBe(true)
  })

  it('suppresses a repeat alert while the cooldown is active', async () => {
    const kv = makeKv({
      'github-backup-failures:org-1': '5',
      'github-backup-alert-cooldown:org-1': '1',
    })
    const alerted = await recordBackupFailure(baseInput(kv))
    expect(alerted).toBe(false)
    expect(sendBackupFailureAlert).not.toHaveBeenCalled()
    // streak still increments while suppressed
    expect(kv.store.get('github-backup-failures:org-1')).toBe('6')
  })

  it('does not alert when the org has no Slack connection', async () => {
    vi.mocked(getSlackConnection).mockResolvedValue(null as never)
    const kv = makeKv({ 'github-backup-failures:org-1': String(BACKUP_FAILURE_THRESHOLD - 1) })
    expect(await recordBackupFailure(baseInput(kv))).toBe(false)
    expect(sendBackupFailureAlert).not.toHaveBeenCalled()
  })

  // #223: backup alerts have their own toggle, independent of config_alerts.
  it('does not alert when the dedicated backup toggle is off', async () => {
    vi.mocked(getSlackConnection).mockResolvedValue({ ...slackOn, backup_alerts_enabled: false } as never)
    const kv = makeKv({ 'github-backup-failures:org-1': String(BACKUP_FAILURE_THRESHOLD - 1) })
    expect(await recordBackupFailure(baseInput(kv))).toBe(false)
    expect(sendBackupFailureAlert).not.toHaveBeenCalled()
  })

  it('still alerts when config alerts are off but backup alerts are on (#223 independence)', async () => {
    vi.mocked(getSlackConnection).mockResolvedValue(
      { ...slackOn, config_alerts_enabled: false, backup_alerts_enabled: true } as never,
    )
    const kv = makeKv({ 'github-backup-failures:org-1': String(BACKUP_FAILURE_THRESHOLD - 1) })
    expect(await recordBackupFailure(baseInput(kv))).toBe(true)
    expect(sendBackupFailureAlert).toHaveBeenCalledTimes(1)
  })

  it('does not set the cooldown if delivery fails (so the next save retries the alert)', async () => {
    vi.mocked(sendBackupFailureAlert).mockResolvedValue(false)
    const kv = makeKv({ 'github-backup-failures:org-1': String(BACKUP_FAILURE_THRESHOLD - 1) })
    expect(await recordBackupFailure(baseInput(kv))).toBe(false)
    expect(kv.store.has('github-backup-alert-cooldown:org-1')).toBe(false)
  })
})
