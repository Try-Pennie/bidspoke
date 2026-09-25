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
const checkArchiveIdentities = vi.fn().mockResolvedValue({ observations: [], findings: [], alerted: false })
const checkArchiveSettings = vi.fn().mockResolvedValue({
  observed: { retentionDays: 30, retentionLevel: 'TABLE', columns: [], unreadable: [] },
  differences: [],
  alerted: false,
})
const runArchiveGate = vi.fn().mockResolvedValue({
  daysConsidered: 0,
  daysMeasured: 0,
  daysDeletable: 0,
  results: [],
  failed: false,
  detail: 'test',
})
const writeHeartbeat = vi.fn().mockResolvedValue(undefined)
const writeHeartbeatCompleted = vi.fn().mockResolvedValue(undefined)

vi.mock('../lib/execution-archive', () => ({
  runExecutionArchive: (...args: unknown[]) => runExecutionArchive(...args),
}))
// The one send function the archive callers share (#1443). Returns a marker so
// a test can prove the run was handed exactly what archiveSender built.
const archiveSenderMarker = vi.fn()
const archiveSender = vi.fn(() => archiveSenderMarker)
vi.mock('../lib/execution-archive-send', () => ({
  sendArchiveBatch: (...args: unknown[]) => sendArchiveBatch(...args),
  archiveSender: (...args: unknown[]) => (archiveSender as (...a: unknown[]) => unknown)(...args),
}))
vi.mock('../lib/archive-gate', () => ({
  runArchiveGate: (...args: unknown[]) => runArchiveGate(...args),
}))
vi.mock('../lib/archive-settings-check', () => ({
  checkArchiveSettings: (...args: unknown[]) => checkArchiveSettings(...args),
}))
vi.mock('../lib/archive-identity-check', () => ({
  checkArchiveIdentities: (...args: unknown[]) => checkArchiveIdentities(...args),
}))
vi.mock('../lib/cron-heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cron-heartbeat')>()),
  writeHeartbeat: (...args: unknown[]) => writeHeartbeat(...args),
  writeHeartbeatCompleted: (...args: unknown[]) => writeHeartbeatCompleted(...args),
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
  runExecutionArchive.mockResolvedValue({
    stop: 'caught-up', failed: false, hoursArchived: 0, hoursEmpty: 0, executionsArchived: 0, executionsRefused: 0, hoursBehind: 0, detail: 'test',
  })
  writeHeartbeat.mockClear()
  writeHeartbeatCompleted.mockClear()
  runArchiveGate.mockClear()
  checkArchiveSettings.mockClear()
  checkArchiveIdentities.mockClear()
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

  it('reads the archive\'s Snowflake settings back on the daily batch', async () => {
    // The guarantee rests on settings applied by hand in Snowflake, and the
    // undo window has already been wrong for days once in this milestone with
    // nothing saying so.
    const waited: Promise<unknown>[] = []

    worker.scheduled({ cron: '0 13 * * *' } as ScheduledEvent, env, ctxWith(waited))
    await Promise.allSettled(waited)

    expect(checkArchiveSettings).toHaveBeenCalledTimes(1)
  })

  it('does not read the settings from any other cron', async () => {
    for (const cron of ['23 * * * *', '0 * * * *', '37 */2 * * *', '* * * * *']) {
      checkArchiveSettings.mockClear()
      const waited: Promise<unknown>[] = []

      worker.scheduled({ cron } as ScheduledEvent, env, ctxWith(waited))
      await Promise.allSettled(waited)

      expect(checkArchiveSettings, `${cron} read the settings`).not.toHaveBeenCalled()
    }
  })

  it('verifies the archive identities on the daily batch', async () => {
    // The least-privilege split is what keeps a bug or a leaked credential on
    // the ingest path from destroying archived rows, and an excessive grant
    // never surfaces on its own because nothing ever attempts it.
    const waited: Promise<unknown>[] = []

    worker.scheduled({ cron: '0 13 * * *' } as ScheduledEvent, env, ctxWith(waited))
    await Promise.allSettled(waited)

    expect(checkArchiveIdentities).toHaveBeenCalledTimes(1)
  })

  it('does not verify the identities from any other cron', async () => {
    // It runs a DELETE against production, inert though the predicate is. It
    // belongs on one schedule, not wherever a branch happens to reach it.
    for (const cron of ['23 * * * *', '0 * * * *', '37 */2 * * *', '* * * * *']) {
      checkArchiveIdentities.mockClear()
      const waited: Promise<unknown>[] = []

      worker.scheduled({ cron } as ScheduledEvent, env, ctxWith(waited))
      await Promise.allSettled(waited)

      expect(checkArchiveIdentities, `${cron} verified the identities`).not.toHaveBeenCalled()
    }
  })

  it('hands the archive a send function rather than letting it invent one', async () => {
    const waited: Promise<unknown>[] = []

    worker.scheduled({ cron: '23 * * * *' } as ScheduledEvent, env, ctxWith(waited))
    await Promise.all(waited)

    const deps = runExecutionArchive.mock.calls[0]?.[2] as { sendBatch?: unknown }
    expect(typeof deps?.sendBatch).toBe('function')
  })

  it('hands the archive the shared sender, which forwards the run\'s meter (#1443)', async () => {
    archiveSender.mockClear()
    const waited: Promise<unknown>[] = []

    worker.scheduled({ cron: '23 * * * *' } as ScheduledEvent, env, ctxWith(waited))
    await Promise.all(waited)

    const deps = runExecutionArchive.mock.calls[runExecutionArchive.mock.calls.length - 1]?.[2] as { sendBatch?: unknown }
    expect(archiveSender).toHaveBeenCalledWith(env)
    expect(deps.sendBatch).toBe(archiveSenderMarker)
  })
})

describe('the archive cron passes its scheduled time through (#1181)', () => {
  // Cloudflare retries a terminated cron with the same scheduledTime. The lock's
  // retry rule keys on that value, so the wiring has to hand it over, or the
  // rule is present in the code and absent from production (L3).
  it('hands the event\'s scheduled time to the archive run', async () => {
    const waited: Promise<unknown>[] = []
    const scheduledTime = Date.parse('2026-09-05T00:23:00.000Z')

    worker.scheduled({ cron: '23 * * * *', scheduledTime } as ScheduledEvent, env, ctxWith(waited))
    await Promise.all(waited)

    const deps = runExecutionArchive.mock.calls[0][2] as { scheduledFor?: Date }
    expect(deps.scheduledFor).toBeInstanceOf(Date)
    expect(deps.scheduledFor?.toISOString()).toBe('2026-09-05T00:23:00.000Z')
  })
})

/**
 * The completed stamp (#985). A run that stamps only "started" reads as healthy
 * when the platform kills it a minute later, which is what hid a three hour
 * archive outage on 2026-08-22. So every watched job stamps "completed" once its
 * work has settled, and the order and the failure path are asserted here against
 * the real handler rather than assumed.
 */
describe('the completed heartbeat stamp (#985)', () => {
  it('stamps the archive completed after its work resolves, and only after it started', async () => {
    const order: string[] = []
    writeHeartbeat.mockImplementation(async (_kv: unknown, id: string) => { order.push(`started:${id}`) })
    writeHeartbeatCompleted.mockImplementation(async (_kv: unknown, id: string) => { order.push(`completed:${id}`) })
    runExecutionArchive.mockImplementation(async () => { order.push('archive'); return { stop: 'caught-up', failed: false, hoursArchived: 0, hoursEmpty: 0, executionsArchived: 0, executionsRefused: 0, hoursBehind: 0, detail: 'test' } })
    const waited: Promise<unknown>[] = []

    worker.scheduled({ cron: '23 * * * *' } as ScheduledEvent, env, ctxWith(waited))
    await Promise.allSettled(waited)

    expect(order).toEqual(['started:execution-archive', 'archive', 'completed:execution-archive'])
  })

  it('still stamps the archive completed when its work rejects: a handled failure is a finished run', async () => {
    runExecutionArchive.mockRejectedValue(new Error('snowflake down'))
    const waited: Promise<unknown>[] = []

    worker.scheduled({ cron: '23 * * * *' } as ScheduledEvent, env, ctxWith(waited))
    await Promise.allSettled(waited)

    expect(writeHeartbeatCompleted).toHaveBeenCalledWith(expect.anything(), 'execution-archive')
  })

  it('stamps the daily batch completed only once every one of its checks has settled', async () => {
    // The gate is held open by the test itself rather than by a timer, so the
    // assertion is about ordering, not about how fast this machine is (L290).
    let finishGate!: (summary: unknown) => void
    runArchiveGate.mockImplementation(() => new Promise((resolve) => { finishGate = resolve }))
    const waited: Promise<unknown>[] = []

    worker.scheduled({ cron: '0 13 * * *' } as ScheduledEvent, env, ctxWith(waited))
    // One turn of the event loop, so every check that CAN settle has done so
    // while the gate is still running.
    await new Promise((r) => setTimeout(r, 0))
    expect(writeHeartbeatCompleted, 'completed was stamped while the gate was still running').not.toHaveBeenCalledWith(expect.anything(), 'daily-1300')

    finishGate({ daysConsidered: 0, daysStamped: 0, daysMeasured: 0, daysDeletable: 0, results: [], failed: false, detail: 't' })
    await Promise.allSettled(waited)

    expect(writeHeartbeatCompleted).toHaveBeenCalledWith(expect.anything(), 'daily-1300')
  })

  it('stamps every other watched job completed from its own cron', async () => {
    for (const [cron, id] of [
      ['15 8 * * *', 'timeout-audit'],
      ['37 */2 * * *', 'sightings-export'],
    ] as const) {
      writeHeartbeatCompleted.mockClear()
      const waited: Promise<unknown>[] = []

      worker.scheduled({ cron } as ScheduledEvent, env, ctxWith(waited))
      await Promise.allSettled(waited)

      expect(writeHeartbeatCompleted, `${cron} did not complete ${id}`).toHaveBeenCalledWith(expect.anything(), id)
    }
  })
})
