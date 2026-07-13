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
 * Output: ParallelOutput — array of child results consumed downstream.
 */
import type { ErrorType, NodeDefinition, StepExecutionResult } from '../../types'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParallelChildResult {
  namespace: string
  status: 'fulfilled' | 'rejected' | 'timeout'
  output?: unknown   // present when fulfilled
  error?: string     // present when rejected
  // Present when rejected (#486). The child already classified its own failure,
  // authoritatively so for a PartnerApiError, whose type comes from the
  // partner's response_classification config. Without carrying it up, the parent
  // could only re-derive a type from the wrapper Error below, which always came
  // out 'transient', so a partner's business rejection (or a failure it asked us
  // not to page on) paged anyway, and the recorded type was a lie.
  errorType?: ErrorType
  suppressAlert?: boolean
}

// Attached to the Error a failed group throws, when the failure is attributable
// to specific rejected children. Absent for a timeout or a structural failure,
// which are operational no matter what the children said.
export interface ParallelFailureCause {
  errorType: ErrorType
  suppressAlert: boolean
}

// The classification the parent should record for a group failure, derived from
// the children that actually rejected. The rule: the group inherits the child's
// verdict only when every rejected child agrees. One partner declining a lead is
// a business rejection (silent, as it is in the main loop); a partner declining
// while another child hard-fails is an operational failure and must page. A
// timed-out child never yields a verdict, so it always falls back to operational
// (this is what keeps #64 fixed).
export function classifyParallelFailure(children: ParallelChildResult[]): ParallelFailureCause | null {
  if (children.some((c) => c.status === 'timeout')) return null

  const rejected = children.filter((c) => c.status === 'rejected')
  if (rejected.length === 0) return null

  const [first, ...rest] = rejected
  if (first.errorType === undefined) return null
  if (!rest.every((c) => c.errorType === first.errorType)) return null

  return {
    errorType: first.errorType,
    suppressAlert: rejected.every((c) => c.suppressAlert === true),
  }
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
  runChild: (child: NodeDefinition, childIndex: number, abandonSignal: AbortSignal) => Promise<ParallelChildResult>,
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

  // Tripped the moment this node stops waiting (timeout / first-winner /
  // specific-target). Children that keep running in the background see it and
  // must NOT log a second step row or overwrite ctx.steps after we've moved on
  // (#63). Aborted in finally so it fires on every exit path, including throws.
  const abandon = new AbortController()
  try {
    if (waitFor === 'specific') {
      const targetIdx = slotHandleIds.indexOf(config.wait_for_slot ?? '')
      if (targetIdx < 0) {
        throw new Error(`Parallel "specific" wait references slot "${config.wait_for_slot}" which is not connected`)
      }
      const output = await runSpecific(childNodes, runChild, timeoutMs, targetIdx, abandon.signal)
      const named = output[targetIdx]
      if (named && (named.status === 'rejected' || named.status === 'timeout')) {
        const reason = named.status === 'timeout'
          ? `slot "${named.namespace}" did not complete in time`
          : `slot "${named.namespace}" failed: ${named.error ?? 'unknown error'}`
        // Only the named slot decides this group's fate, so only it is consulted.
        throw withFailureCause(new Error(`Parallel failed: ${reason}`), classifyParallelFailure([named]))
      }
      return { output }
    }

    const output: ParallelOutput =
      waitFor === 'first'
        ? await runFirst(childNodes, runChild, timeoutMs, abandon.signal)
        : await runAll(childNodes, runChild, timeoutMs, onTimeout, abandon.signal)

    // wait_for:'all' with on_child_error:'fail' — bail if any child failed
    if (waitFor === 'all' && onChildError === 'fail') {
      const failed = output.find((c) => c.status === 'rejected' || c.status === 'timeout')
      if (failed) {
        const reason = failed.status === 'timeout'
          ? `child "${failed.namespace}" did not complete in time`
          : `child "${failed.namespace}" failed: ${failed.error ?? 'unknown error'}`
        // Every child ran, so every failure is consulted: the group is only a
        // business rejection if all of them were.
        throw withFailureCause(new Error(`Parallel failed: ${reason}`), classifyParallelFailure(output))
      }
    }

    return { output }
  } finally {
    abandon.abort()
  }
}

// ── wait_for: 'all' ───────────────────────────────────────────────────────────

async function runAll(
  childNodes: NodeDefinition[],
  runChild: (child: NodeDefinition, i: number, abandonSignal: AbortSignal) => Promise<ParallelChildResult>,
  timeoutMs: number,
  onTimeout: 'partial' | 'fail',
  abandonSignal: AbortSignal
): Promise<ParallelOutput> {
  // Track settled results as children complete
  const settled: Array<ParallelChildResult | null> = childNodes.map(() => null)

  const childPromises = childNodes.map(async (child, i) => {
    const result = await runChild(child, i, abandonSignal)
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
  runChild: (child: NodeDefinition, i: number, abandonSignal: AbortSignal) => Promise<ParallelChildResult>,
  timeoutMs: number,
  targetIdx: number,
  abandonSignal: AbortSignal
): Promise<ParallelOutput> {
  const settled: Array<ParallelChildResult | null> = childNodes.map(() => null)

  // Kick off every child concurrently. Siblings keep running in the background;
  // we just don't await them.
  let resolveTarget: (r: ParallelChildResult) => void
  const targetSettled = new Promise<ParallelChildResult>((res) => { resolveTarget = res })
  childNodes.forEach((child, i) => {
    runChild(child, i, abandonSignal).then((result) => {
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
  runChild: (child: NodeDefinition, i: number, abandonSignal: AbortSignal) => Promise<ParallelChildResult>,
  timeoutMs: number,
  abandonSignal: AbortSignal
): Promise<ParallelOutput> {
  // Each child is started; Promise.any resolves with the first fulfilled (status='fulfilled') result.
  // Rejected / timeout children are logged by runChild internally and discarded here.
  const racePromises = childNodes.map(async (child, i) => {
    const result = await runChild(child, i, abandonSignal)
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
    // AggregateError from Promise.any: all children rejected. Each rejection
    // carries the child result it came from (attached above), so the group can
    // still inherit a unanimous verdict from them (#486).
    const rejectedChildren = (err instanceof AggregateError ? err.errors : [])
      .map((e: unknown) => (e as { childResult?: ParallelChildResult }).childResult)
      .filter((c): c is ParallelChildResult => c !== undefined)
    throw withFailureCause(
      new Error('All parallel children failed: no successful result'),
      classifyParallelFailure(rejectedChildren)
    )
  }
}

// Tag a group failure with the verdict its children reached, so the engine can
// record the real error type and honor suppressAlert instead of re-deriving
// 'transient' from this wrapper Error. A null cause leaves the error untagged,
// which the engine reads as "operational, classify it yourself".
function withFailureCause(err: Error, cause: ParallelFailureCause | null): Error {
  return cause ? Object.assign(err, { parallelFailureCause: cause }) : err
}
