/**
 * A killed run's lock does not suppress the run after it, and the takeover is
 * reported (#954).
 *
 * The lock is deleted in a `finally`, which covers success and failure but not
 * the platform terminating the isolate. Observed on prod 2026-08-21: the 17:23
 * run held `execution-archive:run-lock` at 17:35, twelve minutes later and past
 * its own 10 minute wall budget, with nothing written and no error recorded. Any
 * invocation inside that window read the key, treated it as a genuine concurrent
 * run and returned `skipped: 'locked'`, which is indistinguishable from correct
 * behaviour.
 *
 * These tests drive the REAL `runExecutionArchive` against the recording double
 * with a pre-seeded lock, so they observe what the run actually does with a
 * stale key rather than what the decision function returns in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../index'

vi.mock('../export-alerts', () => ({ notifyExportFailure: vi.fn().mockResolvedValue(undefined) }))

import {
  runExecutionArchive,
  RUN_LOCK_KEY,
  WALL_TIME_BUDGET_MS,
  type ArchiveRow,
} from '../execution-archive'
import { lockValue } from '../../archive/run-lock'
import { ARCHIVE_JOB_NAMES } from '../../archive/alerts'
import { EXPECTED_ORGANIZATION_SLUG } from '../../archive/disposition'
import { notifyExportFailure } from '../export-alerts'
import { makeArchiveDouble, makeKV, rowsFor, NOW } from './_archive-double'

async function runWithLock(stored: string | null) {
  const double = makeArchiveDouble({ organizationSlug: EXPECTED_ORGANIZATION_SLUG })
  const kv = makeKV()
  if (stored !== null) await kv.put(RUN_LOCK_KEY, stored)
  const sent: ArchiveRow[] = []
  const env = { IDEMPOTENCY: kv, SSN_HASH_PEPPER: 'test-pepper' } as unknown as Env
  const summary = await runExecutionArchive(env, double.client, {
    sendBatch: async (rows) => { sent.push(...rows) },
    now: () => NOW,
  })
  return { summary, sent, writes: double.writes, kv }
}

function alertNames() {
  return vi.mocked(notifyExportFailure).mock.calls.map((c) => c[1])
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
})

describe('a lock left behind by a killed run (#954)', () => {
  it('does not stop the run, and the work still happens', async () => {
    // An hour old, which is where the next hourly run at :23 finds it.
    const stale = lockValue(new Date(NOW.getTime() - 60 * 60 * 1000), WALL_TIME_BUDGET_MS)
    const { summary, sent } = await runWithLock(stale)

    expect(summary.skipped).toBeUndefined()
    expect(summary.executionsArchived).toBe(1)
    expect(sent).toHaveLength(1)
  })

  it('says so, rather than taking over quietly', async () => {
    const stale = lockValue(new Date(NOW.getTime() - 60 * 60 * 1000), WALL_TIME_BUDGET_MS)
    await runWithLock(stale)

    const killed = vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === ARCHIVE_JOB_NAMES.killed)
    expect(killed, 'taking over a dead run lock must be reported').toBeDefined()
    expect(String((killed as unknown[])[2])).toMatch(/killed rather than still working/)
  })

  it('replaces the stale value with its own, so the next run is not told the same thing twice', async () => {
    const stale = lockValue(new Date(NOW.getTime() - 60 * 60 * 1000), WALL_TIME_BUDGET_MS)
    const { kv } = await runWithLock(stale)

    // Deleted by the run's own finally, so the key is gone rather than holding
    // the dead predecessor's stamp.
    expect(await kv.get(RUN_LOCK_KEY)).toBeNull()
  })

  it('still archives when the takeover cannot be reported', async () => {
    // The report runs before any archiving, so an unreachable Slack would
    // otherwise turn one killed run into a second one that never started, and
    // the second looks exactly like the first. A watchdog must not share the
    // abort behaviour of the work it watches (L71).
    vi.mocked(notifyExportFailure).mockRejectedValueOnce(new Error('slack is down'))
    const stale = lockValue(new Date(NOW.getTime() - 60 * 60 * 1000), WALL_TIME_BUDGET_MS)

    const { summary, sent } = await runWithLock(stale)

    expect(summary.executionsArchived).toBe(1)
    expect(sent).toHaveLength(1)
  })
})

describe('a lock held by a run that is genuinely alive (#954)', () => {
  it('skips, and does nothing', async () => {
    const live = lockValue(new Date(NOW.getTime() - 60 * 1000), WALL_TIME_BUDGET_MS)
    const { summary, sent, writes } = await runWithLock(live)

    expect(summary.skipped).toBe('locked')
    expect(sent).toEqual([])
    expect(rowsFor(writes, 'execution_archive_ids')).toEqual([])
  })

  it('names how long the holder has held it and how much of its budget is left', async () => {
    // The negative control for the report: without the age, a live holder and a
    // dead one produce the same sentence, which is the whole defect.
    const live = lockValue(new Date(NOW.getTime() - 3 * 60 * 1000), WALL_TIME_BUDGET_MS)
    const { summary } = await runWithLock(live)

    expect(summary.detail).toMatch(/held the run lock for 3 minutes/)
    expect(summary.detail).toMatch(new RegExp(`${Math.round(WALL_TIME_BUDGET_MS / 60000) - 3} minutes inside its own deadline`))
  })

  it('raises no killed alert, so the alert means what it says', async () => {
    const live = lockValue(new Date(NOW.getTime() - 60 * 1000), WALL_TIME_BUDGET_MS)
    await runWithLock(live)

    expect(alertNames()).not.toContain(ARCHIVE_JOB_NAMES.killed)
  })

  it('does not leave the live holder without its lock', async () => {
    // A skipping run must not run the finally that deletes a key it never took.
    const live = lockValue(new Date(NOW.getTime() - 60 * 1000), WALL_TIME_BUDGET_MS)
    const { kv } = await runWithLock(live)

    expect(await kv.get(RUN_LOCK_KEY)).toBe(live)
  })
})

describe('the lock this run writes (#954)', () => {
  it('stamps the deadline the run itself works to, not some other number', async () => {
    // The stamp is what a later run reads to decide whether this one is alive.
    // If it disagreed with the wall budget the run actually stops on, the lock
    // would either be reclaimed while this run was still sending, or protect a
    // run that gave up minutes ago. Asserted rather than assumed, because the
    // two numbers live in different statements and nothing else would notice
    // them drifting apart.
    const double = makeArchiveDouble({ organizationSlug: EXPECTED_ORGANIZATION_SLUG })
    const kv = makeKV()
    const puts: string[] = []
    const original = kv.put.bind(kv)
    kv.put = (async (key: string, value: string, opts?: unknown) => {
      if (key === RUN_LOCK_KEY) puts.push(value)
      return original(key, value, opts as never)
    }) as typeof kv.put
    const env = { IDEMPOTENCY: kv, SSN_HASH_PEPPER: 'test-pepper' } as unknown as Env

    await runExecutionArchive(env, double.client, { sendBatch: async () => {}, now: () => NOW })

    expect(puts).toHaveLength(1)
    const stamp = JSON.parse(puts[0]) as { startedAt: string; deadlineAt: string }
    expect(stamp.startedAt).toBe(NOW.toISOString())
    expect(Date.parse(stamp.deadlineAt) - Date.parse(stamp.startedAt)).toBe(WALL_TIME_BUDGET_MS)
  })
})

describe('the durable record of a run (#960)', () => {
  it('opens a row when the run starts and closes it with the outcome', async () => {
    const { writes } = await runWithLock(null)
    const runs = writes.filter((w) => w.table === 'job_runs')

    expect(runs).toHaveLength(2)
    expect((runs[0].rows[0] as Record<string, unknown>).job).toBe('execution-archive')
    const ending = runs[1].rows[0] as Record<string, unknown>
    expect(typeof ending.finished_at).toBe('string')
    expect(ending.outcome).toBe('caught-up')
  })

  it('records a run that skipped on the lock, closed immediately', async () => {
    // A run that looked and found the lock held is a run that happened. No row
    // would make it indistinguishable from an invocation that never fired.
    const live = lockValue(new Date(NOW.getTime() - 60 * 1000), WALL_TIME_BUDGET_MS)
    const { writes } = await runWithLock(live)
    const runs = writes.filter((w) => w.table === 'job_runs')

    expect(runs).toHaveLength(2)
    expect((runs[1].rows[0] as Record<string, unknown>).outcome).toBe('skipped-locked')
  })

  it('carries the run\'s counts, so the record is worth reading', async () => {
    const { writes } = await runWithLock(null)
    const ending = writes.filter((w) => w.table === 'job_runs')[1].rows[0] as Record<string, unknown>
    const summary = ending.summary as Record<string, unknown>

    expect(summary.executionsArchived).toBe(1)
    expect(summary.hoursArchived).toBe(1)
  })
})

describe('a free lock (#954)', () => {
  it('runs, and raises no killed alert', async () => {
    const { summary } = await runWithLock(null)

    expect(summary.skipped).toBeUndefined()
    expect(summary.executionsArchived).toBe(1)
    expect(alertNames()).not.toContain(ARCHIVE_JOB_NAMES.killed)
  })
})

describe('a cron retry arriving inside its killed predecessor\'s deadline (#1181)', () => {
  // The 2026-09-05 00:23 case: killed after 43 seconds, retried at 00:24:18,
  // and the retry skipped because the dead run's lock was 1 minute old with 9
  // minutes of deadline left. The hours then waited for the 01:23 run.
  const SCHEDULED = new Date('2026-09-05T00:23:00.000Z')

  async function runRetry(storedScheduledFor: Date | undefined, ownScheduledFor: Date | undefined) {
    const double = makeArchiveDouble({ organizationSlug: EXPECTED_ORGANIZATION_SLUG })
    const kv = makeKV()
    const killedAt = new Date(NOW.getTime() - 43 * 1000)
    await kv.put(RUN_LOCK_KEY, lockValue(killedAt, WALL_TIME_BUDGET_MS, storedScheduledFor))
    const sent: ArchiveRow[] = []
    const env = { IDEMPOTENCY: kv, SSN_HASH_PEPPER: 'test-pepper' } as unknown as Env
    const summary = await runExecutionArchive(env, double.client, {
      sendBatch: async (rows) => { sent.push(...rows) },
      now: () => NOW,
      scheduledFor: ownScheduledFor,
    })
    return { summary, sent }
  }

  it('proceeds and does the work, instead of waiting for the next cadence', async () => {
    const { summary, sent } = await runRetry(SCHEDULED, SCHEDULED)

    expect(summary.skipped).toBeUndefined()
    expect(summary.executionsArchived).toBe(1)
    expect(sent).toHaveLength(1)
  })

  it('reports the kill, in the retry\'s own words', async () => {
    await runRetry(SCHEDULED, SCHEDULED)

    const killed = vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === ARCHIVE_JOB_NAMES.killed)
    expect(killed, 'a retry taking over its predecessor\'s lock must be reported').toBeDefined()
    expect(String((killed as unknown[])[2])).toMatch(/retry of the same scheduled event/)
  })

  it('still skips when the lock belongs to a different scheduled event', async () => {
    // Positive and negative in one fixture (L159): the same seeded lock, the
    // same age, only the event identity differs.
    const { summary, sent } = await runRetry(new Date('2026-09-04T23:23:00.000Z'), SCHEDULED)

    expect(summary.skipped).toBe('locked')
    expect(sent).toEqual([])
    expect(alertNames()).not.toContain(ARCHIVE_JOB_NAMES.killed)
  })

  it('stamps its own scheduled time into the lock it writes, so its own retry can recognise it', async () => {
    const double = makeArchiveDouble({ organizationSlug: EXPECTED_ORGANIZATION_SLUG })
    const kv = makeKV()
    const puts: string[] = []
    const original = kv.put.bind(kv)
    kv.put = (async (key: string, value: string, opts?: unknown) => {
      if (key === RUN_LOCK_KEY) puts.push(value)
      return original(key, value, opts as never)
    }) as typeof kv.put
    const env = { IDEMPOTENCY: kv, SSN_HASH_PEPPER: 'test-pepper' } as unknown as Env

    await runExecutionArchive(env, double.client, { sendBatch: async () => {}, now: () => NOW, scheduledFor: SCHEDULED })

    expect(puts).toHaveLength(1)
    expect((JSON.parse(puts[0]) as { scheduledFor?: string }).scheduledFor).toBe(SCHEDULED.toISOString())
  })
})
