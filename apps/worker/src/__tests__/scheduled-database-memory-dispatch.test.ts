import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../test-setup/wait-until'
import type { Env } from '../index'

/**
 * #1928: the database memory check runs on the five minute cron and nowhere else, reading
 * the feed for the project the worker is configured against. Invokes the real scheduled
 * handler rather than reading the source, so the cron is proven to reach the check.
 */
const runDatabaseMemoryCheck = vi.fn().mockResolvedValue({ state: 'ok', freeShare: 0.5, alerts: [], allClears: [], errors: [], mode: 'alert' })
const runPartnerReachabilityCheck = vi.fn().mockResolvedValue({ probed: 0, reachable: 0, blocked: 0, unreachable: 0, unmeasured: 0, alerts: [], allClears: [], errors: [], mode: 'observe' })
const writeHeartbeat = vi.fn().mockResolvedValue(undefined)

vi.mock('../lib/database-memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/database-memory')>()),
  runDatabaseMemoryCheck: (...args: unknown[]) => runDatabaseMemoryCheck(...args),
}))
vi.mock('../lib/partner-reachability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/partner-reachability')>()),
  runPartnerReachabilityCheck: (...args: unknown[]) => runPartnerReachabilityCheck(...args),
}))
vi.mock('../lib/cron-heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cron-heartbeat')>()),
  writeHeartbeat: (...args: unknown[]) => writeHeartbeat(...args),
  writeHeartbeatCompleted: vi.fn().mockResolvedValue(undefined),
  runHeartbeatChecks: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ from: () => ({ select: () => ({}) }) }),
  createSupabaseClient: () => ({ from: () => ({ select: () => ({}) }) }),
}))

const worker = (await import('../index')).default

const env = {
  IDEMPOTENCY: { get: async () => null, put: async () => undefined, delete: async () => undefined },
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

beforeEach(() => {
  runDatabaseMemoryCheck.mockClear()
  writeHeartbeat.mockClear()
})

describe('the database memory check dispatch (#1928)', () => {
  it('runs on the five minute cron, stamping its own heartbeat, with the alert store', async () => {
    await fire('*/5 * * * *')
    expect(runDatabaseMemoryCheck).toHaveBeenCalledTimes(1)
    expect(runDatabaseMemoryCheck.mock.calls[0][0].kv).toBe(env.IDEMPOTENCY)
    expect(writeHeartbeat.mock.calls.map((c) => c[1])).toContain('database-memory')
  })

  it('runs from no other cron', async () => {
    for (const cron of ['0 9 * * *', '0 13 * * *', '0 * * * *', '*/15 * * * *', '* * * * *']) {
      runDatabaseMemoryCheck.mockClear()
      await fire(cron)
      expect(runDatabaseMemoryCheck, `${cron} ran the check`).not.toHaveBeenCalled()
    }
  })
})
