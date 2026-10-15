import { describe, it, expect, vi, beforeEach } from 'vitest'
import { A_V7_EXECUTION_ID } from '../../archive/__tests__/_ids'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import { EXPECTED_ORGANIZATION_SLUG } from '../../archive/disposition'

const executeStatement = vi.fn()
vi.mock('../snowflake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../snowflake')>()),
  executeStatement: (...args: unknown[]) => executeStatement(...args),
}))

const streamHour = vi.fn()
vi.mock('../../archive/stream-hour', () => ({
  streamHour: (...args: unknown[]) => streamHour(...args),
}))

const notifyExportFailure = vi.fn()
const notifyExportRecovery = vi.fn()
vi.mock('../export-alerts', () => ({
  notifyExportFailure: (...args: unknown[]) => notifyExportFailure(...args),
  notifyExportRecovery: (...args: unknown[]) => notifyExportRecovery(...args),
}))

const { runExecutionArchive, RUN_LOCK_KEY } = await import('../execution-archive')
const { sendArchiveBatch } = await import('../execution-archive-send')
const { ARCHIVE_JOB_NAMES } = await import('../../archive/alerts')

/** KV double that records what was put and deleted. */
function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  const deleted: string[] = []
  return {
    store,
    deleted,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v)
    },
    delete: async (k: string) => {
      store.delete(k)
      deleted.push(k)
    },
  }
}

/**
 * Supabase double. Reads return empty, writes record themselves. Deliberately
 * NOT a stub of the archive's own functions: the point is to observe which
 * tables the job touches and in what order.
 */
function fakeSupabase(over: { workflows?: unknown[]; failOn?: string; watermark?: string } = {}) {
  const writes: Array<{ table: string; rows: unknown }> = []
  // The watermark the double reports MOVES when the job writes it. A fixed one
  // makes the loop re-read the same hour every pass and stop only on its hour
  // cap, so a test about one hour silently becomes a test about four.
  let watermark = over.watermark
  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        lt: () => builder,
        order: () => builder,
        range: () => builder,
        maybeSingle: async () => ({
          data: watermark === undefined ? null : { watermark_hour: watermark },
          error: null,
        }),
        upsert: async (rows: unknown) => {
          writes.push({ table, rows })
          if (over.failOn === table) return { error: { message: 'write refused' } }
          if (table === 'execution_archive_progress') {
            const hour = (rows as { watermark_hour?: unknown }).watermark_hour
            if (typeof hour === 'string') watermark = hour
          }
          return { error: null }
        },
        then: (resolve: (v: unknown) => void) => {
          if (table === 'workflows') {
            resolve({ data: over.workflows ?? [], error: null })
            return
          }
          resolve({ data: [], error: null, count: 0 })
        },
      }
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, writes }
}

const envWith = (kv: ReturnType<typeof fakeKv>): Env =>
  ({ IDEMPOTENCY: kv, SNOWFLAKE_ACCOUNT: 'acct', SSN_HASH_PEPPER: 'test-pepper' }) as unknown as Env

beforeEach(() => {
  executeStatement.mockReset()
  notifyExportFailure.mockReset()
  notifyExportRecovery.mockReset()
  streamHour.mockReset()
  streamHour.mockResolvedValue({
    usable: true,
    empty: true,
    executionCount: 0,
    stepCount: 0,
    requests: 1,
  })
})

// The clean stop on the request allowance is only real if the number it works
// from is the number that actually happened. An estimate drifts with volume: at
// the measured 11.9 steps per execution one hour is roughly fifty pages of steps
// alone, so a hand-picked handful can never fire and the platform limit arrives
// as a crash mid-batch instead (L182).
describe('the request allowance', () => {
  const behind = { watermark: '2026-08-10T00:00:00.000Z' }

  it('is spent at the rate the fetch reports, not at a fixed guess', async () => {
    // 860 of the 900 allowance in ONE hour, so the floor is breached before the
    // hour cap is reached. The cap is 2 (measured, #953), and the loop checks it
    // first, so a cheaper fixture would stop on max-hours and this test would
    // assert nothing about the allowance at all.
    streamHour.mockResolvedValue({
      usable: true,
      empty: true,
      executionCount: 0,
      stepCount: 0,
      requests: 860,
    })
    const { client } = fakeSupabase(behind)

    const result = await runExecutionArchive(envWith(fakeKv()), client, {
      sendBatch: vi.fn(),
      now: () => new Date('2026-08-18T11:00:00.000Z'),
    })

    expect(result.stop).toBe('subrequests')
  })

  it('keeps going when each hour is cheap, rather than stopping on the guess', async () => {
    const { client } = fakeSupabase(behind)

    const result = await runExecutionArchive(envWith(fakeKv()), client, {
      sendBatch: vi.fn(),
      now: () => new Date('2026-08-18T11:00:00.000Z'),
    })

    expect(result.stop).not.toBe('subrequests')
    expect(result.hoursEmpty).toBeGreaterThan(1)
  })
})

describe('runExecutionArchive', () => {
  // Two overlapping invocations would both drain and both send, doubling the
  // bundles. The lock is an optimisation over the watermark, not the
  // correctness story, but it must actually hold.
  it('skips entirely when another run holds the lock', async () => {
    const kv = fakeKv({ [RUN_LOCK_KEY]: '2026-08-18T11:00:00.000Z' })
    const sendBatch = vi.fn()
    const { client } = fakeSupabase()

    // The clock is pinned two minutes past the holder's start, so the holder is
    // inside its own wall budget and this is a genuine concurrent run. Left to
    // real time the stored stamp is years old and the run correctly takes the
    // lock over instead, which is a different outcome and a different test
    // (#954). A fixture whose meaning is the relationship between a stored time
    // and the clock has to pin both ends (L130).
    const result = await runExecutionArchive(envWith(kv), client, {
      sendBatch,
      now: () => new Date('2026-08-18T11:02:00.000Z'),
    })

    expect(result.skipped).toBe('locked')
    expect(sendBatch).not.toHaveBeenCalled()
    expect(result.failed).toBe(false)
  })

  // A lock that outlives a crashed run blocks every later run until its TTL
  // expires, which is fifteen minutes of archiving lost per crash.
  it('releases the lock even when the run throws', async () => {
    const kv = fakeKv()
    // A watermark far enough back that an hour IS ready, so the failing write is
    // actually reached: with a fresh watermark nothing is ready and the run
    // returns without ever writing.
    const { client } = fakeSupabase({
      failOn: 'execution_archive_progress',
      watermark: '2026-08-10T00:00:00.000Z',
    })

    await expect(
      runExecutionArchive(envWith(kv), client, {
        sendBatch: vi.fn(),
        now: () => new Date('2026-08-18T11:00:00.000Z'),
      }),
    ).rejects.toThrow()

    expect(kv.store.has(RUN_LOCK_KEY)).toBe(false)
    expect(kv.deleted).toContain(RUN_LOCK_KEY)
  })

  it('takes the lock while it runs and releases it when it finishes', async () => {
    const kv = fakeKv()
    const { client } = fakeSupabase()

    await runExecutionArchive(envWith(kv), client, {
      sendBatch: vi.fn(),
      now: () => new Date('2026-08-18T11:00:00.000Z'),
    })

    expect(kv.deleted).toContain(RUN_LOCK_KEY)
    expect(kv.store.has(RUN_LOCK_KEY)).toBe(false)
  })

  // The healthy path must not reach notifyExportFailure at all: called with an
  // empty errors array it DELETES the grace marker and the cooldown, so a job
  // alternating a failure with a clean run never reaches the second consecutive
  // failure that pages (L53).
  it('raises no alert at all on a healthy run', async () => {
    const kv = fakeKv()
    const { client } = fakeSupabase()

    await runExecutionArchive(envWith(kv), client, {
      sendBatch: vi.fn(),
      now: () => new Date('2026-08-18T11:00:00.000Z'),
    })

    expect(notifyExportFailure).not.toHaveBeenCalled()
  })

  it('reports a healthy run as a recovery, so the reminders for a past failure stop (#1441)', async () => {
    // Built is not wired (L3). Both halves of #1441 are unit tested elsewhere;
    // this asserts the run actually calls the recovery, because before it did,
    // the alerting layer only ever heard about failures and two timeouts a day
    // apart arrived as one 21 hour incident.
    const kv = fakeKv()
    const { client } = fakeSupabase()

    await runExecutionArchive(envWith(kv), client, {
      sendBatch: vi.fn(),
      now: () => new Date('2026-08-18T11:00:00.000Z'),
    })

    const cleared = notifyExportRecovery.mock.calls.map((call) => call[1])
    expect(cleared).toContain('execution-archive-ingest')
    expect(cleared).toContain('execution-archive-refusal')
    expect(cleared).toContain('execution-archive-lag')
  })

  it('clears the killed condition on a clean-lock run, so a later killed run pages as a fresh incident (#1784)', async () => {
    // A clean lock acquisition is positive evidence that no predecessor was
    // killed this cycle. Before #1784 the killed condition was never cleared, so
    // its standing record lived to its 30 day TTL and a kill weeks later posted
    // as a lengthened "(still)" reminder rather than a fresh incident.
    const kv = fakeKv()
    const { client } = fakeSupabase()

    await runExecutionArchive(envWith(kv), client, {
      sendBatch: vi.fn(),
      now: () => new Date('2026-08-18T11:00:00.000Z'),
    })

    const cleared = notifyExportRecovery.mock.calls.map((call) => call[1])
    expect(cleared).toContain(ARCHIVE_JOB_NAMES.killed)
  })

  it('does not clear the killed condition on a run that took over a killed predecessor (#1784)', async () => {
    // A take-over is the run that FINDS a killed predecessor and posts the killed
    // alert. It must not clear the very condition it is raising. The stale lock is
    // eight days old, far past its deadline and grace, so decideLock takes it over.
    const kv = fakeKv({ [RUN_LOCK_KEY]: '2026-08-10T00:00:00.000Z' })
    const { client } = fakeSupabase()

    const result = await runExecutionArchive(envWith(kv), client, {
      sendBatch: vi.fn(),
      now: () => new Date('2026-08-18T11:00:00.000Z'),
    })

    // Proof this was a take-over, not a skip (which also clears nothing): a skip
    // returns early with skipped: 'locked'. A take-over proceeds and runs.
    expect(result.skipped).not.toBe('locked')
    const cleared = notifyExportRecovery.mock.calls.map((call) => call[1])
    expect(cleared).not.toContain(ARCHIVE_JOB_NAMES.killed)
  })

  it('dispatches each alert under its own job name', async () => {
    const kv = fakeKv()
    // A watermark far in the past, so the run stops on its hour cap while still
    // a long way behind, which is the lag condition.
    const { client } = fakeSupabase()
    const supabase = {
      ...client,
      from(table: string) {
        if (table === 'execution_archive_progress') {
          const b: Record<string, unknown> = {
            select: () => b,
            eq: () => b,
            maybeSingle: async () => ({ data: { watermark_hour: '2026-08-10T00:00:00.000Z' }, error: null }),
            upsert: async () => ({ error: null }),
          }
          return b
        }
        return client.from(table)
      },
    } as unknown as SupabaseClient

    await runExecutionArchive(envWith(kv), supabase, {
      sendBatch: vi.fn(),
      now: () => new Date('2026-08-18T11:00:00.000Z'),
    })

    const names = notifyExportFailure.mock.calls.map((c) => c[1] as string)
    expect(names).toContain(ARCHIVE_JOB_NAMES.lag)
    for (const call of notifyExportFailure.mock.calls) {
      expect((call[2] as string[]).length).toBeGreaterThan(0)
    }
    // #2103: the alerts open and settle incidents, so they take the run's own
    // clock, never a second read of the real one.
    const runAt = Date.parse('2026-08-18T11:00:00.000Z')
    for (const call of notifyExportFailure.mock.calls) expect(call[5], call[1] as string).toBe(runAt)
    for (const call of notifyExportRecovery.mock.calls) expect(call[2], call[1] as string).toBe(runAt)
  })
})

/**
 * The archive table requires an organization, a workflow and a start, and all
 * three come off the execution row. A row missing one cannot be written at all,
 * so what matters is WHERE that is discovered: per execution, where a refusal is
 * a recorded outcome and the hour still finishes, or at the send, where the
 * whole batch is rejected and the watermark stalls on an hour that can never
 * pass (L47, L110).
 */
describe('an execution the archive table could not accept', () => {
  const HOUR = '2026-08-18T09:00:00.000Z'
  const NOW = () => new Date('2026-08-18T12:00:00.000Z')

  const bundle = (over: Record<string, unknown> = {}) => ({
    executionId: 'e1',
    execution: {
      id: A_V7_EXECUTION_ID,
      workflow_id: 'wf-live',
      status: 'completed',
      started_at: HOUR,
      ...over,
    },
    steps: [],
  })

  // The reader now hands slices to a callback, so the double has to CALL it.
  // A double that only returned a result would leave every bundle unprocessed
  // and every assertion below passing on an hour that archived nothing.
  const withHour = (bundles: unknown[]) => {
    streamHour.mockImplementation(
      async (_client: unknown, _s: string, _e: string, onSlice: (b: unknown[]) => Promise<void>) => {
        await onSlice(bundles)
        return { usable: true, empty: false, executionCount: bundles.length, stepCount: 0, requests: 3 }
      },
    )
  }

  const live = {
    watermark: '2026-08-18T08:00:00.000Z',
    workflows: [{ id: 'wf-live', organizations: { id: 'org-live', slug: EXPECTED_ORGANIZATION_SLUG } }],
  }

  const refusals = (writes: Array<{ table: string; rows: unknown }>) =>
    writes.filter((w) => w.table === 'execution_archive_refusals')

  /**
   * The rows of the nth refusal REQUEST, flattened.
   *
   * Refusals are upserted as a batch per slice rather than one call per
   * execution (#965), so the argument is an array even when it holds a single
   * row. Read through here rather than cast in each test, so a future change
   * back to one row per call fails in one place.
   */
  const refusedRows = (writes: Array<{ table: string; rows: unknown }>, request = 0) => {
    const rows = refusals(writes)[request].rows
    return (Array.isArray(rows) ? rows : [rows]) as Array<{ reason: string; execution_id: string }>
  }

  it('sends the row, carrying its scalars, when everything required is present', async () => {
    withHour([bundle()])
    const { client, writes } = fakeSupabase(live)
    const sendBatch = vi.fn()

    const result = await runExecutionArchive(envWith(fakeKv()), client, { sendBatch, now: NOW })

    expect(refusals(writes)).toEqual([])
    expect(sendBatch).toHaveBeenCalledTimes(1)
    const sent = sendBatch.mock.calls[0][0] as Array<{ scalars: { organizationId: string } }>
    expect(sent[0].scalars.organizationId).toBe('org-live')
    expect(result.executionsArchived).toBe(1)
  })

  // #1451: the send is told when the run must stop, so a batch that keeps
  // failing cannot spend past the run's own wall budget on its retries.
  it('hands every send the moment the wall budget of the run runs out', async () => {
    withHour([bundle()])
    const { client } = fakeSupabase(live)
    const sendBatch = vi.fn()

    await runExecutionArchive(envWith(fakeKv()), client, {
      sendBatch,
      now: NOW,
      budget: { wallMs: 5 * 60_000, maxHours: 1 },
    })

    expect(sendBatch).toHaveBeenCalledTimes(1)
    expect(sendBatch.mock.calls[0][1]).toBe(NOW().getTime() + 5 * 60_000)
  })

  it('refuses it by id, and still finishes the hour, when it has no workflow', async () => {
    withHour([bundle({ workflow_id: null })])
    const { client, writes } = fakeSupabase(live)
    const sendBatch = vi.fn()

    const result = await runExecutionArchive(envWith(fakeKv()), client, { sendBatch, now: NOW })

    expect(refusals(writes).length).toBe(1)
    expect(sendBatch).not.toHaveBeenCalled()
    // The hour still advanced: a refusal is permanent for that execution, so
    // holding the watermark for it would stop all archiving forever.
    expect(result.stop).not.toBe('read-failed')
    expect(result.executionsArchived).toBe(0)
  })

  /**
   * The one route by which a MISSING SCALAR, rather than the tenancy check, is
   * what refuses a row in the running job.
   *
   * Every other required scalar is already required by something upstream: the
   * organization comes from a lookup keyed on the workflow id, so neither can be
   * absent without the tenancy check refusing first. A TERMINAL execution is the
   * exception, because it is dispositioned without its start ever being read,
   * and started_at_utc is NOT NULL on the archive table.
   *
   * Worth pinning rather than assuming, because a test aimed at this that
   * tripped the tenancy check instead would pass while proving nothing about the
   * check it named (L159).
   */
  it('refuses a terminal execution whose start cannot be read, naming that column', async () => {
    withHour([bundle({ status: 'completed', started_at: null })])
    const { client, writes } = fakeSupabase(live)
    const sendBatch = vi.fn()

    await runExecutionArchive(envWith(fakeKv()), client, { sendBatch, now: NOW })

    expect(sendBatch).not.toHaveBeenCalled()
    const row = refusedRows(writes)[0]
    expect(row.execution_id).toBe('e1')
    expect(row.reason).toMatch(/started_at/)
    // Named by the scalars, not by the tenancy check, which would have refused
    // it for an entirely different reason.
    expect(row.reason).not.toMatch(/organization/)
  })

  /**
   * A workflow whose organization row came back without an id is UNMAPPED, not
   * half-mapped.
   *
   * Both readings refuse the execution, so "it was refused" cannot tell them
   * apart; the reason can. Half-mapping lets the slug satisfy the tenancy check
   * and leaves the scalars to report a missing organization id, which reads as a
   * fault in this job rather than as a workflow whose organization could not be
   * resolved. The ledger is the only record anyone reads afterwards, so the
   * reason on it is the whole difference (L11).
   */
  it('refuses an execution whose workflow maps to an organization with no id, as unmapped', async () => {
    withHour([bundle()])
    const { client, writes } = fakeSupabase({
      ...live,
      workflows: [{ id: 'wf-live', organizations: { slug: EXPECTED_ORGANIZATION_SLUG } }],
    })
    const sendBatch = vi.fn()

    await runExecutionArchive(envWith(fakeKv()), client, { sendBatch, now: NOW })

    expect(sendBatch).not.toHaveBeenCalled()
    expect(refusals(writes).length).toBe(1)
    const row = refusedRows(writes)[0]
    expect(row.reason).toMatch(/maps to no organization/)
  })

  it('refuses an execution from another organization before anything is encoded', async () => {
    withHour([bundle({ workflow_id: 'wf-e2e' })])
    const { client, writes } = fakeSupabase({
      ...live,
      workflows: [
        { id: 'wf-live', organizations: { id: 'org-live', slug: EXPECTED_ORGANIZATION_SLUG } },
        { id: 'wf-e2e', organizations: { id: 'org-e2e', slug: 'E2E Test' } },
      ],
    })
    const sendBatch = vi.fn()

    await runExecutionArchive(envWith(fakeKv()), client, { sendBatch, now: NOW })

    expect(sendBatch).not.toHaveBeenCalled()
    const row = refusedRows(writes)[0]
    expect(row.reason).toMatch(/E2E Test/)
  })
})

describe('sendArchiveBatch', () => {
  const scalars = {
    organizationId: 'org-1',
    workflowId: 'wf-1',
    workflowVersionId: null,
    parentExecutionId: null,
    resumedFromExecutionId: null,
    traceId: null,
    source: null,
    status: 'completed',
    outcome: null,
    isTest: false,
    startedAtUtc: '2026-08-16T11:00:00.000',
    completedAtUtc: null,
    durationMs: null,
    costUsd: null,
    ssnHash: null,
  }

  const rows = [
    { executionId: 'a', archiveDay: '2026-08-16', wire: 'x', incomplete: false, stepCount: 2, scalars },
    { executionId: 'b', archiveDay: '2026-08-16', wire: 'y', incomplete: false, stepCount: 3, scalars },
  ]

  const env = {
    SNOWFLAKE_ACCOUNT: 'acct',
    ARCHIVE_WRITER_USER: 'u',
    ARCHIVE_WRITER_PRIVATE_KEY: 'k',
  } as unknown as Env

  it('accepts a batch whose reported row count matches what was sent', async () => {
    executeStatement.mockResolvedValue({ data: [['2']] })

    await expect(sendArchiveBatch(env, rows)).resolves.toBeUndefined()
  })

  // "The statement was accepted" and "the rows are there" are different claims,
  // and the local id record written straight after this asserts the second one.
  it('refuses a partial insert rather than letting the ids be recorded', async () => {
    executeStatement.mockResolvedValue({ data: [['1']] })

    await expect(sendArchiveBatch(env, rows)).rejects.toThrow(/reported 1 rows for a batch of 2/)
  })

  it('refuses a response carrying no row count rather than assuming success', async () => {
    executeStatement.mockResolvedValue({ message: 'Statement executed successfully.' })

    await expect(sendArchiveBatch(env, rows)).rejects.toThrow(/no row count/)
  })

  it('passes the time the run gives up at through to Snowflake (#1451)', async () => {
    executeStatement.mockResolvedValue({ data: [['2']] })

    await sendArchiveBatch(env, rows, 1_234_567)

    expect(executeStatement.mock.calls[0][3]).toEqual({ giveUpAt: 1_234_567 })
  })

  it('lets a Snowflake failure propagate, so the run stops rather than recording ids', async () => {
    executeStatement.mockRejectedValue(new Error('Snowflake 503'))

    await expect(sendArchiveBatch(env, rows)).rejects.toThrow(/503/)
  })
})
