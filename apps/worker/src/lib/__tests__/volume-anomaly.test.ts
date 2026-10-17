/**
 * Volume anomaly detection — PRD Section 3.6
 * Covers: drop detection, spike detection, insufficient-data guard,
 * zero-baseline guard, threshold edge cases.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { detectAnomaly, MIN_BASELINE_DAYS, runVolumeAnomalyCheck } from '../volume-anomaly'
import { PAGE_SIZE } from '../paginate'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'

function buildCounts(days: string[], count: number): Record<string, number> {
  return Object.fromEntries(days.map((d) => [d, count]))
}

const YESTERDAY = '2026-04-07'
const BASELINE_DAYS = ['2026-03-31', '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06']

describe('detectAnomaly()', () => {
  it('returns null when there are no anomalies (volume matches baseline)', () => {
    const counts = buildCounts([...BASELINE_DAYS, YESTERDAY], 100)
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
  })

  it('detects a drop when yesterday is below low threshold', () => {
    const counts = buildCounts(BASELINE_DAYS, 100)
    counts[YESTERDAY] = 40  // 40% of 100 = drop (threshold: 50%)
    const result = detectAnomaly(counts, YESTERDAY)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('drop')
    expect(result!.yesterdayCount).toBe(40)
    expect(result!.baselineAvg).toBe(100)
  })

  it('does NOT alert when yesterday is exactly at the low threshold', () => {
    const counts = buildCounts(BASELINE_DAYS, 100)
    counts[YESTERDAY] = 50  // exactly 50% → not below threshold
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
  })

  it('detects a spike when yesterday exceeds high threshold', () => {
    const counts = buildCounts(BASELINE_DAYS, 100)
    counts[YESTERDAY] = 250  // 250% of 100 = spike (threshold: 200%)
    const result = detectAnomaly(counts, YESTERDAY)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('spike')
    expect(result!.yesterdayCount).toBe(250)
  })

  it('does NOT alert when yesterday is exactly at the high threshold', () => {
    const counts = buildCounts(BASELINE_DAYS, 100)
    counts[YESTERDAY] = 200  // exactly 200% → not above threshold
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
  })

  it(`returns null when baseline has fewer than ${MIN_BASELINE_DAYS} days`, () => {
    const counts: Record<string, number> = {
      '2026-04-05': 100,
      '2026-04-06': 100,
      [YESTERDAY]: 10,  // only 2 baseline days
    }
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
  })

  it('returns null when baseline average is zero (no prior traffic)', () => {
    const counts = buildCounts(BASELINE_DAYS, 0)
    counts[YESTERDAY] = 0
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
  })

  it('returns null when yesterday has no entries (treated as 0) but baseline is also 0', () => {
    const counts = buildCounts(BASELINE_DAYS, 0)
    // yesterday not in map — defaults to 0
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
  })

  it('treats missing yesterday key as 0 count', () => {
    const counts = buildCounts(BASELINE_DAYS, 100)
    // yesterday omitted → 0/100 = 0% → drop
    const result = detectAnomaly(counts, YESTERDAY)
    expect(result?.kind).toBe('drop')
    expect(result?.yesterdayCount).toBe(0)
  })

  it('respects custom threshold overrides', () => {
    const counts = buildCounts(BASELINE_DAYS, 100)
    counts[YESTERDAY] = 70  // 70% — OK at default 50%, but alert at custom 80%
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
    expect(detectAnomaly(counts, YESTERDAY, 80)).not.toBeNull()
    expect(detectAnomaly(counts, YESTERDAY, 80)!.kind).toBe('drop')
  })

  it('rounds baselineAvg in the result', () => {
    // 3 weekdays (Wed/Thu/Fri before YESTERDAY=Tue): 3+3+4 = 10 / 3 = 3.33 → rounded to 3
    const counts: Record<string, number> = {
      '2026-04-01': 3,  // Wed
      '2026-04-02': 3,  // Thu
      '2026-04-03': 4,  // Fri
      [YESTERDAY]: 0,   // Tue — triggers drop
    }
    const result = detectAnomaly(counts, YESTERDAY)
    expect(result?.baselineAvg).toBe(Math.round((3 + 3 + 4) / 3))
  })

  it('uses only the 7 most recent same-day-type days when more data is available', () => {
    // YESTERDAY=2026-04-07 (Tue). The 8 most recent weekdays before it:
    //   Apr 6 Mon, Apr 3 Fri, Apr 2 Thu, Apr 1 Wed, Mar 31 Tue, Mar 30 Mon, Mar 27 Fri, Mar 26 Thu
    // The 8th-most-recent (Mar 26) should be excluded from the 7-day baseline window.
    const weekdays = ['2026-03-26', '2026-03-27', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02', '2026-04-03', '2026-04-06']
    const counts: Record<string, number> = {}
    weekdays.forEach((d, idx) => {
      counts[d] = idx === 0 ? 9999 : 100  // earliest day is the outlier
    })
    counts[YESTERDAY] = 40  // drop vs 100 baseline
    const result = detectAnomaly(counts, YESTERDAY)
    expect(result?.kind).toBe('drop')
    expect(result?.baselineAvg).toBe(100)  // outlier excluded
  })

  it('compares weekend days against weekend baseline only', () => {
    const SUNDAY = '2026-04-12'  // Sun
    // 4 prior weekend days (low traffic) + 5 prior weekdays (high traffic)
    const counts: Record<string, number> = {
      // weekends — baseline should use these
      '2026-03-28': 10,  // Sat
      '2026-03-29': 12,  // Sun
      '2026-04-04': 8,   // Sat
      '2026-04-05': 14,  // Sun
      // weekdays — should be ignored when YESTERDAY is a weekend
      '2026-04-06': 200,
      '2026-04-07': 200,
      '2026-04-08': 200,
      '2026-04-09': 200,
      '2026-04-10': 200,
      [SUNDAY]: 11,  // ~within weekend baseline avg of 11 → no anomaly
    }
    expect(detectAnomaly(counts, SUNDAY)).toBeNull()
  })

  it('does not alert on a low-traffic weekend when only weekdays are in baseline', () => {
    const SATURDAY = '2026-04-11'
    // Only weekday baseline data — insufficient same-day-type data → null
    const counts: Record<string, number> = {
      '2026-04-06': 200,  // Mon
      '2026-04-07': 210,  // Tue
      '2026-04-08': 190,  // Wed
      '2026-04-09': 200,  // Thu
      '2026-04-10': 200,  // Fri
      [SATURDAY]: 5,
    }
    expect(detectAnomaly(counts, SATURDAY)).toBeNull()
  })

  // Issue #80: today's partial day (the day AFTER yesterday) must not be in the
  // baseline. It's a low partial count at 13:00 UTC and would deflate the avg.
  const TODAY = '2026-04-08' // Wed, the day after YESTERDAY=2026-04-07 (Tue), same day-type

  it('excludes today and does not over-fire a spike', () => {
    const counts = buildCounts(BASELINE_DAYS, 100) // 7 prior weekdays @ 100
    counts[YESTERDAY] = 190 // below the 200% spike threshold vs a baseline of 100
    counts[TODAY] = 5       // partial-day low count
    // If today were averaged in, the baseline drops to ~86 and 190 would exceed
    // 2x → false spike. Excluded → baseline stays 100 → no anomaly.
    expect(detectAnomaly(counts, YESTERDAY)).toBeNull()
  })

  it('excludes today and does not under-fire a real drop', () => {
    const counts = buildCounts(BASELINE_DAYS, 100)
    counts[YESTERDAY] = 45 // a genuine drop vs a baseline of 100 (< 50%)
    counts[TODAY] = 5      // partial-day low count
    // If today were averaged in, the baseline drops to ~86 and 45 would be above
    // 50% of it → the real drop would be missed. Excluded → the drop fires.
    const result = detectAnomaly(counts, YESTERDAY)
    expect(result?.kind).toBe('drop')
    expect(result?.baselineAvg).toBe(100)
  })

  it('detects a drop on a weekday relative to weekday-only baseline', () => {
    // YESTERDAY=Tue. Mix in weekend days that should be ignored.
    const counts: Record<string, number> = {
      '2026-03-30': 100,  // Mon
      '2026-03-31': 100,  // Tue
      '2026-04-01': 100,  // Wed
      '2026-04-02': 100,  // Thu
      '2026-04-03': 100,  // Fri
      '2026-04-04': 5,    // Sat — would drag baseline down if included
      '2026-04-05': 5,    // Sun — same
      '2026-04-06': 100,  // Mon
      [YESTERDAY]: 30,    // 30% of weekday baseline 100 → drop
    }
    const result = detectAnomaly(counts, YESTERDAY)
    expect(result?.kind).toBe('drop')
    expect(result?.baselineAvg).toBe(100)
  })
})

// workflow_stats_daily is growing toward PostgREST's 1,000-row cap (the
// big-table-guard alert on 2026-07-08). A bare .select() of it silently
// truncates past that cap, exactly the class of bug the doc comment at the
// top of volume-anomaly.ts already describes for the table this rollup
// replaced. This mock simulates that cap: `.eq()` alone (no `.range()`)
// resolves to only the first PAGE_SIZE rows, matching real PostgREST
// behavior; `.range(from, to)` returns the correctly sliced page.
function makeSupabase(statsRows: { workflow_id: string; day: string; run_count: number; is_test: boolean }[]) {
  const terminal = (): unknown => ({
    then: (resolve: (v: unknown) => void) => resolve({ data: statsRows.slice(0, PAGE_SIZE), error: null }),
    range: (from: number, to: number) => Promise.resolve({ data: statsRows.slice(from, to + 1), error: null }),
    order: () => terminal(), // chainable no-op, matches real query builder semantics
  })
  return {
    from(table: string) {
      if (table === 'service_connections') {
        // The alert row reads (#2332): the org list is awaited as it is; one
        // org's connection ends in .limit(2).
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          or: () => chain,
          limit: () => Promise.resolve({ data: [{ config: { bot_token: 'xoxb', default_channel: '#alerts' } }], error: null }),
          then: (resolve: (v: unknown) => void) => resolve({ data: [{ organization_id: 'org-1' }], error: null }),
        }
        return chain
      }
      if (table === 'workflows') {
        return { select: () => ({ in: () => ({ eq: () => ({ is: async () => ({ data: [{ id: 'wf-1', organization_id: 'org-1' }], error: null }) }) }) }) }
      }
      if (table === 'workflow_stats_daily') {
        return { select: () => ({ in: () => ({ gte: () => ({ eq: () => terminal() }) }) }) }
      }
      throw new Error(`unexpected table in test mock: ${table}`)
    },
  }
}

describe('runVolumeAnomalyCheck', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-08T13:00:00Z')) // "yesterday" = 2026-04-07 (Tue)
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.2' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('detects a real anomaly whose baseline rows sit past row 1000, instead of truncating them away', async () => {
    // All filler dated "today" (2026-04-08): detectAnomaly's `day < yesterday`
    // filter excludes it entirely, so it contributes zero baseline days on its
    // own. A test where filler happens to supply its own accidental baseline
    // (e.g. spread across real historical weekdays) would pass even without
    // pagination, proving nothing.
    const filler = Array.from({ length: PAGE_SIZE }, () => ({
      workflow_id: 'wf-1', day: '2026-04-08', run_count: 1, is_test: false,
    }))
    const real = [
      { workflow_id: 'wf-1', day: '2026-04-01', run_count: 100, is_test: false }, // Wed
      { workflow_id: 'wf-1', day: '2026-04-02', run_count: 100, is_test: false }, // Thu
      { workflow_id: 'wf-1', day: '2026-04-03', run_count: 100, is_test: false }, // Fri
      { workflow_id: 'wf-1', day: '2026-04-07', run_count: 20, is_test: false },  // Tue (yesterday), a real drop
    ]
    const supabase = makeSupabase([...filler, ...real])

    await runVolumeAnomalyCheck(supabase as never)

    // A bare truncated-at-1000 read only ever sees `filler` (all dated 2025,
    // outside the baseline window) and never finds 3 same-day-type baseline
    // days, so detectAnomaly returns null and no alert fires. Full pagination
    // sees the real rows past index 1000 and correctly detects the drop.
    expect(fetchMock).toHaveBeenCalled()
    // #835: the check counts runs and nothing else, so it may not guess a cause.
    const body = JSON.stringify(await slackPostOf(fetchMock.mock.calls[0]))
    expect(body).toContain('20')
    expect(body).not.toMatch(/may indicate|upstream source outage/)
  })
})
