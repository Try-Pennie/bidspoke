import { describe, it, expect } from 'vitest'
import { batchByBytes, MAX_BATCH_BYTES, MAX_BUNDLE_BYTES } from '../batching'

const sized = (id: string, wireBytes: number): { executionId: string; wireBytes: number } => ({
  executionId: id,
  wireBytes,
})

describe('batchByBytes', () => {
  it('fills a batch up to the byte budget and starts a new one', () => {
    const half = Math.floor(MAX_BATCH_BYTES / 2)
    const result = batchByBytes([
      sized('a', half),
      sized('b', half),
      sized('c', half),
    ])

    expect(result.oversized).toEqual([])
    expect(result.batches).toHaveLength(2)
    expect(result.batches[0].map((i) => i.executionId)).toEqual(['a', 'b'])
    expect(result.batches[1].map((i) => i.executionId)).toEqual(['c'])
  })

  // The inherited BATCH_SIZE of 200 is a row count, and rows here vary by three
  // orders of magnitude (11.3 kB p50, 48.7 kB p99, 3.16 MB max raw). A fixed row
  // count either wastes most of a batch or blows past the budget on one bad hour.
  it('batches by bytes rather than by a row count', () => {
    const tiny = Array.from({ length: 500 }, (_, i) => sized(`t${i}`, 1_000))
    const result = batchByBytes(tiny)

    expect(result.batches.length).toBeLessThan(500)
    for (const batch of result.batches) {
      const total = batch.reduce((n, i) => n + i.wireBytes, 0)
      expect(total).toBeLessThanOrEqual(MAX_BATCH_BYTES)
    }
  })

  it('never puts an item in a batch that would exceed the budget', () => {
    // Both are legal bundles on their own, and together they cross the budget by
    // exactly one byte, which is the boundary the loop has to get right.
    const first = MAX_BUNDLE_BYTES
    const second = MAX_BATCH_BYTES - MAX_BUNDLE_BYTES + 1
    const result = batchByBytes([sized('a', first), sized('b', second)])

    expect(result.oversized).toEqual([])
    expect(result.batches).toHaveLength(2)
    expect(result.batches[0].map((i) => i.executionId)).toEqual(['a'])
    expect(result.batches[1].map((i) => i.executionId)).toEqual(['b'])
  })

  it('fits two items that together land exactly on the budget', () => {
    const first = MAX_BUNDLE_BYTES
    const second = MAX_BATCH_BYTES - MAX_BUNDLE_BYTES
    const result = batchByBytes([sized('a', first), sized('b', second)])

    expect(result.batches).toHaveLength(1)
    expect(result.batches[0].map((i) => i.executionId)).toEqual(['a', 'b'])
  })

  // The ceiling is a refusal, so it must be exclusive: a bundle exactly at the
  // limit is legal, and only one byte past it is refused.
  it('allows a bundle exactly at the per-bundle ceiling', () => {
    const result = batchByBytes([sized('exact', MAX_BUNDLE_BYTES)])

    expect(result.oversized).toEqual([])
    expect(result.batches.flat().map((i) => i.executionId)).toEqual(['exact'])
  })

  // A single runaway execution is a real signal, not a batching problem: refusing
  // it by id keeps the rest of the hour moving, where letting it through would
  // consume the whole run's headroom for one row.
  it('separates a single bundle that is over the per-bundle ceiling', () => {
    const result = batchByBytes([
      sized('ok', 1_000),
      sized('runaway', MAX_BUNDLE_BYTES + 1),
      sized('also-ok', 1_000),
    ])

    expect(result.oversized).toEqual(['runaway'])
    expect(result.batches.flat().map((i) => i.executionId)).toEqual(['ok', 'also-ok'])
  })

  it('reports an empty input as no batches rather than one empty batch', () => {
    const result = batchByBytes([])

    expect(result.batches).toEqual([])
    expect(result.oversized).toEqual([])
  })

  it('keeps the per-bundle ceiling well above the largest bundle actually observed', () => {
    // Measured in A0 (ADR 0009): raw JSON p99 503,811 B, max observed 3.16 MB,
    // and compression is 4x at p50, so the wire form of the largest observed
    // execution is comfortably inside this.
    expect(MAX_BUNDLE_BYTES).toBeGreaterThan(3_160_000)
  })

  it('keeps the batch budget inside the isolate, with room for the JSON it was built from', () => {
    // A 128 MB isolate holds the step rows, the assembled JSON before
    // compression and the wire strings at once, so the batch budget is a small
    // fraction of the isolate rather than most of it.
    expect(MAX_BATCH_BYTES).toBeLessThan(16 * 1024 * 1024)
    expect(MAX_BATCH_BYTES).toBeGreaterThan(MAX_BUNDLE_BYTES)
  })
})
