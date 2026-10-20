import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordingContext } from '../test-setup/wait-until'
import type { Env } from '../index'
import { alertRowListAnswer } from './helpers/slack-alert-read'

/**
 * #2519: the two minute jobs that turn the ops tick's report into pages,
 * ops-tick-report and ops-connection-logins, each stamp their own heartbeat
 * (started, then completed once the run settles), and each has its own
 * CRON_JOBS entry. Invokes the real scheduled handler with a real KV map, so
 * the stamps are proven to come from the minute cron, and then the real
 * heartbeat check over that map: a job that stops running pages as itself.
 */
const runOpsTickReportCheck = vi.fn().mockResolvedValue('healthy')
const runOpsConnectionLoginCheckForEnv = vi.fn().mockResolvedValue({ judged: true, paged: [], allClear: [], errors: [] })
const runOpsConnectionWriteBackCheckForEnv = vi.fn().mockResolvedValue({ judged: true, paged: [], allClear: [], errors: [] })
const sendCronHeartbeatAlert = vi.fn(async () => true)

vi.mock('../lib/ops-gateway', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ops-gateway')>()),
  runOpsTickReportCheck: (...args: unknown[]) => runOpsTickReportCheck(...args),
}))
vi.mock('../lib/ops-connection-logins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ops-connection-logins')>()),
  runOpsConnectionLoginCheckForEnv: (...args: unknown[]) => runOpsConnectionLoginCheckForEnv(...args),
  runOpsConnectionWriteBackCheckForEnv: (...args: unknown[]) => runOpsConnectionWriteBackCheckForEnv(...args),
}))
vi.mock('../lib/cache-prewarm', () => ({ prewarmKvCaches: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/cron-heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cron-heartbeat')>()),
  // The tick's own heartbeat check is run by hand below, at a later clock.
  runHeartbeatChecks: vi.fn().mockResolvedValue([]),
}))
vi.mock('../lib/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/slack')>()),
  sendCronHeartbeatAlert: (...args: unknown[]) => sendCronHeartbeatAlert(...(args as [])),
}))
vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ from: () => ({ select: () => ({}) }) }),
  createSupabaseClient: () => ({ from: () => ({ select: () => ({}) }) }),
}))

const worker = (await import('../index')).default
const heartbeat = await vi.importActual<typeof import('../lib/cron-heartbeat')>('../lib/cron-heartbeat')

const MIN = 60_000

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

/** The heartbeat check's two reads: one Slack organization, and no job_runs row to vouch for a job. */
function heartbeatSupabase(): SupabaseClient {
  const runs = { select: () => runs, eq: () => runs, not: () => runs, order: () => runs, limit: () => Promise.resolve({ data: [], error: null }) }
  return {
    from: (table: string) => (table === 'job_runs' ? runs : { select: () => alertRowListAnswer({ data: [{ organization_id: 'org-one' }], error: null }) }),
  } as unknown as SupabaseClient
}

async function fireMinute(kv: ReturnType<typeof memoryKv>) {
  const env = {
    IDEMPOTENCY: kv,
    WORKFLOW_CACHE: memoryKv(),
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'k',
  } as unknown as Env
  const ctx = recordingContext()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  void worker.scheduled({ cron: '* * * * *' } as ScheduledEvent, env, ctx)
  await ctx.settle()
}

const JOBS = ['ops-tick-report', 'ops-connection-logins', 'ops-connection-write-backs'] as const

beforeEach(() => {
  runOpsTickReportCheck.mockClear()
  runOpsConnectionLoginCheckForEnv.mockClear()
  runOpsConnectionWriteBackCheckForEnv.mockClear()
  sendCronHeartbeatAlert.mockClear()
})

describe('the ops report minute jobs have their own heartbeat (#2519)', () => {
  it('registers each in CRON_JOBS as a minute job, judged on a drought of finished runs', () => {
    for (const id of JOBS) {
      const job = heartbeat.cronJob(id)
      expect(job.triggerCron, id).toBe('* * * * *')
      expect(job.worker, id).toBeUndefined()
      expect(job.staleMs, id).toBe(10 * MIN)
      expect(job.completionDroughtMs, id).toBe(10 * MIN)
      expect(job.maxRunMs, id).toBeLessThan(MIN)
    }
  })

  it.each(JOBS)('%s stamps its start and its completion on the minute cron', async (id) => {
    const kv = memoryKv()
    const before = Date.now()
    await fireMinute(kv)
    expect(runOpsTickReportCheck).toHaveBeenCalledTimes(1)
    expect(runOpsConnectionLoginCheckForEnv).toHaveBeenCalledTimes(1)
    const started = kv.store.get(heartbeat.heartbeatKey(id))
    const completed = kv.store.get(heartbeat.completedKey(id))
    expect(started, `${id} started stamp`).toBeDefined()
    expect(completed, `${id} completed stamp`).toBeDefined()
    expect(Date.parse(started!)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(completed!)).toBeGreaterThanOrEqual(Date.parse(started!))
  })

  it.each(JOBS)('%s pages as dark once it stops running', async (id) => {
    const kv = memoryKv()
    await fireMinute(kv)
    // The job stops: no tick stamps it again, and the check looks 11 minutes on.
    const later = Date.now() + 11 * MIN
    const results = await heartbeat.runHeartbeatChecks(heartbeatSupabase(), kv as unknown as KVNamespace, later)
    const mine = results.find((r) => r.jobId === id)
    expect(mine?.status, id).toBe('stale')
    expect(mine?.alerted, id).toBe(true)
    const paged = sendCronHeartbeatAlert.mock.calls.map((c) => (c as unknown as [unknown, string, { label: string }])[2].label)
    expect(paged).toContain(heartbeat.cronJob(id).label)
  })

  it.each(JOBS)('%s pages as never finishing when its runs start every minute and none completes', async (id) => {
    const kv = memoryKv()
    const t0 = Date.now()
    // A completed stamp the check has watched for, then ten minutes of starts with no completion.
    await heartbeat.writeHeartbeat(kv as unknown as KVNamespace, id, t0)
    await heartbeat.writeHeartbeatCompleted(kv as unknown as KVNamespace, id, t0)
    await heartbeat.runHeartbeatChecks(heartbeatSupabase(), kv as unknown as KVNamespace, t0 + 30_000)
    for (let m = 1; m <= 11; m++) await heartbeat.writeHeartbeat(kv as unknown as KVNamespace, id, t0 + m * MIN)
    const results = await heartbeat.runHeartbeatChecks(heartbeatSupabase(), kv as unknown as KVNamespace, t0 + 11 * MIN + 30_000)
    expect(results.find((r) => r.jobId === id)?.status, id).toBe('vanished')
  })
})
