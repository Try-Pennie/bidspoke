/**
 * Parallel node, PRD Section 5.2.
 * Tests: wait_for all/first, timeout partial/fail, child failure handling.
 *
 * On a fake clock (#2090): these raced real timers and asserted wall clock
 * spreads, so under full suite load they timed out or failed while passing
 * alone (L290, L524). Each test now advances time itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { continuingSlots, deadlineResultsOf, executeParallelNode, leftRunningMessage, leftRunningOf, limitInSeconds } from '../parallel'
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

  describe('slot handles that do not match the children (#3125)', () => {
    it('refuses before any child runs, rather than naming a neighbour or one past the end', async () => {
      const runChild = makeRunChild([fulfilled('a'), fulfilled('b')])
      const err = await executeParallelNode(makeNode({ wait_for: 'specific', wait_for_slot: 'child-2', timeout_ms: 50 }), [makeChild('a'), makeChild('b')], runChild, ['child-0', 'child-1', 'child-2'])
        .then(() => null, (e: unknown) => e)
      expect(String(err)).toMatch(/2 slot step\(s\) but 3 slot handle\(s\)/)
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

// #2832: a slot whose failure is recorded and alerted but does not fail the block.
describe('a slot marked on_failure: continue', () => {
  const marked = (extra: Record<string, unknown> = {}) => makeNode({
    wait_for: 'all', on_child_error: 'fail', timeout_ms: 5000, ...extra,
    children: [{ id: 'child-0', label: 'inquiry' }, { id: 'child-1', label: 'collections', on_failure: 'continue' }],
  })
  const slots = ['child-0', 'child-1']
  afterEach(() => vi.useRealTimers())

  it('a failure in the marked slot leaves the block completed, the rejection in its output', async () => {
    const runChild = makeRunChild([fulfilled('inquiry'), rejected('collections', 'Salesforce API error (500)')])
    const result = await executeParallelNode(marked(), [makeChild('inquiry'), makeChild('collections')], runChild, slots)
    expect((result.output as ParallelChildResult[]).map((c) => c.status)).toEqual(['fulfilled', 'rejected'])
  })

  it('a marked slot still running at the block timeout leaves the block completed too', async () => {
    vi.useFakeTimers()
    const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) =>
      child.namespace === 'collections' ? new Promise(() => {}) : fulfilled('inquiry'))
    const pending = executeParallelNode(marked({ on_timeout: 'partial' }), [makeChild('inquiry'), makeChild('collections')], runChild, slots)
    await vi.advanceTimersByTimeAsync(5000)
    expect(((await pending).output as ParallelChildResult[]).map((c) => c.status)).toEqual(['fulfilled', 'timeout'])
  })

  it('an unmarked slot failing still fails the block, whatever the marked one did', async () => {
    const runChild = makeRunChild([rejected('inquiry', 'Salesforce API error (500)'), fulfilled('collections')])
    await expect(executeParallelNode(marked(), [makeChild('inquiry'), makeChild('collections')], runChild, slots)).rejects.toThrow(/child "inquiry" failed/)
  })

  it('the mark is read from the slot it is on, not from a slot position', async () => {
    const runChild = makeRunChild([rejected('collections', 'boom'), fulfilled('inquiry')])
    const swapped = makeNode({ wait_for: 'all', on_child_error: 'fail', timeout_ms: 5000, children: [{ id: 'child-1', label: 'inquiry' }, { id: 'child-0', label: 'collections', on_failure: 'continue' }] })
    const result = await executeParallelNode(swapped, [makeChild('collections'), makeChild('inquiry')], runChild, ['child-0', 'child-1'])
    expect((result.output as ParallelChildResult[]).map((c) => c.status)).toEqual(['rejected', 'fulfilled'])
  })

  it('continuingSlots names exactly the marked slots', () => {
    expect([...continuingSlots(marked().config)]).toEqual(['child-1'])
    expect([...continuingSlots({ children: [{ id: 'child-0', on_failure: 'fail' }, { id: 'child-1' }] })]).toEqual([])
    expect([...continuingSlots({})]).toEqual([])
  })
})

describe('a block that fails on its own deadline says which slots it stopped waiting for (#3072)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const children = [makeChild('inquiry'), makeChild('collections'), makeChild('offers')]
  const slots = ['child-0', 'child-1', 'child-2']
  /** inquiry answers, collections fails, offers never answers. */
  const oneHangs = () => vi.fn().mockImplementation(async (child: NodeDefinition) => {
    if (child.namespace === 'offers') return new Promise(() => {})
    return child.namespace === 'collections' ? rejected('collections', 'Salesforce API error (500)') : fulfilled('inquiry')
  })

  async function failure(config: Record<string, unknown>, runChild: Parameters<typeof executeParallelNode>[2]): Promise<unknown> {
    const pending = executeParallelNode(makeNode({ timeout_ms: 50, ...config }), children, runChild, slots).then(() => null, (err: unknown) => err)
    await vi.advanceTimersByTimeAsync(50)
    const err = await pending
    if (err === null) throw new Error('the block did not fail')
    return err
  }

  it('wait_for all, on_timeout fail: every slot as the block left it, the one still running as timeout', async () => {
    const err = await failure({ wait_for: 'all', on_timeout: 'fail', on_child_error: 'continue' }, oneHangs())
    expect(String(err)).toMatch(/did not settle within 50ms/)
    expect(deadlineResultsOf(err)?.map((c) => [c.namespace, c.status])).toEqual([['inquiry', 'fulfilled'], ['collections', 'rejected'], ['offers', 'timeout']])
  })

  it('wait_for all, on_child_error fail, failing on the slot still running at the deadline', async () => {
    const answers = vi.fn().mockImplementation(async (child: NodeDefinition) =>
      child.namespace === 'offers' ? new Promise(() => {}) : fulfilled(child.namespace))
    const err = await failure({ wait_for: 'all', on_timeout: 'partial', on_child_error: 'fail' }, answers)
    expect(String(err)).toMatch(/child "offers" did not complete in time/)
    expect(deadlineResultsOf(err)?.map((c) => c.status)).toEqual(['fulfilled', 'fulfilled', 'timeout'])
  })

  it('wait_for all, on_child_error fail, failing on a slot that failed: not the deadline, so nothing is said', async () => {
    const err = await failure({ wait_for: 'all', on_timeout: 'partial', on_child_error: 'fail' }, oneHangs())
    expect(String(err)).toMatch(/child "collections" failed/)
    expect(deadlineResultsOf(err)).toBeNull()
  })

  it('wait_for specific, the named slot still running at the deadline', async () => {
    const err = await failure({ wait_for: 'specific', wait_for_slot: 'child-2' }, oneHangs())
    expect(String(err)).toMatch(/slot "offers" did not complete in time/)
    expect(deadlineResultsOf(err)?.map((c) => c.status)).toEqual(['fulfilled', 'rejected', 'timeout'])
  })

  it('wait_for specific, the named slot failed: not the deadline, so nothing is said', async () => {
    const err = await failure({ wait_for: 'specific', wait_for_slot: 'child-1' }, oneHangs())
    expect(String(err)).toMatch(/slot "collections" failed/)
    expect(deadlineResultsOf(err)).toBeNull()
  })

  it('wait_for first, no slot succeeded by the deadline', async () => {
    const noneWin = vi.fn().mockImplementation(async (child: NodeDefinition) =>
      child.namespace === 'offers' ? new Promise(() => {}) : rejected(child.namespace))
    const err = await failure({ wait_for: 'first' }, noneWin)
    expect(String(err)).toMatch(/no child succeeded within 50ms/)
    expect(deadlineResultsOf(err)?.map((c) => c.status)).toEqual(['rejected', 'rejected', 'timeout'])
  })

  it('wait_for first, every slot failed before the deadline: nothing is said', async () => {
    const all = makeRunChild([rejected('inquiry'), rejected('collections'), rejected('offers')])
    const err = await executeParallelNode(makeNode({ wait_for: 'first', timeout_ms: 50 }), children, all, slots).then(() => null, (e: unknown) => e)
    expect(String(err)).toMatch(/All parallel children failed/)
    expect(deadlineResultsOf(err)).toBeNull()
  })

  it('anything that is not a block failing on its deadline carries nothing', () => {
    expect(deadlineResultsOf(new Error('Parallel node timed out'))).toBeNull()
    expect(deadlineResultsOf(null)).toBeNull()
    expect(deadlineResultsOf('a string')).toBeNull()
  })
})

describe('a block that stops waiting for slots still running, for a reason other than a deadline it failed on, says which (#3083)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const children = [makeChild('inquiry'), makeChild('collections'), makeChild('offers')]
  const slots = ['child-0', 'child-1', 'child-2']
  const hangs = () => new Promise<ParallelChildResult>(() => {})

  async function settle<T>(pending: Promise<T>, ms = 50): Promise<T> {
    await vi.advanceTimersByTimeAsync(ms)
    return pending
  }

  it('wait_for first: the winner returned while the others still ran', async () => {
    const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) => child.namespace === 'inquiry' ? fulfilled('inquiry') : hangs())
    const result = await settle(executeParallelNode(makeNode({ wait_for: 'first', timeout_ms: 50 }), children, runChild, slots), 0)
    expect((result.output as ParallelChildResult[]).map((c) => c.namespace)).toEqual(['inquiry'])
    const left = leftRunningOf(result)
    expect(left?.results.map((c) => [c.namespace, c.status])).toEqual([['inquiry', 'fulfilled'], ['collections', 'timeout'], ['offers', 'timeout']])
    expect(left).toMatchObject({ decidedBy: 'inquiry', how: 'succeeded_first', afterTimeoutMs: null })
  })

  it('wait_for first: a winner with nothing still running says nothing', async () => {
    const all = makeRunChild([rejected('inquiry'), fulfilled('collections'), rejected('offers')])
    const result = await executeParallelNode(makeNode({ wait_for: 'first', timeout_ms: 50 }), children, all, slots)
    expect(leftRunningOf(result)).toBeNull()
  })

  it('wait_for all, on_child_error fail: failing on a refused slot while another still ran at the deadline', async () => {
    const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) =>
      child.namespace === 'offers' ? hangs() : child.namespace === 'collections' ? rejected('collections', 'Salesforce API error (500)') : fulfilled('inquiry'))
    const err = await settle(executeParallelNode(makeNode({ wait_for: 'all', on_timeout: 'partial', on_child_error: 'fail', timeout_ms: 50 }), children, runChild, slots).then(() => null, (e: unknown) => e))
    expect(String(err)).toMatch(/child "collections" failed/)
    // Not a deadline failure: the outage rule must not read it as one (#3072).
    expect(deadlineResultsOf(err)).toBeNull()
    const left = leftRunningOf(err)
    expect(left?.results.map((c) => c.status)).toEqual(['fulfilled', 'rejected', 'timeout'])
    expect(left).toMatchObject({ decidedBy: 'collections', how: 'failed', afterTimeoutMs: 50 })
  })

  it('wait_for specific: the named slot failed while a sibling still ran, before any deadline', async () => {
    const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) =>
      child.namespace === 'offers' ? hangs() : child.namespace === 'collections' ? rejected('collections', 'Salesforce API error (500)') : fulfilled('inquiry'))
    const err = await settle(executeParallelNode(makeNode({ wait_for: 'specific', wait_for_slot: 'child-1', timeout_ms: 50 }), children, runChild, slots).then(() => null, (e: unknown) => e), 0)
    expect(String(err)).toMatch(/slot "collections" failed/)
    expect(deadlineResultsOf(err)).toBeNull()
    const left = leftRunningOf(err)
    expect(left?.results.map((c) => c.status)).toEqual(['fulfilled', 'rejected', 'timeout'])
    expect(left).toMatchObject({ decidedBy: 'collections', how: 'failed', afterTimeoutMs: null })
  })

  it('wait_for specific: the named slot succeeded while a sibling still ran, before any deadline (#3119)', async () => {
    const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) =>
      child.namespace === 'offers' ? hangs() : fulfilled(child.namespace))
    const result = await settle(executeParallelNode(makeNode({ wait_for: 'specific', wait_for_slot: 'child-1', timeout_ms: 50 }), children, runChild, slots), 0)
    // The output is as it was: the sibling still running shows as timeout.
    expect((result.output as ParallelChildResult[]).map((c) => [c.namespace, c.status])).toEqual([['inquiry', 'fulfilled'], ['collections', 'fulfilled'], ['offers', 'timeout']])
    const left = leftRunningOf(result)
    expect(left?.results.map((c) => c.status)).toEqual(['fulfilled', 'fulfilled', 'timeout'])
    // No deadline passed, so it is not the block's timeout that left it.
    expect(left).toMatchObject({ decidedBy: 'collections', how: 'succeeded', afterTimeoutMs: null })
  })

  it('wait_for specific: a named slot that succeeded with nothing still running says nothing', async () => {
    const all = makeRunChild([fulfilled('inquiry'), fulfilled('collections'), rejected('offers')])
    const result = await executeParallelNode(makeNode({ wait_for: 'specific', wait_for_slot: 'child-1', timeout_ms: 50 }), children, all, slots)
    expect(leftRunningOf(result)).toBeNull()
  })

  it('a block its own deadline failed says it only through deadlineResultsOf', async () => {
    const runChild = vi.fn().mockImplementation(async (child: NodeDefinition) => child.namespace === 'offers' ? hangs() : fulfilled(child.namespace))
    const err = await settle(executeParallelNode(makeNode({ wait_for: 'all', on_timeout: 'fail', timeout_ms: 50 }), children, runChild, slots).then(() => null, (e: unknown) => e))
    expect(deadlineResultsOf(err)).not.toBeNull()
    expect(leftRunningOf(err)).toBeNull()
  })

  it('a failure with no slot still running says nothing', async () => {
    const all = makeRunChild([fulfilled('inquiry'), rejected('collections'), fulfilled('offers')])
    const err = await executeParallelNode(makeNode({ wait_for: 'all', on_child_error: 'fail', timeout_ms: 50 }), children, all, slots).then(() => null, (e: unknown) => e)
    expect(String(err)).toMatch(/child "collections" failed/)
    expect(leftRunningOf(err)).toBeNull()
    expect(leftRunningOf(null)).toBeNull()
    expect(leftRunningOf('a string')).toBeNull()
  })
})

describe('what the row of a slot left running says (#3083, wording Dan chose)', () => {
  const results: ParallelChildResult[] = [fulfilled('inquiry'), { namespace: 'offers', status: 'timeout' }]

  it('a winner returned first', () => {
    expect(leftRunningMessage({ results, decidedBy: 'inquiry', how: 'succeeded_first', afterTimeoutMs: null })).toBe('Stopped waiting: branch inquiry finished first.')
  })

  it('the named slot failed', () => {
    expect(leftRunningMessage({ results, decidedBy: 'collections', how: 'failed', afterTimeoutMs: null })).toBe('Stopped waiting: branch collections failed.')
  })

  it('the named slot succeeded (#3119)', () => {
    expect(leftRunningMessage({ results, decidedBy: 'collections', how: 'succeeded', afterTimeoutMs: null })).toBe('Stopped waiting: branch collections finished.')
  })

  it('the block failed on another slot after its timeout, the limit in seconds', () => {
    expect(leftRunningMessage({ results, decidedBy: 'collections', how: 'failed', afterTimeoutMs: 20000 })).toBe('Stopped waiting at the 20 second limit, then branch collections failed.')
    expect(leftRunningMessage({ results, decidedBy: 'collections', how: 'failed', afterTimeoutMs: 1500 })).toBe('Stopped waiting at the 1.5 second limit, then branch collections failed.')
    // Rounded to a whole number, written whole (#3119).
    expect(leftRunningMessage({ results, decidedBy: 'collections', how: 'failed', afterTimeoutMs: 1999 })).toBe('Stopped waiting at the 2 second limit, then branch collections failed.')
  })

  it('a timeout under 0.1 second, which no figure in seconds says well, is called the block\'s time limit (#3119)', () => {
    expect(leftRunningMessage({ results, decidedBy: 'collections', how: 'failed', afterTimeoutMs: 5 })).toBe('Stopped waiting at the block\'s time limit, then branch collections failed.')
    expect(leftRunningMessage({ results, decidedBy: 'collections', how: 'failed', afterTimeoutMs: 99 })).toBe('Stopped waiting at the block\'s time limit, then branch collections failed.')
    expect(leftRunningMessage({ results, decidedBy: 'collections', how: 'failed', afterTimeoutMs: 100 })).toBe('Stopped waiting at the 0.1 second limit, then branch collections failed.')
  })
})

describe('limitInSeconds: a block timeout in seconds', () => {
  it('a whole number of seconds is written whole', () => {
    expect(limitInSeconds(20000)).toBe('20')
    expect(limitInSeconds(15000)).toBe('15')
    expect(limitInSeconds(1000)).toBe('1')
  })

  it('anything else is written with one decimal', () => {
    expect(limitInSeconds(1500)).toBe('1.5')
    expect(limitInSeconds(2250)).toBe('2.3')
    expect(limitInSeconds(100)).toBe('0.1')
  })

  it('a decimal that rounds to a whole number is written whole, never with a trailing .0 (#3119)', () => {
    expect(limitInSeconds(1999)).toBe('2')
    expect(limitInSeconds(999)).toBe('1')
    expect(limitInSeconds(20040)).toBe('20')
  })

  it('under 0.1 second there is no figure to write (#3119)', () => {
    expect(limitInSeconds(5)).toBeNull()
    expect(limitInSeconds(0)).toBeNull()
    expect(limitInSeconds(99)).toBeNull()
  })
})
