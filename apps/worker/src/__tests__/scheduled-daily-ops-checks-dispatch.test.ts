import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../test-setup/wait-until'
import type { Env } from '../index'

/**
 * The two daily checks on the bidding Worker: the ops connection owner check
 * (#2340) and the Salesforce bulkhead limit check (#2336). Each runs on the
 * 13:00 batch and nowhere else, and stamps its own heartbeat, started and then
 * completed whichever way its run ended (L514). Invokes the real scheduled
 * handler rather than reading the source.
 */
const runOpsConnectionOwnerCheckForEnv = vi.fn().mockResolvedValue({ judged: true, personBound: 0, orphaned: [], paged: [], allClear: [], unreadable: [], errors: [] })
const runSalesforceBulkheadCheckForEnv = vi.fn().mockResolvedValue({ limit: 20, sizedFor: 20, verdict: 'matches', paged: 0, toldNobody: false, allClear: false, errors: [] })
const writeHeartbeat = vi.fn().mockResolvedValue(undefined)
const writeHeartbeatCompleted = vi.fn().mockResolvedValue(undefined)

vi.mock('../lib/ops-connection-owner-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ops-connection-owner-check')>()),
  runOpsConnectionOwnerCheckForEnv: (...args: unknown[]) => runOpsConnectionOwnerCheckForEnv(...args),
}))
vi.mock('../lib/salesforce-bulkhead-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/salesforce-bulkhead-check')>()),
  runSalesforceBulkheadCheckForEnv: (...args: unknown[]) => runSalesforceBulkheadCheckForEnv(...args),
}))
vi.mock('../lib/cron-heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cron-heartbeat')>()),
  writeHeartbeat: (...args: unknown[]) => writeHeartbeat(...args),
  writeHeartbeatCompleted: (...args: unknown[]) => writeHeartbeatCompleted(...args),
  runHeartbeatChecks: vi.fn().mockResolvedValue([]),
}))
vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ from: () => ({ select: () => ({}) }) }),
  createSupabaseClient: () => ({ from: () => ({ select: () => ({}) }) }),
}))

const worker = (await import('../index')).default

const env = {
  IDEMPOTENCY: { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true }) },
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'k',
} as unknown as Env

async function fire(cron: string) {
  const ctx = recordingContext()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  void worker.scheduled({ cron } as ScheduledEvent, env, ctx)
  await ctx.settle()
}

const CHECKS = [
  { id: 'ops-connection-owner', run: runOpsConnectionOwnerCheckForEnv },
  { id: 'salesforce-bulkhead-check', run: runSalesforceBulkheadCheckForEnv },
] as const

beforeEach(() => {
  for (const c of CHECKS) c.run.mockClear()
  writeHeartbeat.mockClear()
  writeHeartbeatCompleted.mockClear()
})

describe('the daily ops checks on the bidding Worker', () => {
  it.each(CHECKS)('$id runs once on the 13:00 batch and stamps its start and its completion', async ({ id, run }) => {
    await fire('0 13 * * *')
    expect(run).toHaveBeenCalledTimes(1)
    expect(writeHeartbeat.mock.calls.map((c) => c[1])).toContain(id)
    expect(writeHeartbeatCompleted.mock.calls.map((c) => c[1])).toContain(id)
  })

  it.each(CHECKS)('$id still stamps its completion when its run throws', async ({ id, run }) => {
    run.mockRejectedValueOnce(new Error('the database refused the read'))
    await fire('0 13 * * *')
    expect(writeHeartbeatCompleted.mock.calls.map((c) => c[1])).toContain(id)
  })

  it.each(CHECKS)('$id runs from no other cron', async ({ run }) => {
    for (const cron of ['0 9 * * *', '0 * * * *', '*/5 * * * *', '* * * * *']) {
      run.mockClear()
      await fire(cron)
      expect(run, `${cron} ran the check`).not.toHaveBeenCalled()
    }
  })
})
