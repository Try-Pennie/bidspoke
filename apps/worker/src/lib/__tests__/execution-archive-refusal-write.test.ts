/**
 * The refusal write is proven to happen, not assumed (#957).
 *
 * `execution_archive_refusals` had ZERO rows in production while #949 recorded
 * 5,617 of 5,617 executions in one hour being refused for a tenancy mismatch.
 * Those two facts are reconcilable: that 5,617 was measured by
 * `scripts/dry-run-archive.ts`, which prints "nothing is written to Snowflake or
 * Postgres" and means it, and the live job only began reaching disposition after
 * the tenancy constant was corrected, at which point nothing is refused. So the
 * refusal path had never run in production at all.
 *
 * That matters because A4's deletion gate (#872) reads this table to account for
 * every execution a day contains. A gate whose input has never been observed to
 * write can pass by reporting nothing, which is the exact failure the gate
 * exists to prevent (L98, L90).
 *
 * These tests drive the REAL `runExecutionArchive` against a recording Supabase
 * double, so they observe which tables it actually writes and what it puts in
 * them, rather than which functions it calls. Mutation checked: commenting out
 * the `upsertRefusal` call in the disposition loop fails the first test, and
 * dropping the `archive_day` from its payload fails the second.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../index'

// Mocked so the alert can be OBSERVED. The refusal alert is the user-visible
// half of this fix: during the tenancy outage the ledger and the alert were both
// silent, and a counter nobody can see firing is not an improvement.
vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

import { runExecutionArchive, ARCHIVE_STREAM, type ArchiveRow } from '../execution-archive'
import { EXPECTED_ORGANIZATION_SLUG } from '../../archive/disposition'
import { ARCHIVE_JOB_NAMES } from '../../archive/alerts'
import { notifyExportFailure } from '../export-alerts'
import {
  makeArchiveDouble,
  makeKV,
  rowsFor,
  HOUR_START,
  NOW,
  EXECUTION_ID,
} from './_archive-double'

async function run(organizationSlug: string) {
  const double = makeArchiveDouble({ organizationSlug })
  const sent: ArchiveRow[] = []
  const env = { IDEMPOTENCY: makeKV(), SSN_HASH_PEPPER: 'test-pepper' } as unknown as Env
  const summary = await runExecutionArchive(env, double.client, {
    sendBatch: async (rows) => { sent.push(...rows) },
    now: () => NOW,
  })
  return { summary, sent, writes: double.writes }
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
})

describe("the archive records each hour's reconciled counts (#872)", () => {
  it('writes the hour to execution_archive_hours, keyed on its start and its day', async () => {
    // The deletion gate SUMS these instead of counting a day's steps directly,
    // which timed out at 30 s against production volume. A day is 24 hours, so
    // a missing row here is how the gate detects an hour that was never
    // archived, and the archiver is the only thing that can write one.
    const { writes } = await run(EXPECTED_ORGANIZATION_SLUG)
    const hours = rowsFor(writes, 'execution_archive_hours') as Record<string, unknown>[]

    expect(hours).toHaveLength(1)
    expect(hours[0].hour_start).toBe(HOUR_START)
    expect(hours[0].archive_day).toBe('2026-08-22')
    expect(hours[0].execution_count).toBe(1)
    expect(hours[0].step_count).toBe(1)
  })

  it('writes the hour even when every execution in it was refused', async () => {
    // The hour still RECONCILED: the rows read matched the counts taken. What
    // the archiver then did with them is a different question, and skipping the
    // row would make the gate report a missing hour for an hour that was fully
    // read.
    const { writes } = await run('someone-else')
    const hours = rowsFor(writes, 'execution_archive_hours') as Record<string, unknown>[]

    expect(hours).toHaveLength(1)
    expect(hours[0].execution_count).toBe(1)
  })
})

describe('the archive records a refusal in the database (#957)', () => {
  it('writes the refused execution to execution_archive_refusals', async () => {
    const { summary, writes } = await run('someone-else')

    expect(summary.executionsRefused).toBe(1)
    const refusals = rowsFor(writes, 'execution_archive_refusals') as Record<string, unknown>[]
    expect(refusals).toHaveLength(1)
    expect(refusals[0].execution_id).toBe(EXECUTION_ID)
    // The reason must name the tenancy, not just be non-empty: a refusal row
    // whose reason reads like a different problem is worse than none (L11).
    expect(String(refusals[0].reason)).toMatch(/organization|tenan/i)
    expect(refusals[0].resolved_at).toBeNull()
  })

  it('stamps the refusal with a real archive day, never an empty string', async () => {
    const { writes } = await run('someone-else')
    const refusals = rowsFor(writes, 'execution_archive_refusals') as Record<string, unknown>[]

    // archive_day is DATE NOT NULL. An empty string reaches Postgres as invalid
    // date syntax, which throws inside the run and stalls the watermark on an
    // hour that can never pass, so the fallback shape matters as much as the
    // write happening at all.
    expect(refusals[0].archive_day).toBe('2026-08-22')
  })

  it('does not send a refused execution to the archive or count it as archived', async () => {
    const { summary, sent, writes } = await run('someone-else')

    expect(sent).toEqual([])
    expect(rowsFor(writes, 'execution_archive_ids')).toEqual([])
    expect(summary.executionsArchived).toBe(0)
  })

  it('records no refusal, and archives the row, when the tenancy matches', async () => {
    // The negative control. Without it the three tests above are satisfied by an
    // archiver that refuses EVERYTHING, which is precisely the state #949 fixed.
    const { summary, sent, writes } = await run(EXPECTED_ORGANIZATION_SLUG)

    expect(rowsFor(writes, 'execution_archive_refusals')).toEqual([])
    expect(summary.executionsRefused).toBe(0)
    expect(summary.executionsArchived).toBe(1)
    expect(sent.map((r) => r.executionId)).toEqual([EXECUTION_ID])
    expect(rowsFor(writes, 'execution_archive_ids')).toHaveLength(1)
  })

  it('advances the watermark past the hour it refused', async () => {
    // A permanent per-execution refusal must not hold the watermark, or one row
    // stops all archiving forever with nothing able to clear it. That is the
    // whole reason the refusal ledger exists rather than a retry.
    const { writes } = await run('someone-else')
    const progress = rowsFor(writes, 'execution_archive_progress') as Record<string, unknown>[]

    expect(progress.length).toBeGreaterThan(0)
    expect(progress[0].stream).toBe(ARCHIVE_STREAM)
    expect(progress[0].watermark_hour).toBe(HOUR_START)
  })

  it('raises the refusal alert when everything it read was refused', async () => {
    await run('someone-else')

    const calls = vi.mocked(notifyExportFailure).mock.calls
    const refusal = calls.find((c) => c[1] === ARCHIVE_JOB_NAMES.refusal)
    expect(refusal, 'a run that refused every execution must raise the refusal alert').toBeDefined()
    // The wording has to say nothing was backed up, not just that something was
    // refused: one benign refusal and a total outage arriving on the same path
    // reading identically is how the tenancy failure stayed quiet.
    expect(String((refusal as unknown[])[2])).toMatch(/every one of the 1/)
  })

  it('raises no alert at all on a clean run', async () => {
    // The negative control for the alert. Without it the assertion above is
    // satisfied by an archiver that alerts on every run, which is the other way
    // to make an alert useless.
    await run(EXPECTED_ORGANIZATION_SLUG)

    const named = vi.mocked(notifyExportFailure).mock.calls.map((c) => c[1])
    expect(named).not.toContain(ARCHIVE_JOB_NAMES.refusal)
  })
})
