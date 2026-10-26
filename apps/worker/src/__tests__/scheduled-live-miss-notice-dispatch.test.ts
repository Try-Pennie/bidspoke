import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordingContext } from '../test-setup/wait-until'
import type { Env } from '../index'
import { loadWorker } from '../test-setup/load-worker'

/**
 * #2220: the live miss notice runs on the existing five minute cron and nowhere
 * else, stamping its own heartbeat, with the alert store and the claim object.
 * Invokes the real scheduled handler rather than reading the source, so the
 * cron is proven to reach the check.
 */
const runLiveMissNoticeForEnv = vi.fn().mockResolvedValue({ mode: 'post', outcome: 'no_misses', read: 0, posted: [], notPosted: [], alreadySent: [], waiting: [], failed: [], more: false, errors: [] })
const writeHeartbeat = vi.fn().mockResolvedValue(undefined)

vi.mock('../lib/partner-live-miss-notice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/partner-live-miss-notice')>()),
  runLiveMissNoticeForEnv: (...args: unknown[]) => runLiveMissNoticeForEnv(...args),
}))
vi.mock('../lib/partner-page-monitor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/partner-page-monitor')>()),
  runPartnerPageMonitor: vi.fn().mockResolvedValue({ mode: 'alert', outcome: 'received', alerts: [], allClears: [], errors: [] }),
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

const { default: worker } = await loadWorker()

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
  runLiveMissNoticeForEnv.mockClear()
  writeHeartbeat.mockClear()
})

describe('the live miss notice dispatch (#2220)', () => {
  it('runs on the five minute cron, stamping its own heartbeat, with the alert store', async () => {
    await fire('*/5 * * * *')
    expect(runLiveMissNoticeForEnv).toHaveBeenCalledTimes(1)
    expect(runLiveMissNoticeForEnv.mock.calls[0][0].kv).toBe(env.IDEMPOTENCY)
    expect(runLiveMissNoticeForEnv.mock.calls[0][0].localDev).toBe(false)
    expect(writeHeartbeat.mock.calls.map((c) => c[1])).toContain('partner-live-miss-notice')
  })

  it('runs from no other cron', async () => {
    for (const cron of ['0 9 * * *', '0 13 * * *', '0 * * * *', '*/15 * * * *', '* * * * *']) {
      runLiveMissNoticeForEnv.mockClear()
      await fire(cron)
      expect(runLiveMissNoticeForEnv, `${cron} ran the check`).not.toHaveBeenCalled()
    }
  })
})
