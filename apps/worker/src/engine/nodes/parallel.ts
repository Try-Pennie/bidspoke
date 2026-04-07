/**
 * Parallel node — PRD Section 5.2
 *
 * Execution modes:
 *   wait_for: 'all'   — Promise.allSettled(); waits for every child.
 *                        on_timeout: 'partial' → continue with settled results;
 *                        on_timeout: 'fail'    → throw if any child unsettled.
 *   wait_for: 'first' — Race; first successful child wins. All children run to
 *                        completion in the background (results discarded except winner).
 *                        Fails if all children reject OR timeout fires first.
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
  wait_for?: 'all' | 'first'
  timeout_ms?: number
  on_timeout?: 'partial' | 'fail'
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function executeParallelNode(
  node: NodeDefinition,
  childNodes: NodeDefinition[],
  runChild: (child: NodeDefinition, childIndex: number) => Promise<ParallelChildResult>
): Promise<StepExecutionResult> {
  if (childNodes.length === 0) {
    return { output: [] as ParallelOutput }
  }

  const config = node.config as unknown as ParallelConfig
  const waitFor = config.wait_for ?? 'all'
  const timeoutMs = config.timeout_ms ?? 15000
  const onTimeout = config.on_timeout ?? 'partial'

  const output: ParallelOutput =
    waitFor === 'first'
      ? await runFirst(childNodes, runChild, timeoutMs)
      : await runAll(childNodes, runChild, timeoutMs, onTimeout)

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
