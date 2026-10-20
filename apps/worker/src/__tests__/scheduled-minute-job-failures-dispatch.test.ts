import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recordingContext } from '../test-setup/wait-until'
import type { Env } from '../index'
import { alertRowListAnswer } from './helpers/slack-alert-read'

/**
 * #2523 through the real scheduled handler: a minute job whose runs keep
 * failing still stamps its completion every minute (#985), and now pages past
 * three failed runs in a row, as the job its CRON_JOBS label names. Proved with
 * ops-connection-logins, the job the issue was found on: one that throws every
 * minute pages on the third, one that throws once does not, one whose summary
 * lists faults counts as failing, and one that recovers gets the all clear.
 */
const runOpsConnectionLoginCheckForEnv = vi.fn()
const runWritebackDrainForEnv = vi.fn()
const DRAIN_QUIET = { listed: 0, replayed: 0, refused: 0, abandoned: 0, moved: 0, retrying: 0, waiting: 0, skipped: 0, deferred: 0, unread: 0, alerts: 0, alert_failures: 0 }
const sendMinuteJobFailingAlert = vi.fn(async () => true)
const sendMinuteJobFailingRecoveryAlert = vi.fn(async () => true)

vi.mock('../lib/ops-gateway', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ops-gateway')>()),
  runOpsTickReportCheck: vi.fn().mockResolvedValue('healthy'),
}))
vi.mock('../lib/ops-connection-logins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ops-connection-logins')>()),
  runOpsConnectionLoginCheckForEnv: (...args: unknown[]) => runOpsConnectionLoginCheckForEnv(...args),
  runOpsConnectionWriteBackCheckForEnv: vi.fn().mockResolvedValue({ judged: true, paged: [], allClear: [], errors: [] }),
}))
// The other counted minute jobs, quiet, so only the job under test can fail.
vi.mock('../lib/buyer-sale-drain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/buyer-sale-drain')>()),
  runBuyerSaleDrainForEnv: vi.fn().mockResolvedValue({ skipped: true }),
}))
vi.mock('../lib/unconfirmed-write-sweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/unconfirmed-write-sweep')>()),
  runUnconfirmedWriteSweepForEnv: vi.fn().mockResolvedValue({ listed: 0, young: 0 }),
}))
vi.mock('../lib/salesforce-read-back', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/salesforce-read-back')>()),
  runSalesforceReadBackForEnv: vi.fn().mockResolvedValue({ reads: 0, unread: 0, alerts: 0 }),
}))
vi.mock('../lib/writeback-drain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/writeback-drain')>()),
  runWritebackDrainForEnv: (...args: unknown[]) => runWritebackDrainForEnv(...args),
}))
vi.mock('../lib/cache-prewarm', () => ({ prewarmKvCaches: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/cron-heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cron-heartbeat')>()),
  runHeartbeatChecks: vi.fn().mockResolvedValue([]),
}))
vi.mock('../lib/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/slack')>()),
  sendMinuteJobFailingAlert: (...args: unknown[]) => sendMinuteJobFailingAlert(...(args as [])),
  sendMinuteJobFailingRecoveryAlert: (...args: unknown[]) => sendMinuteJobFailingRecoveryAlert(...(args as [])),
}))
// One Slack organization for the page's fan out.
const db = { from: () => ({ select: () => alertRowListAnswer({ data: [{ organization_id: 'org-one' }], error: null }) }) }
vi.mock('../lib/supabase', () => ({ getSupabaseClient: () => db, createSupabaseClient: () => db }))

const worker = (await import('../index')).default
const heartbeat = await vi.importActual<typeof import('../lib/cron-heartbeat')>('../lib/cron-heartbeat')

const MIN = 60_000
const T0 = Date.parse('2026-10-20T13:00:00.000Z')
const JOB = 'ops-connection-logins'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true }),
  }
}

async function fireMinute(kv: ReturnType<typeof memoryKv>, at: number) {
  vi.setSystemTime(at)
  const env = {
    IDEMPOTENCY: kv,
    WORKFLOW_CACHE: memoryKv(),
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'k',
  } as unknown as Env
  const ctx = recordingContext()
  void worker.scheduled({ cron: '* * * * *', scheduledTime: at } as ScheduledEvent, env, ctx)
  await ctx.settle()
}

const pagedLabels = () => sendMinuteJobFailingAlert.mock.calls.map((c) => (c as unknown as [unknown, string, { label: string }])[2].label)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  runOpsConnectionLoginCheckForEnv.mockReset()
  runOpsConnectionLoginCheckForEnv.mockResolvedValue({ judged: true, paged: [], allClear: [], errors: [] })
  runWritebackDrainForEnv.mockReset()
  runWritebackDrainForEnv.mockResolvedValue(DRAIN_QUIET)
  sendMinuteJobFailingAlert.mockClear()
  sendMinuteJobFailingRecoveryAlert.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a minute job whose runs keep failing pages (#2523)', () => {
  it('pages on the third minute of a job that throws every minute, and still stamps every completion', async () => {
    runOpsConnectionLoginCheckForEnv.mockRejectedValue(new Error('the kept report could not be judged'))
    const kv = memoryKv()
    for (let m = 0; m < 2; m++) {
      await fireMinute(kv, T0 + m * MIN)
      expect(kv.store.get(heartbeat.completedKey(JOB)), `minute ${m}`).toBe(new Date(T0 + m * MIN).toISOString())
    }
    expect(sendMinuteJobFailingAlert).not.toHaveBeenCalled()
    await fireMinute(kv, T0 + 2 * MIN)
    expect(kv.store.get(heartbeat.completedKey(JOB))).toBe(new Date(T0 + 2 * MIN).toISOString())
    expect(pagedLabels()).toEqual([heartbeat.cronJob(JOB).label])
    // The job's own failure line is still written, and is the line the page names.
    expect(console.error).toHaveBeenCalledWith('[ops-connection-login] check failed:', expect.any(Error))
    const alert = (sendMinuteJobFailingAlert.mock.calls[0] as unknown as [unknown, string, { logLine: string; failedRuns: number }])[2]
    expect(alert).toMatchObject({ logLine: '[ops-connection-login] check failed:', failedRuns: 3 })
  })

  it('does not page a job that throws once', async () => {
    runOpsConnectionLoginCheckForEnv
      .mockRejectedValueOnce(new Error('one dropped connection'))
      .mockResolvedValue({ judged: true, paged: [], allClear: [], errors: [] })
    const kv = memoryKv()
    for (let m = 0; m < 5; m++) await fireMinute(kv, T0 + m * MIN)
    expect(sendMinuteJobFailingAlert).not.toHaveBeenCalled()
  })

  it('counts a run whose summary lists faults as failing, since those were only logged', async () => {
    runOpsConnectionLoginCheckForEnv.mockResolvedValue({ judged: true, paged: [], allClear: [], errors: ['a page failed'] })
    const kv = memoryKv()
    for (let m = 0; m < 3; m++) await fireMinute(kv, T0 + m * MIN)
    expect(pagedLabels()).toEqual([heartbeat.cronJob(JOB).label])
  })

  // #2527: the drain's alerts that did not reach Slack were only logged.
  it('pages the write back drain on the third minute in a row whose alerts did not reach Slack, in the drain\'s own words', async () => {
    runWritebackDrainForEnv.mockResolvedValue({ ...DRAIN_QUIET, alert_failures: 1 })
    const kv = memoryKv()
    for (let m = 0; m < 2; m++) await fireMinute(kv, T0 + m * MIN)
    expect(sendMinuteJobFailingAlert).not.toHaveBeenCalled()
    await fireMinute(kv, T0 + 2 * MIN)
    expect(pagedLabels()).toEqual([heartbeat.cronJob('writeback-drain').label])
    const alert = (sendMinuteJobFailingAlert.mock.calls[0] as unknown as [unknown, string, { logLine: string; copy?: { fault: string } }])[2]
    expect(alert.logLine).toBe('[writeback-drain] alerts not delivered:')
    expect(alert.copy?.fault).toMatch(/did not reach Slack/)
    expect(kv.store.get(heartbeat.completedKey('writeback-drain'))).toBe(new Date(T0 + 2 * MIN).toISOString())
  })

  it('does not page the drain for one minute whose alerts did not reach Slack', async () => {
    runWritebackDrainForEnv.mockResolvedValueOnce({ ...DRAIN_QUIET, alert_failures: 1 }).mockResolvedValue(DRAIN_QUIET)
    const kv = memoryKv()
    for (let m = 0; m < 5; m++) await fireMinute(kv, T0 + m * MIN)
    expect(sendMinuteJobFailingAlert).not.toHaveBeenCalled()
  })

  it('sends the all clear once a job that recovered has run 30 minutes without failing', async () => {
    runOpsConnectionLoginCheckForEnv.mockRejectedValue(new Error('the kept report could not be judged'))
    const kv = memoryKv()
    for (let m = 0; m < 3; m++) await fireMinute(kv, T0 + m * MIN)
    expect(sendMinuteJobFailingAlert).toHaveBeenCalledTimes(1)
    runOpsConnectionLoginCheckForEnv.mockResolvedValue({ judged: true, paged: [], allClear: [], errors: [] })
    await fireMinute(kv, T0 + 3 * MIN)
    expect(sendMinuteJobFailingRecoveryAlert).not.toHaveBeenCalled()
    await fireMinute(kv, T0 + 33 * MIN)
    expect(sendMinuteJobFailingRecoveryAlert).toHaveBeenCalledTimes(1)
    expect((sendMinuteJobFailingRecoveryAlert.mock.calls[0] as unknown as [unknown, string, { label: string }])[2].label).toBe(heartbeat.cronJob(JOB).label)
  })
})
