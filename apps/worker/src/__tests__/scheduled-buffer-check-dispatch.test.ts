import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../index'

/**
 * #463: the sightings buffer watchdog runs on the daily 13:00 batch and nowhere
 * else. Invokes the real scheduled handler rather than reading the source, so
 * the cron is proven to reach the check rather than to be mentioned near it.
 */
const runSightingsBufferCheck = vi.fn().mockResolvedValue({ findings: [], unmeasured: [] })

vi.mock('../lib/sightings-buffer-lag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/sightings-buffer-lag')>()),
  runSightingsBufferCheck: (...args: unknown[]) => runSightingsBufferCheck(...args),
}))
vi.mock('../lib/cron-heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cron-heartbeat')>()),
  writeHeartbeat: vi.fn().mockResolvedValue(undefined),
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
  const waited: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => waited.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  worker.scheduled({ cron } as ScheduledEvent, env, ctx)
  await Promise.allSettled(waited)
}

beforeEach(() => runSightingsBufferCheck.mockClear())

describe('the sightings buffer watchdog dispatch (#463)', () => {
  it('runs on the daily 13:00 batch, with the alert store', async () => {
    await fire('0 13 * * *')
    expect(runSightingsBufferCheck).toHaveBeenCalledTimes(1)
    expect(runSightingsBufferCheck.mock.calls[0][1]).toBe(env.IDEMPOTENCY)
  })

  it('runs from no other cron', async () => {
    for (const cron of ['0 9 * * *', '37 */2 * * *', '47 1-23/2 * * *', '47 0-22/2 * * *', '0 * * * *', '* * * * *']) {
      runSightingsBufferCheck.mockClear()
      await fire(cron)
      expect(runSightingsBufferCheck, `${cron} ran the watchdog`).not.toHaveBeenCalled()
    }
  })
})
