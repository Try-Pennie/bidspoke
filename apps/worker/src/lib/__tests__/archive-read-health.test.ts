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

describe('a streak counter that cannot be read', () => {
  /**
   * L50: a value parsed from storage must not feed a comparison directly. The
   * first version did `Number(stored) + 1` and compared that, so a corrupt entry
   * gave NaN, `NaN < 2` is false, and it alerted by accident rather than by
   * decision, then wrote "NaN" back and stayed unreadable for good.
   */
  it('speaks rather than going quiet, and repairs the counter', async () => {
    const kv = makeKv()
    kv.store.set('archive-read-failures:execution-archive-reads', 'not a number')
    const { posted, notify } = makeNotify()

    const alerted = await recordArchiveReadOutcome(supabase, kv, fail(), { notify })

    expect(alerted).toBe(true)
    expect(posted).toHaveLength(1)
    // Repaired, so the next read counts from a number rather than from wreckage.
    const stored = kv.store.get('archive-read-failures:execution-archive-reads')
    expect(Number.isFinite(Number(stored))).toBe(true)
  })
})

/**
 * #835: the fix line led with "check Snowflake first" and the consequence said
 * retrying "will not help", even when the failure named an unset secret, where
 * Snowflake was never asked, and on a timeout, where a retry may well work.
 */
describe('the archived reads fix line leads with what the failure names', () => {
  const remedyFor = async (detail: string, timedOut?: true) => {
    let remedy: { consequence: string; fixHint: string } | undefined
    const notify = async (_s: SupabaseClient, _j: string, _e: string[], _kv: unknown, r: unknown) => {
      remedy = r as { consequence: string; fixHint: string }
    }
    const outcome = timedOut ? { kind: 'unavailable' as const, detail, timedOut } : fail(detail)
    await recordArchiveReadOutcome(supabase, undefined, outcome, { notify })
    return remedy as { consequence: string; fixHint: string }
  }

  it('names the unset secret first, not Snowflake', async () => {
    const remedy = await remedyFor(
      'ARCHIVE_READER_PRIVATE_KEY is not set, so the archive cannot authenticate to Snowflake',
    )
    expect(remedy.fixHint).toMatch(/^Set ARCHIVE_READER_PRIVATE_KEY with wrangler secret put ARCHIVE_READER_PRIVATE_KEY/)
    expect(remedy.fixHint).not.toMatch(/Check Snowflake first/)
  })

  it('points a timeout at the warehouse resuming, and does not say a retry will not help', async () => {
    const remedy = await remedyFor('the archive did not answer within 20 seconds', true)
    expect(remedy.fixHint).toMatch(/warehouse/)
    expect(remedy.fixHint).not.toMatch(/wrangler secret put/)
    expect(remedy.consequence).not.toMatch(/it will not help/)
  })
})

// Lessons review (#835): the timeout is classified where the deadline fires,
// never recognised later from the wording of its message (L35).
describe('a read that ran out of time is reported as a timeout by the reader', () => {
  it('marks the outcome timed out when the deadline wins the race', async () => {
    const recorded: unknown[] = []
    await readArchivedExecution(
      {
        ARCHIVE_READER_USER: 'reader',
        ARCHIVE_READER_PRIVATE_KEY: 'key',
        SNOWFLAKE_ACCOUNT: 'acct',
      } as unknown as Env,
      supabase,
      { executionId: '01a05cd7-2a00-7000-8000-000000000001', orgId: 'o', readBy: 'r' },
      {
        execute: () => new Promise(() => {}),
        sleep: async () => undefined,
        writeAudit: async () => {},
        recordOutcome: async (_s, _kv, outcome) => {
          recorded.push(outcome)
          return false
        },
      },
    )
    expect(recorded).toEqual([expect.objectContaining({ kind: 'unavailable', timedOut: true })])
  })

  it('does not take the timeout fix from wording alone', async () => {
    const remedy = await (async () => {
      let r: { fixHint: string } | undefined
      await recordArchiveReadOutcome(supabase, undefined, fail('the archive did not answer within 20 seconds'), {
        notify: async (_s, _j, _e, _kv, x) => {
          r = x as { fixHint: string }
        },
      })
      return r as { fixHint: string }
    })()
    expect(remedy.fixHint).not.toMatch(/timing out/)
  })
})
