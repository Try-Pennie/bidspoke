/**
 * Parallel node — PRD Section 5.2
 *
 * Execution modes:
 *   wait_for: 'all'      — Promise.allSettled(); waits for every child.
 *                          on_timeout: 'partial' → continue with settled results;
 *                          on_timeout: 'fail'    → throw if any child unsettled.
 *   wait_for: 'first'    — Race; first successful child wins. All children run to
 *                          completion in the background (results discarded except winner).
 *                          Fails if all children reject OR timeout fires first.
 *   wait_for: 'specific' — Wait for a named slot (config.wait_for_slot). Other
 *                          slots keep running in the background but are not
 *                          awaited; their results show as 'timeout' in the
 *                          output if not yet settled. The named slot's status
 *                          drives the parallel's success — failure throws.
 *
 * Output: ParallelOutput — array of child results consumed by BidEvaluation node.
 */
import type { NodeDefinition, StepExecutionResult } from '../../types'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParallelChildResult {
  namespace: string
  status: 'fulfilled' | 'rejected' | 'timeout'
  output?: unknown   // present when fulfilled
  error?: string     // present when rejected
}

export type ParallelOutput = ParallelChildResult[]

interface ParallelConfig {
  wait_for?: 'all' | 'first' | 'specific'
  // Slot handle id (e.g. 'child-0') to wait for when wait_for='specific'.
  wait_for_slot?: string
  timeout_ms?: number
  on_timeout?: 'partial' | 'fail'
  // Default 'fail' — if any child rejects, the parallel step fails and the
  // workflow stops. Set to 'continue' when the downstream step (e.g. a Bid
  // Evaluation node) handles rejections in the result array itself.
  on_child_error?: 'fail' | 'continue'
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function executeParallelNode(
  node: NodeDefinition,
  childNodes: NodeDefinition[],
  runChild: (child: NodeDefinition, childIndex: number) => Promise<ParallelChildResult>,
  slotHandleIds: string[] = []
): Promise<StepExecutionResult> {
  if (childNodes.length === 0) {
    return { output: [] as ParallelOutput }
  }

  const config = node.config as unknown as ParallelConfig
  const waitFor = config.wait_for ?? 'all'
  const timeoutMs = config.timeout_ms ?? 15000
  const onTimeout = config.on_timeout ?? 'partial'
  const onChildError = config.on_child_error ?? 'fail'

  if (waitFor === 'specific') {
    const targetIdx = slotHandleIds.indexOf(config.wait_for_slot ?? '')
    if (targetIdx < 0) {
      throw new Error(`Parallel "specific" wait references slot "${config.wait_for_slot}" which is not connected`)
    }
    const output = await runSpecific(childNodes, runChild, timeoutMs, targetIdx)
    const named = output[targetIdx]
    if (named && (named.status === 'rejected' || named.status === 'timeout')) {
      const reason = named.status === 'timeout'
        ? `slot "${named.namespace}" did not complete in time`
        : `slot "${named.namespace}" failed: ${named.error ?? 'unknown error'}`
      throw new Error(`Parallel failed — ${reason}`)
    }
    return { output }
  }

  const output: ParallelOutput =
    waitFor === 'first'
      ? await runFirst(childNodes, runChild, timeoutMs)
      : await runAll(childNodes, runChild, timeoutMs, onTimeout)

  // wait_for:'all' with on_child_error:'fail' — bail if any child failed
  if (waitFor === 'all' && onChildError === 'fail') {
    const failed = output.find((c) => c.status === 'rejected' || c.status === 'timeout')
    if (failed) {
      const reason = failed.status === 'timeout'
        ? `child "${failed.namespace}" did not complete in time`
        : `child "${failed.namespace}" failed: ${failed.error ?? 'unknown error'}`
      throw new Error(`Parallel failed — ${reason}`)
    }
  }

  return { output }
}

// ── wait_for: 'all' ───────────────────────────────────────────────────────────

async function runAll(
  childNodes: NodeDefinition[],
  runChild: (child: NodeDefinition, i: number) => Promise<ParallelChildResult>,
  timeoutMs: number,
  onTimeout: 'partial' | 'fail'
): Promise<ParallelOutput> {
  // Track settled results as children complete
  const settled: Array<ParallelChildResult | null> = childNodes.map(() => null)

  const childPromises = childNodes.map(async (child, i) => {
    const result = await runChild(child, i)
    settled[i] = result
  })

  const allDone = Promise.allSettled(childPromises)
  const timedOut = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), timeoutMs)
  )

  const winner = await Promise.race([allDone.then(() => 'done' as const), timedOut])

  if (winner === 'timeout') {
    const unsettled = settled.filter((r) => r === null).length
    if (onTimeout === 'fail') {
      throw new Error(`Parallel node timed out — ${unsettled} child(ren) did not settle within ${timeoutMs}ms`)
    }
    // 'partial': continue with whatever settled, mark the rest as timeout
    return childNodes.map((child, i) =>
      settled[i] ?? ({ namespace: child.namespace, status: 'timeout' } as ParallelChildResult)
    )
  }

  // All children settled within the timeout
  return settled as ParallelChildResult[]
}

// ── wait_for: 'specific' ──────────────────────────────────────────────────────

async function runSpecific(
  childNodes: NodeDefinition[],
  runChild: (child: NodeDefinition, i: number) => Promise<ParallelChildResult>,
  timeoutMs: number,
  targetIdx: number
): Promise<ParallelOutput> {
  const settled: Array<ParallelChildResult | null> = childNodes.map(() => null)

  // Kick off every child concurrently. Siblings keep running in the background;
  // we just don't await them.
  let resolveTarget: (r: ParallelChildResult) => void
  const targetSettled = new Promise<ParallelChildResult>((res) => { resolveTarget = res })
  childNodes.forEach((child, i) => {
    runChild(child, i).then((result) => {
      settled[i] = result
      if (i === targetIdx) resolveTarget(result)
    }).catch((err) => {
      const result: ParallelChildResult = { namespace: child.namespace, status: 'rejected', error: err instanceof Error ? err.message : String(err) }
      settled[i] = result
      if (i === targetIdx) resolveTarget(result)
    })
  })

  const timedOut = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), timeoutMs)
  )

  const winner = await Promise.race([targetSettled.then(() => 'done' as const), timedOut])

  if (winner === 'timeout') {
    // Mark the target as timeout if it didn't settle; siblings reflect their
    // current state.
    const targetChild = childNodes[targetIdx]
    settled[targetIdx] = settled[targetIdx] ?? { namespace: targetChild.namespace, status: 'timeout' }
  }

  return childNodes.map((child, i) =>
    settled[i] ?? ({ namespace: child.namespace, status: 'timeout' } as ParallelChildResult)
  )
}

// ── wait_for: 'first' ─────────────────────────────────────────────────────────

async function runFirst(
  childNodes: NodeDefinition[],
  runChild: (child: NodeDefinition, i: number) => Promise<ParallelChildResult>,
  timeoutMs: number
): Promise<ParallelOutput> {
  // Each child is started; Promise.any resolves with the first fulfilled (status='fulfilled') result.
  // Rejected / timeout children are logged by runChild internally and discarded here.
  const racePromises = childNodes.map(async (child, i) => {
    const result = await runChild(child, i)
    if (result.status === 'rejected') {
      // Rethrow so Promise.any sees it as a rejection
      throw Object.assign(new Error(result.error ?? 'child rejected'), { childResult: result })
    }
    return result
  })

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(Object.assign(new Error('__parallel_timeout__'), { isParallelTimeout: true })),
      timeoutMs
    )
  )

  try {
    const winner = await Promise.race([Promise.any(racePromises), timeoutPromise])
    return [winner]
  } catch (err) {
    if (err instanceof Error && (err as { isParallelTimeout?: boolean }).isParallelTimeout) {
      throw new Error(`Parallel node timed out — no child succeeded within ${timeoutMs}ms`)
    }
    // AggregateError from Promise.any — all children rejected
    throw new Error('All parallel children failed — no successful result')
  }
}
