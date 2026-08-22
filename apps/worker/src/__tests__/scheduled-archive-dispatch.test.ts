import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../index'

/**
 * The cron wiring guard asserts a branch EXISTS for every scheduled cron, by
 * reading the source. That is text matching, and text matching cannot tell a
 * branch that dispatches from a branch that dispatches the WRONG thing.
 *
 * This invokes the real scheduled handler and asserts which job ran, so the
 * archive's cron is proven to reach the archive rather than proven to be
 * mentioned near it.
 */
const runExecutionArchive = vi.fn().mockResolvedValue({
  stop: 'caught-up',
  failed: false,
  hoursArchived: 0,
  hoursEmpty: 0,
  executionsArchived: 0,
  executionsRefused: 0,
  hoursBehind: 0,
  detail: 'test',
})
const sendArchiveBatch = vi.fn()
const runArchiveGate = vi.fn().mockResolvedValue({
  daysConsidered: 0,
  daysMeasured: 0,
  daysDeletable: 0,
  results: [],
  failed: false,
  detail: 'test',
})
const writeHeartbeat = vi.fn().mockResolvedValue(undefined)

vi.mock('../lib/execution-archive', () => ({
  runExecutionArchive: (...args: unknown[]) => runExecutionArchive(...args),
}))
vi.mock('../lib/execution-archive-send', () => ({
  sendArchiveBatch: (...args: unknown[]) => sendArchiveBatch(...args),
}))
vi.mock('../lib/archive-gate', () => ({
  runArchiveGate: (...args: unknown[]) => runArchiveGate(...args),
}))
vi.mock('../lib/cron-heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cron-heartbeat')>()),
  writeHeartbeat: (...args: unknown[]) => writeHeartbeat(...args),
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

function ctxWith(waited: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p)
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext
}

beforeEach(() => {
  runExecutionArchive.mockClear()
  writeHeartbeat.mockClear()
  runArchiveGate.mockClear()
})

describe('the scheduled handler', () => {
  it('runs the execution archive on its own cron', async () => {
    const waited: Promise<unknown>[] = []

    worker.scheduled({ cron: '23 * * * *' } as ScheduledEvent, env, ctxWith(waited))
    await Promise.all(waited)

    expect(runExecutionArchive).toHaveBeenCalledTimes(1)
  })

  it('writes the archive heartbeat under the id the registry declares', async () => {
    const waited: Promise<unknown>[] = []

    worker.scheduled({ cron: '23 * * * *' } as ScheduledEvent, env, ctxWith(waited))
    await Promise.all(waited)

    expect(writeHeartbeat).toHaveBeenCalledWith(expect.anything(), 'execution-archive')
  })

  // The archive's cron must be ITS cron. Dispatching it from the :00 hourly slot
  // would run it alongside the partner sync and the pg_cron drain, and the
  // wiring guard would still pass because a branch for its cron would exist.
  it('does not run the archive from any other cron', async () => {
    for (const cron of ['0 * * * *', '0 13 * * *', '37 */2 * * *', '* * * * *']) {
      runExecutionArchive.mockClear()
      const waited: Promise<unknown>[] = []

      worker.scheduled({ cron } as ScheduledEvent, env, ctxWith(waited))
      await Promise.allSettled(waited)

      expect(runExecutionArchive, `${cron} ran the archive`).not.toHaveBeenCalled()
    }
  })

  it('runs the deletion gate measurement on the daily batch', async () => {
    // Its own assertion rather than trust in the wiring guard, which reads the
    // source and cannot tell a branch that dispatches from one that dispatches
    // the wrong thing. Daily, because it re-measures every day still inside the
    // 7 day retention window and its staleness limit is one cadence plus slack.
    const waited: Promise<unknown>[] = []

    worker.scheduled({ cron: '0 13 * * *' } as ScheduledEvent, env, ctxWith(waited))
    await Promise.allSettled(waited)

    expect(runArchiveGate).toHaveBeenCalledTimes(1)
  })

  it('does not run the deletion gate measurement from any other cron', async () => {
    // Running it from the hourly slot would measure six days twelve times a day
    // against production volume, and the wiring guard would still pass.
    for (const cron of ['23 * * * *', '0 * * * *', '37 */2 * * *', '* * * * *']) {
      runArchiveGate.mockClear()
      const waited: Promise<unknown>[] = []

      worker.scheduled({ cron } as ScheduledEvent, env, ctxWith(waited))
      await Promise.allSettled(waited)

      expect(runArchiveGate, `${cron} ran the gate measurement`).not.toHaveBeenCalled()
    }
  })

  it('hands the archive a send function rather than letting it invent one', async () => {
    const waited: Promise<unknown>[] = []

    worker.scheduled({ cron: '23 * * * *' } as ScheduledEvent, env, ctxWith(waited))
    await Promise.all(waited)

    const deps = runExecutionArchive.mock.calls[0]?.[2] as { sendBatch?: unknown }
    expect(typeof deps?.sendBatch).toBe('function')
  })
})
