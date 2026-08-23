/**
 * Re-archiving a named hour (#976).
 *
 * Drives the REAL `runExecutionArchive` in its `hours` mode against the
 * recording double, so what is asserted is what the archiver actually did with
 * the request, not that a function was called.
 *
 * The property that matters most is the one that is easiest to get wrong: the
 * watermark must not move. Forward would skip every hour in between; backward
 * would re-archive everything since. A named hour is a repair, not progress.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../index'

vi.mock('../export-alerts', () => ({ notifyExportFailure: vi.fn().mockResolvedValue(undefined) }))

import { runExecutionArchive, type ArchiveRow } from '../execution-archive'
import { EXPECTED_ORGANIZATION_SLUG } from '../../archive/disposition'
import { notifyExportFailure } from '../export-alerts'
import { makeArchiveDouble, makeKV, rowsFor, NOW, EXECUTION_ID } from './_archive-double'

/** An hour long settled at NOW (2026-08-22T10:00Z), and not the one the watermark points at. */
const NAMED_HOUR = '2026-08-22T05:00:00.000Z'

async function reArchive(hours: string[], organizationSlug = EXPECTED_ORGANIZATION_SLUG) {
  const double = makeArchiveDouble({ organizationSlug })
  const sent: ArchiveRow[] = []
  const env = { IDEMPOTENCY: makeKV(), SSN_HASH_PEPPER: 'test-pepper' } as unknown as Env
  const summary = await runExecutionArchive(env, double.client, {
    sendBatch: async (rows) => { sent.push(...rows) },
    now: () => NOW,
    hours,
  })
  return { summary, sent, writes: double.writes }
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
})

describe('re-archiving a named hour', () => {
  it('archives it, through the same send the hourly job uses', async () => {
    const { summary, sent } = await reArchive([NAMED_HOUR])

    expect(summary.executionsArchived).toBe(1)
    expect(sent.map((r) => r.executionId)).toEqual([EXECUTION_ID])
  })

  it('does not touch the watermark', async () => {
    // The load-bearing property. Forward skips every hour in between; backward
    // re-archives everything since.
    const { writes } = await reArchive([NAMED_HOUR])

    expect(rowsFor(writes, 'execution_archive_progress')).toEqual([])
  })

  it('records the hour, so the deletion gate stops reading it as never archived', async () => {
    // The whole point of the repair: the gate refuses a day that is missing any
    // of its 24 hours, and this is the only thing that can fill one in.
    const { writes } = await reArchive([NAMED_HOUR])
    const hours = rowsFor(writes, 'execution_archive_hours') as Record<string, unknown>[]

    expect(hours).toHaveLength(1)
    expect(hours[0].hour_start).toBe(NAMED_HOUR)
  })

  it('writes the archived id, so a re-run of the gate sees it', async () => {
    const { writes } = await reArchive([NAMED_HOUR])

    expect(rowsFor(writes, 'execution_archive_ids')).toHaveLength(1)
  })

  it('archives every hour it was given', async () => {
    const { summary } = await reArchive([NAMED_HOUR, '2026-08-22T06:00:00.000Z'])

    expect(summary.hoursArchived).toBe(2)
  })

  it('reports a repair rather than a lag', async () => {
    // hoursBehind would be a number about something this run did not do: it
    // never looked at the watermark.
    const { summary } = await reArchive([NAMED_HOUR])

    expect(summary.hoursBehind).toBe(0)
    expect(summary.detail).toMatch(/re-archived 1 hours/)
    expect(summary.failed).toBe(false)
  })

  it('still refuses an execution it should refuse, and records why', async () => {
    // The repair is not a way around disposition. An execution from another
    // organization is refused here exactly as it is on the hourly run.
    const { summary, sent, writes } = await reArchive([NAMED_HOUR], 'someone-else')

    expect(sent).toEqual([])
    expect(summary.executionsRefused).toBe(1)
    expect(rowsFor(writes, 'execution_archive_refusals')).toHaveLength(1)
  })
})
