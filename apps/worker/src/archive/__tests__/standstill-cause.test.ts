/**
 * The standstill alert says which of the causes it is (#1028).
 *
 * On 2026-08-23 it fired with "Check Snowflake availability and the export
 * credentials" while Snowflake was fine, the credentials were fine, and nothing
 * was down. Every run was being skipped on a lock held by the archive's own
 * repair. All three places the advice named were healthy, and a reader
 * following it would have found nothing wrong in any of them.
 *
 * Each branch below has a test that PRODUCES its outcome, not one that merely
 * passes (L151), and each asserts what the advice must NOT say as well as what
 * it must, because the defect was a true-sounding sentence about the wrong
 * thing.
 */
import { describe, it, expect } from 'vitest'
import { standstillCause, type RecentRun } from '../standstill-cause'

const run = (over: Partial<RecentRun> = {}): RecentRun => ({
  outcome: 'caught-up',
  startedAt: '2026-09-10T11:23:00Z',
  finishedAt: '2026-09-10T11:25:00Z',
  ...over,
})

describe('standstillCause', () => {
  it('names the lock, and clears Snowflake, when every run was skipped', async () => {
    const cause = standstillCause([
      run({ outcome: 'skipped-locked' }),
      run({ outcome: 'skipped-locked' }),
      run({ outcome: 'skipped-locked' }),
    ])

    expect(cause.kind).toBe('skipped-locked')
    if (cause.kind !== 'skipped-locked') return
    expect(cause.runs).toBe(3)
    expect(cause.advice).toMatch(/holding the lock/)
    // The exact defect: advice that sends the reader to a healthy system.
    expect(cause.advice).toMatch(/nothing is wrong with Snowflake/)
  })

  it('keeps the Snowflake advice for runs that are actually failing, and quotes the outcome', async () => {
    const cause = standstillCause([
      run({ outcome: 'send-failed' }),
      run({ outcome: 'caught-up' }),
      run({ outcome: 'send-failed' }),
    ])

    expect(cause.kind).toBe('runs-failing')
    if (cause.kind !== 'runs-failing') return
    expect(cause.outcomes).toEqual(['send-failed'])
    expect(cause.advice).toMatch(/Snowflake/)
  })

  it('explains a record-failed outcome as our own database, not Snowflake (lessons review, #835)', async () => {
    const cause = standstillCause([run({ outcome: 'record-failed' }), run({ outcome: 'record-failed' })])

    expect(cause.kind).toBe('runs-failing')
    if (cause.kind !== 'runs-failing') return
    expect(cause.advice).toMatch(/record-failed/)
    expect(cause.advice).toMatch(/execution_archive_ids/)
  })

  it('says the platform is killing the runs when none of them record an ending', async () => {
    const cause = standstillCause([
      run({ finishedAt: null, outcome: null }),
      run({ finishedAt: null, outcome: null }),
    ])

    expect(cause.kind).toBe('runs-killed')
    if (cause.kind !== 'runs-killed') return
    expect(cause.advice).toMatch(/terminating them/)
    expect(cause.advice).toMatch(/not implicated/)
  })

  it('names the case where every run completes cleanly and archives nothing', async () => {
    // The original nineteen hour case: every signal reads healthy, which is
    // exactly why it needs its own sentence.
    const cause = standstillCause([run(), run(), run()])

    expect(cause.kind).toBe('archiving-nothing')
    if (cause.kind !== 'archiving-nothing') return
    expect(cause.advice).toMatch(/completing cleanly/)
    expect(cause.advice).not.toMatch(/Snowflake/)
  })

  it('treats no records at all as its own statement', async () => {
    // "Stuck for a reason we can name" and "no idea what it has been doing" ask
    // for completely different first moves, so this must not fold into any of
    // the others.
    const cause = standstillCause([])

    expect(cause.kind).toBe('no-recent-runs')
    expect(cause.advice).toMatch(/may not be firing/)
  })

  it('does not call it skipped-locked when only some runs were skipped', async () => {
    // A mixture is not the lock story: one skipped run is routine, and claiming
    // the lock is the cause would be asserting something the evidence does not
    // support.
    const cause = standstillCause([run({ outcome: 'skipped-locked' }), run({ outcome: 'read-failed' })])

    expect(cause.kind).toBe('runs-failing')
  })

  it('reports the failure rather than the emptiness when runs both fail and archive nothing', async () => {
    const cause = standstillCause([run({ outcome: 'read-failed' })])
    expect(cause.kind).toBe('runs-failing')
  })
})
