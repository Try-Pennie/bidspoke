import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recordingContext } from '../test-setup/wait-until'
import type { Env } from '../index'
import { alertRowListAnswer } from './helpers/slack-alert-read'

/**
 * #2526 through the real scheduled handler: the five minute, fifteen minute and
 * hourly jobs stamped through completeAfter hand a throw to it, so one that
 * throws on every run still stamps its completion and pages at its cadence's
 * bound (minute-job-failures.ts FAILED_RUN_CADENCES): the third five or fifteen
 * minute run, the second hourly one. One job per cadence, each the subject of
 * its test; the labels paged are read for that job alone, since the other jobs
 * on the cron run against a test double of the database.
 */
const runPartnerReachabilityCheck = vi.fn()
const runBuyerSalesChecksForEnv = vi.fn()
const runEngineScriptDriftForEnv = vi.fn()
const runTripointPingOutcomeRateForEnv = vi.fn()
const sendMinuteJobFailingAlert = vi.fn(async () => true)
const sendMinuteJobFailingRecoveryAlert = vi.fn(async () => true)
const notifyExportFailure = vi.fn(async (..._args: unknown[]) => {})

vi.mock('../lib/tripoint-ping-outcome-rate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tripoint-ping-outcome-rate')>()),
  runTripointPingOutcomeRateForEnv: (...args: unknown[]) => runTripointPingOutcomeRateForEnv(...args),
}))
// Recorded, so a job's own summary page is seen (buyer-select-parity's, #2529).
vi.mock('../lib/export-alerts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/export-alerts')>()),
  notifyExportFailure: (...args: unknown[]) => notifyExportFailure(...args),
}))

vi.mock('../lib/partner-reachability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/partner-reachability')>()),
  runPartnerReachabilityCheck: (...args: unknown[]) => runPartnerReachabilityCheck(...args),
}))
vi.mock('../lib/buyer-sales-checks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/buyer-sales-checks')>()),
  runBuyerSalesChecksForEnv: (...args: unknown[]) => runBuyerSalesChecksForEnv(...args),
}))
vi.mock('../lib/engine-script-drift', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/engine-script-drift')>()),
  runEngineScriptDriftForEnv: (...args: unknown[]) => runEngineScriptDriftForEnv(...args),
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

async function fire(kv: ReturnType<typeof memoryKv>, cron: string, at: number) {
  vi.setSystemTime(at)
  const env = {
    IDEMPOTENCY: kv,
    WORKFLOW_CACHE: memoryKv(),
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'k',
  } as unknown as Env
  const ctx = recordingContext()
  void worker.scheduled({ cron, scheduledTime: at } as ScheduledEvent, env, ctx)
  await ctx.settle()
}

const pagesFor = (jobId: string) =>
  sendMinuteJobFailingAlert.mock.calls
    .map((c) => (c as unknown as [unknown, string, { label: string; logLine: string; failedRuns: number }])[2])
    .filter((a) => a.label === heartbeat.cronJob(jobId).label)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  runPartnerReachabilityCheck.mockReset()
  runBuyerSalesChecksForEnv.mockReset()
  runEngineScriptDriftForEnv.mockReset()
  runTripointPingOutcomeRateForEnv.mockReset()
  runTripointPingOutcomeRateForEnv.mockResolvedValue(pingSummary([]))
  sendMinuteJobFailingAlert.mockClear()
  sendMinuteJobFailingRecoveryAlert.mockClear()
  notifyExportFailure.mockClear()
})

/** A tripoint ping outcome rate run that judged the hour normal, with these hours not recorded. */
function pingSummary(rollupErrors: string[]) {
  return {
    window: { from: '', to: '', counts: { sent: 120, accepted: 70, declined: 50, failed: 0 } },
    baseline: { attempts: 20_000, hours: 336 },
    verdict: { verdict: 'normal', detail: 'within its baseline' },
    rolled_up_hours: 0,
    rollup_errors: rollupErrors,
    lines: [],
  }
}

const HOUR_LOST = 'the hour from 2026-10-20T12:00:00.000Z: execution_steps tripoint_ping total count: canceling statement due to statement timeout'

afterEach(() => {
  vi.useRealTimers()
})

describe('a slower job whose runs keep failing pages at its cadence\'s bound (#2526)', () => {
  it('pages the five minute partner probe on its third failed run, and still stamps every completion', async () => {
    runPartnerReachabilityCheck.mockRejectedValue(new Error('the probe could not start'))
    const kv = memoryKv()
    for (let r = 0; r < 2; r++) {
      await fire(kv, '*/5 * * * *', T0 + r * 5 * MIN)
      expect(kv.store.get(heartbeat.completedKey('partner-reachability')), `run ${r}`).toBe(new Date(T0 + r * 5 * MIN).toISOString())
    }
    expect(pagesFor('partner-reachability')).toEqual([])
    await fire(kv, '*/5 * * * *', T0 + 10 * MIN)
    expect(pagesFor('partner-reachability')).toMatchObject([{ logLine: '[partner-reachability] check failed:', failedRuns: 3 }])
    expect(console.error).toHaveBeenCalledWith('[partner-reachability] check failed:', expect.any(Error))
  })

  it('does not page the five minute partner probe for one failed run', async () => {
    runPartnerReachabilityCheck
      .mockRejectedValueOnce(new Error('one dropped connection'))
      .mockResolvedValue({ probed: 0, reachable: 0, blocked: 0, unreachable: 0, unmeasured: 0, alerts: [], allClears: [], errors: [], mode: 'alert' })
    const kv = memoryKv()
    for (let r = 0; r < 4; r++) await fire(kv, '*/5 * * * *', T0 + r * 5 * MIN)
    expect(pagesFor('partner-reachability')).toEqual([])
  })

  it('pages the fifteen minute buyer sales checks on their third failed run', async () => {
    runBuyerSalesChecksForEnv.mockRejectedValue(new Error('the ledger could not be read'))
    const kv = memoryKv()
    for (let r = 0; r < 2; r++) await fire(kv, '*/15 * * * *', T0 + r * 15 * MIN)
    expect(pagesFor('buyer-sales-checks')).toEqual([])
    await fire(kv, '*/15 * * * *', T0 + 30 * MIN)
    expect(pagesFor('buyer-sales-checks')).toMatchObject([{ logLine: '[buyer-sales-checks] checks failed:', failedRuns: 3 }])
  })

  it('pages the hourly engine script drift check on its second failed run', async () => {
    runEngineScriptDriftForEnv.mockRejectedValue(new Error('the job run could not be recorded'))
    const kv = memoryKv()
    await fire(kv, '0 * * * *', T0)
    expect(pagesFor('engine-script-drift')).toEqual([])
    await fire(kv, '0 * * * *', T0 + 60 * MIN)
    expect(pagesFor('engine-script-drift')).toMatchObject([{ logLine: '[engine-script-drift] check failed:', failedRuns: 2 }])
    expect(kv.store.get(heartbeat.completedKey('engine-script-drift'))).toBe(new Date(T0 + 60 * MIN).toISOString())
  })
})

/**
 * #2529: the summary faults of two jobs that were only logged. The Tripoint
 * ping outcome rate's hours not recorded are a failed run of that job, with its
 * own words. buyer-select-parity's days not summarised already page through the
 * export alerter, with its all clear, so they are not counted as well.
 */
describe('a slower job\'s summary faults that were only logged (#2529)', () => {
  it('pages the Tripoint ping outcome rate on the third run in a row whose finished hours were not recorded, in its own words', async () => {
    runTripointPingOutcomeRateForEnv.mockResolvedValue(pingSummary([HOUR_LOST]))
    const kv = memoryKv()
    for (let r = 0; r < 2; r++) await fire(kv, '*/15 * * * *', T0 + r * 15 * MIN)
    expect(pagesFor('tripoint-ping-outcome-rate')).toEqual([])
    await fire(kv, '*/15 * * * *', T0 + 30 * MIN)
    const pages = pagesFor('tripoint-ping-outcome-rate') as unknown as Array<{ logLine: string; failedRuns: number; copy?: { fault: string; effect: string } }>
    expect(pages).toMatchObject([{ logLine: '[tripoint-ping-outcome-rate] hours not recorded:', failedRuns: 3 }])
    expect(pages[0].copy?.fault).toMatch(/could not be counted and kept for its baseline/)
    expect(pages[0].copy?.effect).toMatch(/left out of it for good/)
    expect(console.error).toHaveBeenCalledWith(`[tripoint-ping-outcome-rate] hours not recorded: ${HOUR_LOST}`)
    expect(kv.store.get(heartbeat.completedKey('tripoint-ping-outcome-rate'))).toBe(new Date(T0 + 30 * MIN).toISOString())
  })

  it('does not page the Tripoint ping outcome rate for one run whose hours were not recorded, which the next run records', async () => {
    runTripointPingOutcomeRateForEnv.mockResolvedValueOnce(pingSummary([HOUR_LOST])).mockResolvedValue(pingSummary([]))
    const kv = memoryKv()
    for (let r = 0; r < 5; r++) await fire(kv, '*/15 * * * *', T0 + r * 15 * MIN)
    expect(pagesFor('tripoint-ping-outcome-rate')).toEqual([])
  })

  it('sends the Tripoint ping outcome rate\'s all clear once it has recorded its hours for 30 minutes', async () => {
    runTripointPingOutcomeRateForEnv.mockResolvedValue(pingSummary([HOUR_LOST]))
    const kv = memoryKv()
    for (let r = 0; r < 3; r++) await fire(kv, '*/15 * * * *', T0 + r * 15 * MIN)
    expect(pagesFor('tripoint-ping-outcome-rate')).toHaveLength(1)
    runTripointPingOutcomeRateForEnv.mockResolvedValue(pingSummary([]))
    for (let r = 3; r < 6; r++) await fire(kv, '*/15 * * * *', T0 + r * 15 * MIN)
    const clears = sendMinuteJobFailingRecoveryAlert.mock.calls
      .map((c) => (c as unknown as [unknown, string, { label: string }])[2])
      .filter((a) => a.label === heartbeat.cronJob('tripoint-ping-outcome-rate').label)
    expect(clears).toHaveLength(1)
  })

  it('leaves buyer-select-parity\'s days not summarised to its own export alerter page, and does not count them as failed runs', async () => {
    // The test double of the database cannot answer the workflow list, so every run's summary lists that fault.
    const kv = memoryKv()
    for (let r = 0; r < 3; r++) await fire(kv, '0 * * * *', T0 + r * 60 * MIN)
    const own = notifyExportFailure.mock.calls.filter((c) => c[1] === 'buyer-select-parity')
    expect(own).toHaveLength(3)
    for (const c of own) expect((c[2] as string[]).join(' ')).toMatch(/the workflow list could not be read/)
    expect(pagesFor('buyer-select-parity')).toEqual([])
  })
})
