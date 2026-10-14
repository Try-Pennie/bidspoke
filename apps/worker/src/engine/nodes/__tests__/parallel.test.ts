/**
 * Parallel node, PRD Section 5.2.
 * Tests: wait_for all/first, timeout partial/fail, child failure handling.
 *
 * On a fake clock (#2090): these raced real timers and asserted wall clock
 * spreads, so under full suite load they timed out or failed while passing
 * alone (L290, L524). Each test now advances time itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

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

    it('includes rejected children alongside fulfilled ones when on_child_error is continue', async () => {
      const children = [makeChild('bid_a'), makeChild('bid_b'), makeChild('bid_c')]
      const runChild = makeRunChild([
        fulfilled('bid_a'),
        rejected('bid_b', 'circuit open'),
        fulfilled('bid_c', { bid: 500 }),
      ])

      const result = await executeParallelNode(
        makeNode({ wait_for: 'all', timeout_ms: 5000, on_child_error: 'continue' }),
        children,
        runChild
      )
      const output = result.output as ParallelChildResult[]

      expect(output).toHaveLength(3)
      expect(output[0].status).toBe('fulfilled')
      expect(output[1].status).toBe('rejected')
      expect(output[1].error).toBe('circuit open')
      expect(output[2].status).toBe('fulfilled')
    })

    it('throws when any child rejects and on_child_error is fail (default)', async () => {
      const children = [makeChild('bid_a'), makeChild('bid_b')]
      const runChild = makeRunChild([
        fulfilled('bid_a'),
        rejected('bid_b', 'circuit open'),
      ])

      await expect(
        executeParallelNode(makeNode({ wait_for: 'all', timeout_ms: 5000 }), children, runChild)
      ).rejects.toThrow(/Parallel failed.*bid_b.*circuit open/)
    })

    it('runs children concurrently (all start before any finish)', async () => {
      const children = [makeChild('bid_a'), makeChild('bid_b'), makeChild('bid_c')]
      const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) => {
        await new Promise((r) => setTimeout(r, 20))
        return fulfilled(child.namespace)
      })

      const done = executeParallelNode(makeNode({ wait_for: 'all', timeout_ms: 5000 }), children, runChild)
      // Every child has started while no time has passed: none waited on another.
      await vi.advanceTimersByTimeAsync(0)
      expect(runChild).toHaveBeenCalledTimes(3)
      // One child's 20 ms is enough for all three, which is what running together means.
      await vi.advanceTimersByTimeAsync(20)
      expect((await done).output).toHaveLength(3)
    })

    describe('on_timeout', () => {
      it('marks unsettled children as timeout and continues when on_timeout is partial', async () => {
        const children = [makeChild('bid_fast'), makeChild('bid_slow')]
        const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) => {
          if (child.namespace === 'bid_slow') await new Promise((r) => setTimeout(r, 200))
          return fulfilled(child.namespace)
        })

        const pending = executeParallelNode(
          makeNode({ wait_for: 'all', timeout_ms: 50, on_timeout: 'partial', on_child_error: 'continue' }),
          children,
          runChild
        )
        await vi.advanceTimersByTimeAsync(50)
        const output = (await pending).output as ParallelChildResult[]

        expect(output).toHaveLength(2)
        expect(output[0].status).toBe('fulfilled')
        expect(output[1].status).toBe('timeout')
      })

      // #63: a straggler that settles AFTER the group timed out must see the
      // abandon signal aborted, which is what tells runParallelChild to skip
      // recording (so it can't double-log / overwrite ctx.steps).
      it('aborts the abandon signal for a straggler that settles after the timeout', async () => {
        let lateSignalAborted: boolean | undefined
        const runChild = vi.fn().mockImplementation(
          async (_child: NodeDefinition, i: number, signal: AbortSignal) => {
            if (i === 0) return fulfilled('bid_fast')
            await new Promise((r) => setTimeout(r, 40)) // settles long after the 10ms timeout
            lateSignalAborted = signal.aborted
            return fulfilled('bid_slow')
          }
        )
        const pending = executeParallelNode(
          makeNode({ wait_for: 'all', timeout_ms: 10, on_timeout: 'partial', on_child_error: 'continue' }),
          [makeChild('bid_fast'), makeChild('bid_slow')],
          runChild
        )
        await vi.advanceTimersByTimeAsync(10)
        const out = await pending
        expect((out.output as ParallelChildResult[]).find((c) => c.namespace === 'bid_slow')?.status).toBe('timeout')
        await vi.advanceTimersByTimeAsync(30) // the straggler settles at 40 ms
        expect(lateSignalAborted).toBe(true)
      })

      it('throws when on_timeout is fail and a child does not settle', async () => {
        const children = [makeChild('bid_fast'), makeChild('bid_slow')]
        const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) => {
          if (child.namespace === 'bid_slow') await new Promise((r) => setTimeout(r, 200))
          return fulfilled(child.namespace)
        })

        const pending = executeParallelNode(
          makeNode({ wait_for: 'all', timeout_ms: 50, on_timeout: 'fail' }),
          children,
          runChild
        )
        const verdict = expect(pending).rejects.toThrow(/timed out/)
        await vi.advanceTimersByTimeAsync(50)
        await verdict
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

      const pending = executeParallelNode(
        makeNode({ wait_for: 'first', timeout_ms: 5000 }),
        children,
        runChild
      )
      await vi.advanceTimersByTimeAsync(10)
      const output = (await pending).output as ParallelChildResult[]

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

      const pending = executeParallelNode(makeNode({ wait_for: 'first', timeout_ms: 30 }), children, runChild)
      const verdict = expect(pending).rejects.toThrow(/timed out/i)
      await vi.advanceTimersByTimeAsync(30)
      await verdict
    })
  })
})
