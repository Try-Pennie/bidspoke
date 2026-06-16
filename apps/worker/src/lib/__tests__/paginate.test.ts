/**
 * Shared paginated-fetch helper (#115).
 *
 * Moved here from bid-matrix-sync.test.ts when fetchAllPaged was extracted into
 * its own module. Originally added for issue #84: the snapshot and stale-row
 * reads were unpaginated, so a matrix with >1000 rows was silently truncated —
 * the diff missed the tail and reported those rows as "added" on every hourly
 * sync. fetchAllPaged reads every row across pages.
 */
import { describe, it, expect } from 'vitest'
import { fetchAllPaged, PAGE_SIZE } from '../paginate'

describe('fetchAllPaged', () => {
  // A page of `n` rows with unique ids, simulating a PostgREST range response.
  function page(n: number, startId: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `r${startId + i}` }))
  }

  it('returns a single short page in one query', async () => {
    const calls: Array<[number, number]> = []
    const rows = await fetchAllPaged<{ id: string }>(async (from, to) => {
      calls.push([from, to])
      return { data: page(3, 0), error: null }
    }, 'test')
    expect(rows).toHaveLength(3)
    expect(calls).toEqual([[0, PAGE_SIZE - 1]])
  })

  it('pages until a short page and concatenates all rows', async () => {
    const pages = [page(PAGE_SIZE, 0), page(500, PAGE_SIZE)] // 1000 then 500 = 1500
    const calls: Array<[number, number]> = []
    const rows = await fetchAllPaged<{ id: string }>(async (from, to) => {
      calls.push([from, to])
      return { data: pages[calls.length - 1] ?? [], error: null }
    }, 'test')
    expect(rows).toHaveLength(1500)
    expect(calls).toEqual([[0, PAGE_SIZE - 1], [PAGE_SIZE, 2 * PAGE_SIZE - 1]])
    // No duplicates/skips — ids are contiguous.
    expect(rows[PAGE_SIZE].id).toBe(`r${PAGE_SIZE}`)
  })

  it('stops after a full final page returns an empty next page', async () => {
    let n = 0
    const rows = await fetchAllPaged<{ id: string }>(async () => {
      n++
      return { data: n === 1 ? page(PAGE_SIZE, 0) : [], error: null }
    }, 'test')
    expect(rows).toHaveLength(PAGE_SIZE)
    expect(n).toBe(2) // full page, then empty page
  })

  it('throws with the label on a query error', async () => {
    await expect(
      fetchAllPaged(async () => ({ data: null, error: { message: 'boom' } }), 'snapshot read'),
    ).rejects.toThrow('snapshot read failed: boom')
  })
})
