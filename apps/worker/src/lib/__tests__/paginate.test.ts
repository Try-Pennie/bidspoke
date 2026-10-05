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

  // #1681: a caller that must have every row or none (the env loader caches what
  // it read as the whole set) names a page bound, and a read still full at the
  // bound is refused rather than handed back short (L211).
  it('refuses a read still returning full pages at a named page bound', async () => {
    let n = 0
    await expect(
      fetchAllPaged(async () => { n++; return { data: page(PAGE_SIZE, n * PAGE_SIZE), error: null } }, 'env read', { maxPages: 3 }),
    ).rejects.toThrow('env read did not reach its last row within 3 pages')
    expect(n).toBe(3)
  })

  it('returns every row when the end arrives within the named bound', async () => {
    const pages = [page(PAGE_SIZE, 0), page(PAGE_SIZE, PAGE_SIZE), page(1, 2 * PAGE_SIZE)]
    let n = 0
    const rows = await fetchAllPaged<{ id: string }>(async () => ({ data: pages[n++] ?? [], error: null }), 'env read', { maxPages: 3 })
    expect(rows).toHaveLength(2 * PAGE_SIZE + 1)
  })
})
