/**
 * An archive READ outage is counted and announced (#1272).
 *
 * `readArchivedExecution` and its siblings answer `unavailable` when the archive
 * cannot be reached. That is the right answer for the one person looking at the
 * one run, and until now nothing counted it, so a warehouse that will not resume
 * and a single blip arrived on the same path and were indistinguishable (L77).
 *
 * WHY A STREAK AND NOT A RATIO. The issue proposed a failure ratio over a window
 * with a minimum volume floor, and said in the same breath that the floor could
 * not be guessed and had to be measured after shipping. That leaves the alert
 * unable to fire until somebody returns with data. Two archived reads failing
 * back to back is a signal at any volume, so the streak needs no floor and works
 * from the first day. Dan chose this shape over the ratio on 2026-09-11.
 *
 * WHY THE STREAK IS OWNED HERE rather than left to the shared alerter.
 * `notifyExportFailure` already holds a first failure and pages on the second,
 * but it decides what to hold by reading the error TEXT against rules written
 * for the export jobs, and an archive read timeout is not text it recognises, so
 * it would page on the first. Passing it no KV turns its own holding off, which
 * is why every call below does so deliberately rather than by omission.
 *
 * The clock and the alerter are both injected, so nothing here waits and nothing
 * here posts (L524, L2).
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  recordArchiveReadOutcome,
  ARCHIVE_READ_ALERT_JOB,
  ARCHIVE_READ_FAILURE_THRESHOLD,
} from '../archive-read-health'
import {
  readArchivedExecution,
  readArchivedChildren,
  searchArchive,
  type ArchiveReadDeps,
} from '../archive-read'
import type { Env } from '../../index'
import type { SnowflakeStatementResponse } from '../snowflake'

const supabase = {} as unknown as SupabaseClient

/** In-memory KV with no expiry, which is all these cases need. */
function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  }
}

interface Posted {
  job: string
  errors: string[]
  kvPassed: boolean
}

function makeNotify() {
  const posted: Posted[] = []
  return {
    posted,
    notify: async (
      _supabase: SupabaseClient,
      job: string,
      errors: string[],
      kv: unknown,
      _remedy: unknown,
    ) => {
      posted.push({ job, errors, kvPassed: kv !== undefined })
    },
  }
}

const fail = (detail = 'the archive did not answer within 20 seconds') =>
  ({ kind: 'unavailable', detail }) as const

describe('recordArchiveReadOutcome', () => {
  it('holds a lone failure, because one read failing is not an outage', async () => {
    const kv = makeKv()
    const { posted, notify } = makeNotify()

    const alerted = await recordArchiveReadOutcome(supabase, kv, fail(), { notify })

    expect(alerted).toBe(false)
    expect(posted).toEqual([])
  })

  it('announces the second consecutive failure', async () => {
    const kv = makeKv()
    const { posted, notify } = makeNotify()

    await recordArchiveReadOutcome(supabase, kv, fail(), { notify })
    const alerted = await recordArchiveReadOutcome(supabase, kv, fail('reader role has no SELECT'), { notify })

    expect(alerted).toBe(true)
    expect(posted).toHaveLength(1)
    expect(posted[0].job).toBe(ARCHIVE_READ_ALERT_JOB)
    // The message carries the reason the LAST read gave, so the alert names a
    // cause somebody can act on rather than a count on its own (L11).
    expect(posted[0].errors.join(' ')).toContain('reader role has no SELECT')
    // The shared alerter must do no holding of its own: this code has already
    // decided, and letting it hold again would push the page to the third read.
    expect(posted[0].kvPassed).toBe(false)
  })

  it('clears the streak on a read that worked, so the next lone failure is quiet again', async () => {
    const kv = makeKv()
    const { posted, notify } = makeNotify()

    await recordArchiveReadOutcome(supabase, kv, fail(), { notify })
    await recordArchiveReadOutcome(supabase, kv, { kind: 'ok' }, { notify })
    const alerted = await recordArchiveReadOutcome(supabase, kv, fail(), { notify })

    expect(alerted).toBe(false)
    expect(posted).toEqual([])
  })

  it('does not repeat itself while the outage lasts', async () => {
    const kv = makeKv()
    const { posted, notify } = makeNotify()

    for (let i = 0; i < 6; i++) await recordArchiveReadOutcome(supabase, kv, fail(), { notify })

    expect(posted).toHaveLength(1)
  })

  it('announces again once the cooldown has passed and the archive is still down', async () => {
    const kv = makeKv()
    const { posted, notify } = makeNotify()

    await recordArchiveReadOutcome(supabase, kv, fail(), { notify })
    await recordArchiveReadOutcome(supabase, kv, fail(), { notify })
    expect(posted).toHaveLength(1)

    // The cooldown is held in KV under its own key and expires on its own. Its
    // expiry is simulated by removing it, rather than by waiting, because a test
    // that sleeps for a cooldown is asserting about the machine's clock (L290).
    for (const key of [...kv.store.keys()]) if (key.includes('cooldown')) kv.store.delete(key)

    await recordArchiveReadOutcome(supabase, kv, fail(), { notify })
    expect(posted).toHaveLength(2)
  })

  it('speaks on the first failure when it has no memory to hold one in', async () => {
    // A missing KV binding is not a reason to go quiet about the archive being
    // unreachable. Without somewhere to keep the streak the choice is between
    // announcing every failure and announcing none, and none is the one that
    // cannot be recovered from (L42).
    const { posted, notify } = makeNotify()

    const alerted = await recordArchiveReadOutcome(supabase, undefined, fail(), { notify })

    expect(alerted).toBe(true)
    expect(posted).toHaveLength(1)
  })

  it('needs exactly two failures to speak, and says so in one place', () => {
    // Named rather than hardcoded at each assertion above, so the threshold and
    // the tests for it cannot drift apart.
    expect(ARCHIVE_READ_FAILURE_THRESHOLD).toBe(2)
  })
})

describe('every archive read feeds the outcome signal', () => {
  /**
   * The guard in the web suite asserts there is only ONE place that reaches
   * Snowflake. This asserts that place actually reports, driven through the real
   * read functions rather than by calling the helper directly, because a helper
   * that records perfectly and is not reached by a read is the failure this pair
   * exists to catch (L3).
   */
  const env = {
    ARCHIVE_READER_USER: 'reader',
    ARCHIVE_READER_PRIVATE_KEY: 'key',
    SNOWFLAKE_ACCOUNT: 'acct',
    SNOWFLAKE_WAREHOUSE: 'wh',
  } as unknown as Env

  const ORG = '00000000-0000-4000-8000-00000000000a'
  const READER = '00000000-0000-4000-8000-00000000000c'
  const EXECUTION_ID = '01a05cd7-2a00-7000-8000-000000000001'

  function recordingDeps(opts: { throws?: boolean } = {}) {
    const recorded: Array<{ kind: string }> = []
    const deps: ArchiveReadDeps = {
      execute: async () => {
        if (opts.throws) throw new Error('warehouse could not resume')
        return { data: [] } as SnowflakeStatementResponse
      },
      // Never resolves, so the deadline branch cannot fire and what is asserted
      // is the query's own outcome (L524).
      sleep: () => new Promise<void>(() => {}),
      writeAudit: async () => {},
      recordOutcome: async (_supabase, _kv, outcome) => {
        recorded.push(outcome)
        return false
      },
    }
    return { deps, recorded }
  }

  it('reports a failure from the single execution read', async () => {
    const { deps, recorded } = recordingDeps({ throws: true })
    await readArchivedExecution(env, supabase, { executionId: EXECUTION_ID, orgId: ORG, readBy: READER }, deps)
    expect(recorded).toEqual([{ kind: 'unavailable', detail: 'warehouse could not resume' }])
  })

  it('reports a failure from the children read', async () => {
    const { deps, recorded } = recordingDeps({ throws: true })
    await readArchivedChildren(
      env,
      supabase,
      { parentExecutionId: EXECUTION_ID, parentDay: '2026-09-01', orgId: ORG },
      deps,
    )
    expect(recorded.map((r) => r.kind)).toEqual(['unavailable'])
  })

  it('reports a failure from search', async () => {
    const { deps, recorded } = recordingDeps({ throws: true })
    await searchArchive(env, supabase, { traceId: 'trace-1', orgId: ORG, readBy: READER }, deps)
    expect(recorded.map((r) => r.kind)).toEqual(['unavailable'])
  })

  it('reports the read that worked, which is what clears a streak', async () => {
    const { deps, recorded } = recordingDeps()
    await readArchivedExecution(env, supabase, { executionId: EXECUTION_ID, orgId: ORG, readBy: READER }, deps)
    expect(recorded).toEqual([{ kind: 'ok' }])
  })
})
