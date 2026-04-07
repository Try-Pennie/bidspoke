/**
 * Parallel node — PRD Section 5.2
 * Tests: wait_for all/first, timeout partial/fail, child failure handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeParallelNode } from '../parallel'
import type { ParallelChildResult } from '../parallel'
import type { NodeDefinition } from '../../../types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(config: Record<string, unknown> = {}): NodeDefinition {
  return { id: 'parallel_1', namespace: 'bids', type: 'parallel', config }
}

function makeChild(namespace: string): NodeDefinition {
  return { id: namespace, namespace, type: 'partner_bid', config: {} }
}

function fulfilled(namespace: string, output: unknown = { bid: 1000 }): ParallelChildResult {
  return { namespace, status: 'fulfilled', output }
}

function rejected(namespace: string, error = 'failed'): ParallelChildResult {
  return { namespace, status: 'rejected', error }
}

// Build a runChild mock that returns results in order
function makeRunChild(results: ParallelChildResult[], delayMs: number[] = []) {
  return vi.fn().mockImplementation(async (child: NodeDefinition, i: number) => {
    if (delayMs[i]) await new Promise((r) => setTimeout(r, delayMs[i]))
    return results[i] ?? rejected(child.namespace)
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeParallelNode', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('empty children', () => {
    it('returns empty array when no children are configured', async () => {
      const runChild = vi.fn()
      const result = await executeParallelNode(makeNode(), [], runChild)
      expect(result.output).toEqual([])
      expect(runChild).not.toHaveBeenCalled()
    })
  })

  describe('wait_for: all (default)', () => {
    it('returns all results when every child succeeds', async () => {
      const children = [makeChild('bid_a'), makeChild('bid_b')]
      const runChild = makeRunChild([fulfilled('bid_a'), fulfilled('bid_b')])

      const result = await executeParallelNode(makeNode({ wait_for: 'all', timeout_ms: 5000 }), children, runChild)
      const output = result.output as ParallelChildResult[]

      expect(output).toHaveLength(2)
      expect(output[0].status).toBe('fulfilled')
      expect(output[1].status).toBe('fulfilled')
      expect(runChild).toHaveBeenCalledTimes(2)
    })

    it('includes rejected children alongside fulfilled ones', async () => {
      const children = [makeChild('bid_a'), makeChild('bid_b'), makeChild('bid_c')]
      const runChild = makeRunChild([
        fulfilled('bid_a'),
        rejected('bid_b', 'circuit open'),
        fulfilled('bid_c', { bid: 500 }),
      ])

      const result = await executeParallelNode(makeNode({ wait_for: 'all', timeout_ms: 5000 }), children, runChild)
      const output = result.output as ParallelChildResult[]

      expect(output).toHaveLength(3)
      expect(output[0].status).toBe('fulfilled')
      expect(output[1].status).toBe('rejected')
      expect(output[1].error).toBe('circuit open')
      expect(output[2].status).toBe('fulfilled')
    })

    it('runs children concurrently (all start before any finish)', async () => {
      const startTimes: number[] = []
      const children = [makeChild('bid_a'), makeChild('bid_b'), makeChild('bid_c')]

      const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) => {
        startTimes.push(Date.now())
        await new Promise((r) => setTimeout(r, 20))
        return fulfilled(child.namespace)
      })

      const before = Date.now()
      await executeParallelNode(makeNode({ wait_for: 'all', timeout_ms: 5000 }), children, runChild)
      const elapsed = Date.now() - before

      // All 3 children at 20ms each sequentially = 60ms; parallel = ~20ms
      expect(elapsed).toBeLessThan(50)
      // All 3 started within a short window of each other (not sequentially)
      const spread = Math.max(...startTimes) - Math.min(...startTimes)
      expect(spread).toBeLessThan(15)
    })

    describe('on_timeout', () => {
      it('marks unsettled children as timeout and continues when on_timeout is partial', async () => {
        const children = [makeChild('bid_fast'), makeChild('bid_slow')]
        const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) => {
          if (child.namespace === 'bid_slow') await new Promise((r) => setTimeout(r, 200))
          return fulfilled(child.namespace)
        })

        const result = await executeParallelNode(
          makeNode({ wait_for: 'all', timeout_ms: 50, on_timeout: 'partial' }),
          children,
          runChild
        )
        const output = result.output as ParallelChildResult[]

        expect(output).toHaveLength(2)
        expect(output[0].status).toBe('fulfilled')
        expect(output[1].status).toBe('timeout')
      })

      it('throws when on_timeout is fail and a child does not settle', async () => {
        const children = [makeChild('bid_fast'), makeChild('bid_slow')]
        const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) => {
          if (child.namespace === 'bid_slow') await new Promise((r) => setTimeout(r, 200))
          return fulfilled(child.namespace)
        })

        await expect(
          executeParallelNode(
            makeNode({ wait_for: 'all', timeout_ms: 50, on_timeout: 'fail' }),
            children,
            runChild
          )
        ).rejects.toThrow(/timed out/)
      })
    })
  })

  describe('wait_for: first', () => {
    it('returns the first successful child and discards others', async () => {
      const children = [makeChild('bid_a'), makeChild('bid_b'), makeChild('bid_c')]
      // bid_b responds first (10ms), others take longer
      const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) => {
        const delays: Record<string, number> = { bid_a: 40, bid_b: 10, bid_c: 40 }
        await new Promise((r) => setTimeout(r, delays[child.namespace] ?? 10))
        return fulfilled(child.namespace)
      })

      const result = await executeParallelNode(
        makeNode({ wait_for: 'first', timeout_ms: 5000 }),
        children,
        runChild
      )
      const output = result.output as ParallelChildResult[]

      expect(output).toHaveLength(1)
      expect(output[0].namespace).toBe('bid_b')
      expect(output[0].status).toBe('fulfilled')
    })

    it('moves to the next successful child when the first one rejects', async () => {
      const children = [makeChild('bid_a'), makeChild('bid_b')]
      const runChild = makeRunChild([rejected('bid_a', 'cap exceeded'), fulfilled('bid_b')])

      const result = await executeParallelNode(
        makeNode({ wait_for: 'first', timeout_ms: 5000 }),
        children,
        runChild
      )
      const output = result.output as ParallelChildResult[]

      expect(output[0].namespace).toBe('bid_b')
      expect(output[0].status).toBe('fulfilled')
    })

    it('throws when all children reject', async () => {
      const children = [makeChild('bid_a'), makeChild('bid_b')]
      const runChild = makeRunChild([rejected('bid_a'), rejected('bid_b')])

      await expect(
        executeParallelNode(makeNode({ wait_for: 'first', timeout_ms: 5000 }), children, runChild)
      ).rejects.toThrow(/all parallel children failed/i)
    })

    it('throws when timeout fires before any child succeeds', async () => {
      const children = [makeChild('bid_slow')]
      const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) => {
        await new Promise((r) => setTimeout(r, 200))
        return fulfilled(child.namespace)
      })

      await expect(
        executeParallelNode(makeNode({ wait_for: 'first', timeout_ms: 30 }), children, runChild)
      ).rejects.toThrow(/timed out/i)
    })
  })
})
