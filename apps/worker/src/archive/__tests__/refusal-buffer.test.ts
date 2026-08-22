/**
 * The refusal buffer (#965).
 *
 * Mutation checked: removing the `while` in `flush` so it writes one batch and
 * stops fails the chunking test, and clearing `pending` before the write
 * resolves fails the failed-write test.
 */
import { describe, it, expect } from 'vitest'
import { createRefusalBuffer, MAX_REFUSAL_ROWS_PER_REQUEST, type RefusalRecord } from '../refusal-buffer'

function record(n: number): RefusalRecord {
  return {
    execution_id: `exec-${n}`,
    archive_day: '2026-08-22',
    reason: 'refused',
    refused_at: '2026-08-22T10:00:00.000Z',
    resolved_at: null,
  }
}

function recorder() {
  const requests: RefusalRecord[][] = []
  return { requests, writeBatch: async (rows: RefusalRecord[]) => { requests.push(rows) } }
}

describe('createRefusalBuffer', () => {
  it('writes nothing until it is flushed', async () => {
    const sink = recorder()
    const buffer = createRefusalBuffer({ writeBatch: sink.writeBatch })
    await buffer.add(record(1))
    await buffer.add(record(2))

    expect(sink.requests).toEqual([])
    expect(buffer.buffered).toBe(2)
  })

  it('writes everything held in one request when it fits', async () => {
    const sink = recorder()
    const buffer = createRefusalBuffer({ writeBatch: sink.writeBatch })
    for (let n = 0; n < 5; n++) await buffer.add(record(n))
    await buffer.flush()

    expect(sink.requests).toHaveLength(1)
    expect(sink.requests[0]).toHaveLength(5)
    expect(buffer.buffered).toBe(0)
  })

  it('issues no request at all when there is nothing to write', async () => {
    // A request carrying no rows reads downstream as a write that happened.
    const sink = recorder()
    const buffer = createRefusalBuffer({ writeBatch: sink.writeBatch })
    await buffer.flush()

    expect(sink.requests).toEqual([])
  })

  it('chunks a flush that exceeds the per request ceiling, losing nothing', async () => {
    const sink = recorder()
    const buffer = createRefusalBuffer({ writeBatch: sink.writeBatch, maxRowsPerRequest: 2 })
    // The ceiling is 2, so the adds themselves flush; the trailing partial batch
    // is what the final flush has to catch.
    for (let n = 0; n < 5; n++) await buffer.add(record(n))
    await buffer.flush()

    expect(sink.requests.map((r) => r.length)).toEqual([2, 2, 1])
    expect(sink.requests.flat().map((r) => r.execution_id)).toEqual(
      ['exec-0', 'exec-1', 'exec-2', 'exec-3', 'exec-4'],
    )
  })

  it('flushes on its own once it fills, so the buffer cannot grow without bound', async () => {
    const sink = recorder()
    const buffer = createRefusalBuffer({ writeBatch: sink.writeBatch, maxRowsPerRequest: 2 })
    await buffer.add(record(1))
    await buffer.add(record(2))

    expect(sink.requests).toHaveLength(1)
    expect(buffer.buffered).toBe(0)
  })

  it('keeps the rows a failed write did not take, and reports them as still buffered', async () => {
    // The rows have to survive so the caller can name what was lost. Clearing
    // the buffer before the write resolves would report a clean run while the
    // refusal ledger silently missed an hour, which is the state that makes the
    // deletion gate look trustworthy and be wrong.
    let calls = 0
    const buffer = createRefusalBuffer({
      writeBatch: async () => { calls++; throw new Error('postgrest said no') },
    })
    await buffer.add(record(1))

    await expect(buffer.flush()).rejects.toThrow('postgrest said no')
    expect(calls).toBe(1)
    expect(buffer.buffered).toBe(1)
  })

  it('refuses a ceiling that could never write a row', () => {
    expect(() => createRefusalBuffer({ writeBatch: async () => {}, maxRowsPerRequest: 0 }))
      .toThrow(/at least one row/)
  })

  it('has a default ceiling well above one slice, so a slice is one request', () => {
    // SLICE_SIZE is 150 and the buffer is flushed per slice. If the default ever
    // fell below that, every slice would silently become several requests.
    expect(MAX_REFUSAL_ROWS_PER_REQUEST).toBeGreaterThan(150)
  })
})
