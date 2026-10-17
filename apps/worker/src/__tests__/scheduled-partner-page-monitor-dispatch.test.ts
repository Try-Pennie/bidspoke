import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../test-setup/wait-until'
import type { Env } from '../index'

/**
 * #2135: the partners page delivery monitor runs on the existing five minute
 * cron (decision 2: no tenth cron expression) and nowhere else, stamping its own
 * heartbeat with the alert store. Invokes the real scheduled handler rather than
 * reading the source, so the cron is proven to reach the check.
 */
const runPartnerPageMonitor = vi.fn().mockResolvedValue({ mode: 'alert', outcome: 'received', alerts: [], allClears: [], errors: [] })
const writeHeartbeat = vi.fn().mockResolvedValue(undefined)

vi.mock('../lib/partner-page-monitor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/partner-page-monitor')>()),
  runPartnerPageMonitor: (...args: unknown[]) => runPartnerPageMonitor(...args),
}))
vi.mock('../lib/partner-reachability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/partner-reachability')>()),
  runPartnerReachabilityCheck: vi.fn().mockResolvedValue({ probed: 0, reachable: 0, blocked: 0, unreachable: 0, unmeasured: 0, alerts: [], allClears: [], errors: [], mode: 'observe' }),
}))
vi.mock('../lib/database-memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/database-memory')>()),
  runDatabaseMemoryCheck: vi.fn().mockResolvedValue({ state: 'ok', freeShare: 0.5, alerts: [], allClears: [], errors: [], mode: 'alert' }),
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
  runPartnerPageMonitor.mockClear()
  writeHeartbeat.mockClear()
})

describe('the partners page delivery monitor dispatch (#2135)', () => {
  it('runs on the five minute cron, stamping its own heartbeat, with the alert store', async () => {
    await fire('*/5 * * * *')
    expect(runPartnerPageMonitor).toHaveBeenCalledTimes(1)
    expect(runPartnerPageMonitor.mock.calls[0][0].kv).toBe(env.IDEMPOTENCY)
    expect(writeHeartbeat.mock.calls.map((c) => c[1])).toContain('partner-page-monitor')
  })

  it('runs from no other cron', async () => {
    for (const cron of ['0 9 * * *', '0 13 * * *', '0 * * * *', '*/15 * * * *', '* * * * *']) {
      runPartnerPageMonitor.mockClear()
      await fire(cron)
      expect(runPartnerPageMonitor, `${cron} ran the check`).not.toHaveBeenCalled()
    }
  })
})
