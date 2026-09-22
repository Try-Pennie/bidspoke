/**
 * Refusal writes are batched, and they are counted against the run's subrequest
 * budget (#965).
 *
 * The budget starts at 900 and only the reads, the send and `recordArchived`
 * decremented it. `upsertRefusal` was called once per refused execution and
 * decremented nothing, so a mass refusal, which is the exact event the refusal
 * alert exists to report, would issue thousands of uncounted sequential writes
 * in one invocation. #949 measured 5,617 of 5,617 executions refused in a single
 * hour. That run would breach the platform's per invocation subrequest limit
 * while `subrequestsLeft()` still reported around 840, so the loop's clean stop
 * could never fire and the invocation would be killed instead, destroying the
 * alert with the event it exists to announce.
 *
 * These tests drive the REAL `runExecutionArchive` against the recording double,
 * so they observe the writes actually issued rather than the functions called.
 * Mutation checked: reverting the disposition loop to one `upsertRefusal` per
 * execution fails the batching test, and dropping the budget decrement from the
 * refusal writer fails the accounting test while leaving the batching one green.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../../index'

vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

import { runExecutionArchive, type ArchiveRow } from '../execution-archive'
import { EXPECTED_ORGANIZATION_SLUG } from '../../archive/disposition'
import { makeArchiveDouble, makeKV, rowsFor, NOW } from './_archive-double'

const REFUSED_POPULATION = 5

async function run(organizationSlug: string, executions: number) {
  const double = makeArchiveDouble({ organizationSlug, executions })
  const sent: ArchiveRow[] = []
  const env = { IDEMPOTENCY: makeKV(), SSN_HASH_PEPPER: 'test-pepper' } as unknown as Env
  const summary = await runExecutionArchive(env, double.client, {
    sendBatch: async (rows) => { sent.push(...rows) },
    now: () => NOW,
  })
  // Requests, not rows. The whole point of the fix is that these two numbers
  // stop being equal.
  const refusalRequests = double.writes.filter((w) => w.table === 'execution_archive_refusals').length
  return { summary, sent, writes: double.writes, refusalRequests }
}

describe('the archive batches its refusal writes (#965)', () => {
  it('writes many refusals in one request rather than one request each', async () => {
    const { refusalRequests, writes } = await run('someone-else', REFUSED_POPULATION)

    expect(rowsFor(writes, 'execution_archive_refusals')).toHaveLength(REFUSED_POPULATION)
    expect(refusalRequests).toBe(1)
  })

  it('still records every refused execution by its own id', async () => {
    // The batching must not collapse the population. One request carrying one
    // row would satisfy the test above and lose four executions.
    const { writes } = await run('someone-else', REFUSED_POPULATION)
    const ids = (rowsFor(writes, 'execution_archive_refusals') as Record<string, unknown>[])
      .map((r) => r.execution_id)

    expect(new Set(ids).size).toBe(REFUSED_POPULATION)
  })
})

describe('the archive counts its refusal writes against the subrequest budget (#965)', () => {
  it('reports the refusal requests it issued, matching the writes the client saw', async () => {
    const { summary, refusalRequests } = await run('someone-else', REFUSED_POPULATION)

    // Two independent sides: the archiver's own counter, and the double's
    // recording of the calls that actually reached the client (L70).
    expect(refusalRequests).toBeGreaterThan(0)
    expect(summary.subrequestsUsed.refusal).toBe(refusalRequests)
  })

  it('counts the reads too, so the total is a real measurement and not just the refusals', async () => {
    const { summary } = await run('someone-else', REFUSED_POPULATION)

    expect(summary.subrequestsUsed.read).toBeGreaterThan(0)
    expect(summary.subrequestsUsed.total).toBe(
      summary.subrequestsUsed.read +
        summary.subrequestsUsed.send +
        summary.subrequestsUsed.record +
        summary.subrequestsUsed.refusal,
    )
  })

  it('counts no refusal requests on a clean run, and does count the send and the record', async () => {
    // The negative control. Without it the assertions above are satisfied by an
    // archiver that counts a refusal for every execution it touches.
    const { summary, refusalRequests } = await run(EXPECTED_ORGANIZATION_SLUG, REFUSED_POPULATION)

    expect(refusalRequests).toBe(0)
    expect(summary.subrequestsUsed.refusal).toBe(0)
    expect(summary.subrequestsUsed.send).toBeGreaterThan(0)
    expect(summary.subrequestsUsed.record).toBeGreaterThan(0)
  })
})
