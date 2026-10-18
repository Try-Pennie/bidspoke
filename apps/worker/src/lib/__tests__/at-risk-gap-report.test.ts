/**
 * The daily report of the at-risk watch's gap (#2055): one job_runs row a day,
 * zero days included, so a missing row means the report did not run, and a row
 * with gaps names the runs and steps nothing will read back.
 */
import { describe, it, expect, vi } from 'vitest'
import { atRiskGapKey, type AtRiskGapKind } from '../../engine/at-risk-gap'
import { runAtRiskGapReport, AT_RISK_GAP_REPORT_JOB, MAX_GAPS_NAMED } from '../at-risk-gap-report'
import type { JobRunEnding } from '../job-run-record'

const NOW = Date.parse('2026-10-19T13:00:00Z')
const YESTERDAY = '2026-10-18'

function kvWith(keys: string[], opts: { pageSize?: number; listFails?: boolean } = {}) {
  const sorted = [...keys].sort()
  const lists: Array<{ prefix: string; cursor?: string }> = []
  return {
    lists,
    async list(o: { prefix: string; limit: number; cursor?: string }) {
      lists.push({ prefix: o.prefix, cursor: o.cursor })
      if (opts.listFails) throw new Error('KV LIST failed: 503 Service Unavailable')
      const matching = sorted.filter((k) => k.startsWith(o.prefix))
      const size = Math.min(o.limit, opts.pageSize ?? o.limit)
      const from = o.cursor ? Number(o.cursor) : 0
      const page = matching.slice(from, from + size)
      const done = from + size >= matching.length
      return { keys: page.map((name) => ({ name })), list_complete: done, ...(done ? {} : { cursor: String(from + size) }) }
    },
  }
}

const fact = (kind: AtRiskGapKind, ex: string, step = 'patch_prospect_reject', day = YESTERDAY) => atRiskGapKey(day, kind, ex, step)

function recorder() {
  const rows: Array<{ startedAtMs: number; ending: JobRunEnding }> = []
  return { rows, recordRun: async (startedAtMs: number, ending: JobRunEnding) => { rows.push({ startedAtMs, ending }) } }
}

describe('runAtRiskGapReport', () => {
  it('records a row for a day with nothing in it, so a missing row means the report did not run', async () => {
    const rec = recorder()
    const report = await runAtRiskGapReport({ kv: kvWith([]), now: () => NOW, recordRun: rec.recordRun })
    expect(report).toMatchObject({ day: YESTERDAY, cut_off_runs: 0, gaps: 0 })
    expect(rec.rows).toHaveLength(1)
    expect(rec.rows[0].ending.outcome).toBe('none')
    expect(AT_RISK_GAP_REPORT_JOB).toBe('at-risk-gap-report')
  })

  it('counts each kind of fact for yesterday, and only yesterday', async () => {
    const rec = recorder()
    const kv = kvWith([
      fact('cut_off', 'ex-1', '-'),
      fact('held', 'ex-1'),
      fact('cut_off', 'ex-2', '-'),
      fact('exposed', 'ex-2'),
      fact('caught_up', 'ex-2'),
      // Today's and the day before's are another report's.
      fact('cut_off', 'ex-9', '-', '2026-10-19'),
      fact('unrecorded', 'ex-8', 'x', '2026-10-17'),
    ])
    const report = await runAtRiskGapReport({ kv, now: () => NOW, recordRun: rec.recordRun })
    expect(report).toMatchObject({ cut_off_runs: 2, held: 1, exposed: 1, caught_up: 1, unrecorded: 0, missed: 0, unreported: 0, gaps: 0 })
    expect(kv.lists.every((l) => l.prefix === `at-risk-gap:${YESTERDAY}:`)).toBe(true)
    expect(rec.rows[0].ending.outcome).toBe('none')
  })

  it('names every gap: unrecorded, missed, and a start with no second look (the request was cancelled first)', async () => {
    const rec = recorder()
    const kv = kvWith([
      fact('cut_off', 'ex-1', '-'),
      fact('unrecorded', 'ex-1'),
      fact('cut_off', 'ex-2', '-'),
      fact('exposed', 'ex-2'),
      fact('missed', 'ex-2'),
      fact('late_start', 'ex-3', 'update_lead'),
      fact('late_start', 'ex-4', 'update_lead'),
      fact('caught_up', 'ex-4', 'update_lead'),
    ])
    const report = await runAtRiskGapReport({ kv, now: () => NOW, recordRun: rec.recordRun })
    expect(report).toMatchObject({ unrecorded: 1, missed: 1, late_start: 2, caught_up: 1, unreported: 1, gaps: 3 })
    expect(report.named).toEqual([
      { execution_id: 'ex-1', step_namespace: 'patch_prospect_reject', how: 'unrecorded' },
      { execution_id: 'ex-2', step_namespace: 'patch_prospect_reject', how: 'missed' },
      { execution_id: 'ex-3', step_namespace: 'update_lead', how: 'cancelled' },
    ])
    expect(rec.rows[0].ending.outcome).toBe('gap-found')
    expect(rec.rows[0].ending.detail).toContain('gaps=3')
    expect(rec.rows[0].ending.summary).toMatchObject({ day: YESTERDAY, gaps: 3 })
  })

  it('reads every page of the list', async () => {
    const keys = Array.from({ length: 7 }, (_, i) => fact('cut_off', `ex-${i}`, '-'))
    const kv = kvWith(keys, { pageSize: 3 })
    const report = await runAtRiskGapReport({ kv, now: () => NOW, recordRun: recorder().recordRun })
    expect(report.cut_off_runs).toBe(7)
    expect(kv.lists.length).toBe(3)
    expect(report.truncated).toBe(false)
  })

  it('names at most MAX_GAPS_NAMED gaps, and counts the rest', async () => {
    const keys = Array.from({ length: MAX_GAPS_NAMED + 5 }, (_, i) => fact('unrecorded', `ex-${String(i).padStart(3, '0')}`))
    const report = await runAtRiskGapReport({ kv: kvWith(keys), now: () => NOW, recordRun: recorder().recordRun })
    expect(report.gaps).toBe(MAX_GAPS_NAMED + 5)
    expect(report.named).toHaveLength(MAX_GAPS_NAMED)
  })

  it('records that the day could not be read rather than a clean zero, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rec = recorder()
    const report = await runAtRiskGapReport({ kv: kvWith([], { listFails: true }), now: () => NOW, recordRun: rec.recordRun })
    expect(report.unreadable).toBe(true)
    expect(rec.rows[0].ending.outcome).toBe('unreadable')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
