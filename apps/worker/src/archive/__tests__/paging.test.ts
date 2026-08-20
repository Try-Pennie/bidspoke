import { describe, it, expect } from 'vitest'
import {
  POSTGREST_ROW_CAP,
  MAX_STEP_LAG_MS,
  MEASURED_WORST_STEP_LAG_MS,
  stepWindowFor,
  fetchAllPages,
} from '../fetch'

describe('stepWindowFor', () => {
  const hourStart = '2026-08-18T10:00:00.000Z'
  const hourEnd = '2026-08-18T11:00:00.000Z'

  it('selects steps by the hour their EXECUTION belongs to', () => {
    const window = stepWindowFor(hourStart, hourEnd)

    expect(window.executionStartedFrom).toBe(hourStart)
    expect(window.executionStartedTo).toBe(hourEnd)
  })

  // The pruning hint exists only to keep the read inside a few daily partitions.
  // Bounding it by the hour end, or by the last execution's start, drops every
  // step that began after its execution's hour closed, which is most of the
  // steps of every execution near the end of the window.
  it('widens the partition hint past the hour end, so late steps are not dropped', () => {
    const window = stepWindowFor(hourStart, hourEnd)

    expect(window.stepStartedFrom).toBe(hourStart)
    expect(Date.parse(window.stepStartedTo)).toBe(Date.parse(hourEnd) + MAX_STEP_LAG_MS)
    expect(Date.parse(window.stepStartedTo)).toBeGreaterThan(Date.parse(hourEnd))
  })

  it('leaves headroom over the worst lag actually observed in production', () => {
    // Measured 2026-08-20 over 5 days and 5,250,914 step rows: the worst gap
    // between a step's start and its execution's start was 88.669 s, nothing
    // exceeded 5 minutes, and no step ever started before its execution.
    expect(MEASURED_WORST_STEP_LAG_MS).toBe(88_669)
    expect(MAX_STEP_LAG_MS).toBeGreaterThan(MEASURED_WORST_STEP_LAG_MS * 10)
  })
})

describe('fetchAllPages', () => {
  const pageOf = (n: number, offset = 0): { id: string }[] =>
    Array.from({ length: n }, (_, i) => ({ id: `row-${offset + i}` }))

  it('keeps paging while pages come back full, and stops on a short one', async () => {
    const calls: Array<[number, number]> = []
    const result = await fetchAllPages<{ id: string }>({
      expected: 250,
      pageSize: 100,
      fetchPage: async (from, to) => {
        calls.push([from, to])
        if (from >= 200) return { rows: pageOf(50, from) }
        return { rows: pageOf(100, from) }
      },
    })

    expect(result.usable).toBe(true)
    expect(result.rows).toHaveLength(250)
    expect(calls).toEqual([[0, 99], [100, 199], [200, 299]])
  })

  // A short read is FASTER, so truncation presents as a performance win. The
  // only thing separating the two is an independently sourced expectation.
  it('refuses when fewer rows came back than the independent count expected', async () => {
    const result = await fetchAllPages<{ id: string }>({
      expected: 250,
      pageSize: 100,
      fetchPage: async (from) => (from >= 100 ? { rows: [] } : { rows: pageOf(100, from) }),
    })

    expect(result.usable).toBe(false)
    if (result.usable) return
    expect(result.reason).toMatch(/100 against 250/)
  })

  it('refuses a page size above the row cap, because asking for more silently returns the cap', async () => {
    await expect(
      fetchAllPages<{ id: string }>({
        expected: 10,
        pageSize: POSTGREST_ROW_CAP + 1,
        fetchPage: async () => ({ rows: [] }),
      }),
    ).rejects.toThrow(new RegExp(String(POSTGREST_ROW_CAP)))
  })

  it('refuses on a page error rather than returning what it managed to collect', async () => {
    const result = await fetchAllPages<{ id: string }>({
      expected: 250,
      pageSize: 100,
      fetchPage: async (from) =>
        from === 100 ? { rows: [], error: 'connection reset' } : { rows: pageOf(100, from) },
    })

    expect(result.usable).toBe(false)
    if (result.usable) return
    expect(result.reason).toMatch(/connection reset/)
  })

  it('treats an expectation of zero as its own outcome, not as an error', async () => {
    let called = false
    const result = await fetchAllPages<{ id: string }>({
      expected: 0,
      pageSize: 100,
      fetchPage: async () => {
        called = true
        return { rows: [] }
      },
    })

    expect(result.usable).toBe(true)
    expect(result.rows).toEqual([])
    expect(called).toBe(false)
  })

  // If the table grew between the count and the read, pages keep arriving full
  // past the expectation. Reading forever would burn the whole run's budget.
  it('stops and refuses when more rows keep arriving than were expected', async () => {
    let pages = 0
    const result = await fetchAllPages<{ id: string }>({
      expected: 100,
      pageSize: 100,
      fetchPage: async (from) => {
        pages++
        return { rows: pageOf(100, from) }
      },
    })

    expect(result.usable).toBe(false)
    if (result.usable) return
    expect(result.reason).toMatch(/more rows/)
    expect(pages).toBeLessThanOrEqual(3)
  })
})
