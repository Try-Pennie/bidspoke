import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'

const executeStatement = vi.fn()
vi.mock('../snowflake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../snowflake')>()),
  executeStatement: (...args: unknown[]) => executeStatement(...args),
}))

const notifyExportFailure = vi.fn()
vi.mock('../export-alerts', () => ({
  notifyExportFailure: (...args: unknown[]) => notifyExportFailure(...args),
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
          data: over.watermark === undefined ? null : { watermark_hour: over.watermark },
          error: null,
        }),
        upsert: async (rows: unknown) => {
          writes.push({ table, rows })
          return { error: over.failOn === table ? { message: 'write refused' } : null }
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
  ({ IDEMPOTENCY: kv, SNOWFLAKE_ACCOUNT: 'acct' }) as unknown as Env

beforeEach(() => {
  executeStatement.mockReset()
  notifyExportFailure.mockReset()
})

describe('runExecutionArchive', () => {
  // Two overlapping invocations would both drain and both send, doubling the
  // bundles. The lock is an optimisation over the watermark, not the
  // correctness story, but it must actually hold.
  it('skips entirely when another run holds the lock', async () => {
    const kv = fakeKv({ [RUN_LOCK_KEY]: '2026-08-18T11:00:00.000Z' })
    const sendBatch = vi.fn()
    const { client } = fakeSupabase()

    const result = await runExecutionArchive(envWith(kv), client, { sendBatch })

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
  })
})

describe('sendArchiveBatch', () => {
  const rows = [
    { executionId: 'a', archiveDay: '2026-08-16', wire: 'x', incomplete: false, stepCount: 2 },
    { executionId: 'b', archiveDay: '2026-08-16', wire: 'y', incomplete: false, stepCount: 3 },
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

  it('lets a Snowflake failure propagate, so the run stops rather than recording ids', async () => {
    executeStatement.mockRejectedValue(new Error('Snowflake 503'))

    await expect(sendArchiveBatch(env, rows)).rejects.toThrow(/503/)
  })
})
