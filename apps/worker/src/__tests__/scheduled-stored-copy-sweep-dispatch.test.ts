import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../index'
import { STORED_COPY_SWEEP_BUDGET_MS } from '../lib/stored-copy-sweep'

/**
 * #1846: the stored copy sweep runs every minute, beside the prewarm, and its
 * result is logged. Invokes the real scheduled handler rather than reading the
 * source, so the cron is proven to reach the sweep.
 */
const sweepStoredCopies = vi.fn().mockResolvedValue({ checked: 3, repaired: ['partner-lastgood:p-1'], reconfirmed: [], failed: [] })

vi.mock('../lib/stored-copy-sweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/stored-copy-sweep')>()),
  sweepStoredCopies: (...args: unknown[]) => sweepStoredCopies(...args),
}))
vi.mock('../lib/cache-prewarm', () => ({ prewarmKvCaches: vi.fn().mockResolvedValue(undefined) }))
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

const WORKFLOW_CACHE = { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true }) }
const env = {
  IDEMPOTENCY: { get: async () => null, put: async () => undefined, delete: async () => undefined },
  WORKFLOW_CACHE,
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
  void worker.scheduled({ cron } as ScheduledEvent, env, ctx)
  await Promise.allSettled(waited)
}

beforeEach(() => sweepStoredCopies.mockClear())

describe('the stored copy sweep dispatch (#1846)', () => {
  it('runs every minute against the workflow cache, and logs what it repaired', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await fire('* * * * *')
    expect(sweepStoredCopies).toHaveBeenCalledTimes(1)
    expect(sweepStoredCopies.mock.calls[0][0]).toBe(WORKFLOW_CACHE)
    expect(log.mock.calls.flat().join(' ')).toMatch(/stored-copy-sweep.*repaired=1.*partner-lastgood:p-1/)
  })

  it('logs a failure it reports as an error', async () => {
    sweepStoredCopies.mockResolvedValueOnce({ checked: 1, repaired: [], reconfirmed: [], failed: ['partner copies: database down'] })
    await fire('* * * * *')
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/stored-copy-sweep.*partner copies: database down/)
  })

  it('logs how many copies it confirmed (#1847)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    sweepStoredCopies.mockResolvedValueOnce({ checked: 4, repaired: [], reconfirmed: ['ep-lastgood:a:/b', 'partner-lastgood:p-2'], failed: [] })
    await fire('* * * * *')
    expect(log.mock.calls.flat().join(' ')).toMatch(/stored-copy-sweep.*reconfirmed=2/)
  })

  // One deadline for the whole sweep, set when the minute hands it over (#2058).
  it('gives the sweep one deadline, its budget from the start of the minute', async () => {
    const before = Date.now()
    await fire('* * * * *')
    const deadlineAt = (sweepStoredCopies.mock.calls[0][2] as { deadlineAt: number }).deadlineAt
    expect(deadlineAt).toBeGreaterThanOrEqual(before + STORED_COPY_SWEEP_BUDGET_MS)
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + STORED_COPY_SWEEP_BUDGET_MS)
  })

  it('logs a sweep that stopped at its deadline, with how far it got', async () => {
    sweepStoredCopies.mockResolvedValueOnce({ checked: 7, repaired: [], reconfirmed: [], failed: ['the sweep: it stopped at its deadline with 3 partner copies left'], stopped: 'deadline', left: 3, notReached: ['bid matrix copies'] })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await fire('* * * * *')
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toContain('[stored-copy-sweep] stopped at its deadline: checked=7 left=3 not_reached=bid matrix copies')
  })

  it('runs from no other cron', async () => {
    for (const cron of ['0 9 * * *', '0 13 * * *', '0 * * * *']) {
      sweepStoredCopies.mockClear()
      await fire(cron)
      expect(sweepStoredCopies, `${cron} ran the sweep`).not.toHaveBeenCalled()
    }
  })
})
