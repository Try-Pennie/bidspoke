/**
 * Parallel node — PRD Section 5.2
 *
 * Execution modes:
 *   wait_for: 'all'      — Promise.allSettled(); waits for every child.
 *                          on_timeout: 'partial' → continue with settled results;
 *                          on_timeout: 'fail'    → throw if any child unsettled.
 *                          A slot marked on_failure: 'continue' (#2832) never
 *                          fails the block by failing (or, with on_timeout
 *                          'partial', by being late); the engine raises its
 *                          failure itself. on_timeout 'fail' still throws.
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
import { formatErr } from '../../lib/format-error'

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
  // The slot list. A slot marked `on_failure: 'continue'` (#2832) is exempt from
  // on_child_error under wait_for 'all': its failure, or its timeout under
  // on_timeout 'partial', stays in the output, and the engine records it and
  // raises it through the post-answer failure alert once the walk is done. Under
  // on_timeout 'fail' a timeout still throws, whichever slot is late. Every other
  // slot follows on_child_error as before.
  children?: Array<{ id?: unknown; on_failure?: unknown }>
}

/** The slot handle ids marked `on_failure: 'continue'` (#2832). */
export function continuingSlots(config: Record<string, unknown>): Set<string> {
  const children = Array.isArray(config.children) ? (config.children as ParallelConfig['children'] & unknown[]) : []
  return new Set(children.filter((c) => c && c.on_failure === 'continue' && typeof c.id === 'string').map((c) => c.id as string))
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
  // Slot i of one list must be slot i of the other (#3125): the engine builds
  // both from one slot list (parallelSlots, packages/workflow-definition).
  // Lists that disagree would make wait_for_slot and on_failure name a
  // neighbour's slot, so they are refused before any child runs.
  if (slotHandleIds.length > 0 && slotHandleIds.length !== childNodes.length) {
    throw new Error(`Parallel block has ${childNodes.length} slot step(s) but ${slotHandleIds.length} slot handle(s); they must be read from one slot list`)
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
        const err = withFailureCause(new Error(`Parallel failed: ${reason}`), classifyParallelFailure([named]))
        // The named slot failed before any deadline, so a sibling still running was left by that failure (#3083).
        throw named.status === 'timeout' ? withDeadlineResults(err, output) : withLeftRunning(err, output, named.namespace, 'failed', null)
      }
      // The named slot succeeded before any deadline, so a sibling still running
      // was left by that success, not cut off by a timeout (#3119). The output
      // still shows it as timeout, as it always has.
      return withLeftRunning({ output }, output, named.namespace, 'succeeded', null)
    }

    if (waitFor === 'first') {
      const { winner, leftAs } = await runFirst(childNodes, runChild, timeoutMs, abandon.signal)
      return withLeftRunning({ output: [winner] as ParallelOutput }, leftAs, winner.namespace, 'succeeded_first', null)
    }

    const output: ParallelOutput = await runAll(childNodes, runChild, timeoutMs, onTimeout, abandon.signal)

    // wait_for:'all' with on_child_error:'fail' — bail if any child failed
    if (waitFor === 'all' && onChildError === 'fail') {
      const continuing = continuingSlots(node.config)
      const failed = output.find((c, i) => (c.status === 'rejected' || c.status === 'timeout') && !continuing.has(slotHandleIds[i] ?? ''))
      if (failed) {
        const reason = failed.status === 'timeout'
          ? `child "${failed.namespace}" did not complete in time`
          : `child "${failed.namespace}" failed: ${failed.error ?? 'unknown error'}`
        // Every child ran, so every failure is consulted: the group is only a
        // business rejection if all of them were.
        const err = withFailureCause(new Error(`Parallel failed: ${reason}`), classifyParallelFailure(output))
        // Failing on a slot that failed (#3083): wait_for all waits for every slot
        // until its timeout, so a slot still running now was still running when the
        // timeout passed, and the block then failed on the other slot.
        throw failed.status === 'timeout'
          ? withDeadlineResults(err, output)
          : withLeftRunning(err, output, failed.namespace, 'failed', timeoutMs)
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
      // The same message as ever, now carrying the slots as the block left them (#3072).
      throw withDeadlineResults(new Error(`Parallel node timed out \u2014 ${unsettled} child(ren) did not settle within ${timeoutMs}ms`), asTheBlockLeftThem(childNodes, settled))
    }
    // 'partial': continue with whatever settled, mark the rest as timeout
    return asTheBlockLeftThem(childNodes, settled)
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
      const result: ParallelChildResult = { namespace: child.namespace, status: 'rejected', error: formatErr(err) }
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

  return asTheBlockLeftThem(childNodes, settled)
}

// ── wait_for: 'first' ─────────────────────────────────────────────────────────

async function runFirst(
  childNodes: NodeDefinition[],
  runChild: (child: NodeDefinition, i: number, abandonSignal: AbortSignal) => Promise<ParallelChildResult>,
  timeoutMs: number,
  abandonSignal: AbortSignal
): Promise<{ winner: ParallelChildResult; leftAs: ParallelOutput }> {
  // Each child is started; Promise.any resolves with the first fulfilled (status='fulfilled') result.
  // Rejected / timeout children are logged by runChild internally and discarded here.
  // What each child settled as, for a block that fails at its deadline to say
  // which it stopped waiting for (#3072).
  const settled: Array<ParallelChildResult | null> = childNodes.map(() => null)
  const racePromises = childNodes.map(async (child, i) => {
    const result = await runChild(child, i, abandonSignal)
    settled[i] = result
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
    // The others as the block left them when the winner returned (#3083).
    return { winner, leftAs: asTheBlockLeftThem(childNodes, settled) }
  } catch (err) {
    if (err instanceof Error && (err as { isParallelTimeout?: boolean }).isParallelTimeout) {
      throw withDeadlineResults(new Error(`Parallel node timed out \u2014 no child succeeded within ${timeoutMs}ms`), asTheBlockLeftThem(childNodes, settled))
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

/** Each slot as the block left it: what it settled as, or 'timeout' when it was still running. */
function asTheBlockLeftThem(childNodes: NodeDefinition[], settled: Array<ParallelChildResult | null>): ParallelOutput {
  return childNodes.map((child, i) => settled[i] ?? { namespace: child.namespace, status: 'timeout' })
}

/**
 * A block that fails because its own deadline passed (#3072) carries its slots
 * as it left them on the error it throws, so the engine can write the row of
 * each slot it stopped waiting for, as it does when such a block carries on
 * (#3047, #3064). Only a failure the deadline decided carries them: a block that
 * failed on a slot that failed carries the ones still running as LeftRunning
 * instead (#3083), so they are not recorded as the deadline the run failed on.
 */
function withDeadlineResults(err: Error, results: ParallelOutput): Error {
  return Object.assign(err, { parallelDeadlineResults: results })
}

/** The slots a block that failed at its own deadline left (withDeadlineResults), or null for any other error. */
export function deadlineResultsOf(err: unknown): ParallelOutput | null {
  if (!err || typeof err !== 'object') return null
  const results = (err as { parallelDeadlineResults?: unknown }).parallelDeadlineResults
  return Array.isArray(results) ? (results as ParallelOutput) : null
}

/**
 * Slots a block stopped waiting for while they still ran, for a reason other
 * than a deadline (#3083, #3119): a winner returned under wait_for first, the
 * named slot of wait_for specific succeeded, or the block failed on another
 * slot that failed. Nothing else records them: the slot's own late finish
 * writes no row (#63), and the rows of a deadline (withDeadlineResults, or a
 * block carrying on past its timeout) are not written for them. The engine
 * writes them as skipped, never failed, so the upstream outage rule, which
 * reads a marked failed row inside a block as the reason a parallel run failed
 * (failingStepDeadline), still reads the slot the block failed on, and never a
 * slot no deadline stopped. What later steps read of them (ctx.steps) is left
 * as it is in every case.
 */
export interface LeftRunning {
  /** Each slot as the block left it: `timeout` is one still running. */
  results: ParallelOutput
  /** The slot whose answer made the block stop waiting. */
  decidedBy: string
  /**
   * That slot succeeded first (wait_for first), was the named slot and
   * succeeded (wait_for specific), or failed and failed the block.
   */
  how: 'succeeded_first' | 'succeeded' | 'failed'
  /**
   * The block's timeout, when it had passed by the time the block stopped
   * waiting (wait_for all, which waits for every slot until then), so the slots
   * still running were cut short by it; null when it had not.
   */
  afterTimeoutMs: number | null
}

/** Attaches the slots still running (LeftRunning) to a block's result or error, only when there are any. */
function withLeftRunning<T extends object>(target: T, results: ParallelOutput, decidedBy: string, how: LeftRunning['how'], afterTimeoutMs: number | null): T {
  if (!results.some((c) => c.status === 'timeout')) return target
  const left: LeftRunning = { results, decidedBy, how, afterTimeoutMs }
  return Object.assign(target, { parallelLeftRunning: left })
}

/** The slots a block's result or error says it left running (withLeftRunning), or null. */
export function leftRunningOf(resultOrErr: unknown): LeftRunning | null {
  if (!resultOrErr || typeof resultOrErr !== 'object') return null
  const left = (resultOrErr as { parallelLeftRunning?: unknown }).parallelLeftRunning
  return left && typeof left === 'object' && Array.isArray((left as LeftRunning).results) ? (left as LeftRunning) : null
}

/** What the row of a slot the block left running says (#3083), in the words Dan chose. */
export function leftRunningMessage(left: LeftRunning): string {
  if (left.how === 'succeeded_first') return `Stopped waiting: branch ${left.decidedBy} finished first.`
  if (left.how === 'succeeded') return `Stopped waiting: branch ${left.decidedBy} finished.`
  if (left.afterTimeoutMs !== null) {
    const seconds = limitInSeconds(left.afterTimeoutMs)
    // Under 0.1 second no figure reads well, so the limit is named instead (#3119).
    const limit = seconds === null ? 'the block\'s time limit' : `the ${seconds} second limit`
    return `Stopped waiting at ${limit}, then branch ${left.decidedBy} failed.`
  }
  return `Stopped waiting: branch ${left.decidedBy} failed.`
}

/**
 * A block's timeout in seconds, to one decimal, written whole when that decimal
 * is 0 ("20", and "2" for 1999 ms, never "2.0"), otherwise with it ("1.5").
 * Null under 0.1 second, which would read "0.0" (#3119).
 */
export function limitInSeconds(ms: number): string | null {
  if (ms < 100) return null
  return (ms / 1000).toFixed(1).replace(/\.0$/, '')
}
