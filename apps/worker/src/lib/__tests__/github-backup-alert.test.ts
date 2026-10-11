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

  // #1337: a recovered backup resets the reminder schedule, so the next outage
  // starts fresh at the first interval rather than the backed-off one.
  it('clears the standing reminder condition so the next outage starts over', async () => {
    const kv = makeKv({
      'github-backup-failures:org-1': '3',
      'github-backup:org-1:condition': '{"since":"2026-09-13T12:00:00.000Z","alerts":2}',
      'github-backup:org-1:cooldown': '1',
    })
    await recordBackupSuccess(kv, ORG)
    expect(kv.store.has('github-backup:org-1:condition')).toBe(false)
    expect(kv.store.has('github-backup:org-1:cooldown')).toBe(false)
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
    // cooldown and standing condition set after delivery (#1337)
    expect(kv.store.has('github-backup:org-1:cooldown')).toBe(true)
    expect(kv.store.has('github-backup:org-1:condition')).toBe(true)
    // the first alert is not a repeat, so it carries no reminder line
    expect(payload.repeat).toBeUndefined()
  })

  // #1337: a sustained outage no longer repeats at a flat 6h. Once the cooldown
  // lapses the next failure is a reminder that says which one it is.
  it('escalates to a reminder carrying a repeat line once the cooldown lapses', async () => {
    const kv = makeKv({ 'github-backup-failures:org-1': String(BACKUP_FAILURE_THRESHOLD) })
    await recordBackupFailure(baseInput(kv))
    expect(sendBackupFailureAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendBackupFailureAlert).mock.calls[0][1].repeat).toBeUndefined()

    // Simulate the cooldown interval elapsing.
    kv.store.delete('github-backup:org-1:cooldown')

    await recordBackupFailure(baseInput(kv))
    expect(sendBackupFailureAlert).toHaveBeenCalledTimes(2)
    expect(vi.mocked(sendBackupFailureAlert).mock.calls[1][1].repeat).toContain('reminder 2')
  })

  // #628: a Supabase/PostgREST failure is a plain object, not an Error instance,
  // so the old `String(err)` fallback rendered it as "[object Object]" and the
  // alert named no cause. formatErr folds message/details/code into readable text.
  it('renders an object-shaped (non-Error) failure readably, not "[object Object]"', async () => {
    const kv = makeKv({ 'github-backup-failures:org-1': String(BACKUP_FAILURE_THRESHOLD - 1) })
    const objectError = { message: 'permission denied for table workflows', code: '42501', details: null, hint: null }
    await recordBackupFailure(baseInput(kv, objectError))
    const [, payload] = vi.mocked(sendBackupFailureAlert).mock.calls[0]
    expect(payload.error_message).not.toContain('[object Object]')
    expect(payload.error_message).toContain('permission denied for table workflows')
    expect(payload.error_message).toContain('42501')
  })

  it('suppresses a repeat alert while the cooldown is active', async () => {
    const kv = makeKv({
      'github-backup-failures:org-1': '5',
      'github-backup:org-1:cooldown': '1',
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
    expect(kv.store.has('github-backup:org-1:cooldown')).toBe(false)
  })
})
