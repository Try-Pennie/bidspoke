/**
 * A slice boundary of an ops run (#1951, B4 of the #1698 run engine), in
 * observe mode: what the walk (run-walk.ts) does when a slice has spent its
 * budget (checkpoint.ts CONTINUATION_BUDGET).
 *
 * WHAT OBSERVE DOES. Everything a real boundary will do except stop: it writes
 * the checkpoint to R2, names it on the run (record_run_checkpoint, fenced by
 * the claim token and the state version), reads it back the way the resume
 * will (through the run's row, then R2, then the digest, the run and the state
 * version), replays its recorded route against the definition, and checks the
 * replay lands where the walk is with the same outputs. Then the walk carries
 * on in the same invocation. So the write and read path runs on real runs, and
 * how a run ends never changes (L142: the half observe does not run is the
 * suspend and the claim of the continuation, the next slice of #1951).
 *
 * HOW IT FAILS. Loudly and harmlessly: each failure is one ops_continuation
 * observe_failed line naming its reason (store_missing, encode_failed,
 * write_failed, not_named, name_failed, superseded, not_named_on_read,
 * checkpoint_missing, read_failed, a checkpoint refusal from checkpoint.ts such
 * as checkpoint_corrupt or checkpoint_key_taken, or replay_differs), and the
 * run goes on as if off. The
 * one exception is a lost claim: a stale acknowledgement means the run is not
 * this holder's any more, so RunStopped is passed on and invokeRun ends the
 * holder's part there, as for any other fenced write.
 *
 * THE CAPS (#1698 1.5). At each boundary the run's compute so far and its
 * checkpoint's size are held to the whole run caps; a crossing is a cap_crossed
 * line naming the reason it will end the run with once enforced, and nothing
 * else (observe first).
 */
import { formatErr } from '../lib/format-error'
import type { EdgeDefinition, ExecutionContext, NodeDefinition } from '../types'
import {
  CHECKPOINT_FORMAT, CheckpointRefused, CheckpointStoreMissing, decodeCheckpoint, encodeCheckpoint, replayCheckpoint,
  type Checkpoint, type CheckpointStep, type CheckpointStore, type ContinuationBudget,
} from './checkpoint'
import { CheckpointNotNamed, RunStopped, type RunContext } from './run-invocation'
import type { ContinuationMode } from './run-vocabulary'

/** What the walk is given to slice a run. */
export interface OpsWalkContinuation {
  mode: ContinuationMode
  budget: ContinuationBudget
  /** The R2 store. Called only at a boundary, so a run in off mode never needs the binding; throws CheckpointStoreMissing without it. */
  store(): CheckpointStore
  /** One line per event, names and counts only, never a payload (L658). */
  log(event: Record<string, string | number | boolean | null>): void
}

/** What one slice has spent so far. */
export interface SliceSpend {
  startedAt: number
  steps: number
  sends: number
}

export function overBudget(budget: ContinuationBudget, spend: SliceSpend, now: number): boolean {
  return now - spend.startedAt >= budget.sliceWallMs || spend.steps >= budget.sliceSteps || spend.sends >= budget.sliceSends
}

/**
 * Whether two values are the same JSON: a value the replay restores (b, read
 * back from JSON) against the one the walk holds (a). A property whose value
 * is undefined is the same as one missing, since JSON drops it and a template
 * reads both alike; anything else JSON cannot carry (a Date, NaN, a Map) is a
 * difference, and the step that answered it would resume with another value.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === null || typeof a !== 'object') return typeof a === 'number' ? Number.isFinite(a) && a === b : a === b
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]))
  if (Object.getPrototypeOf(a) !== Object.prototype && Object.getPrototypeOf(a) !== null) return false
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return false
  const ak = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const bk = Object.keys(b)
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(b, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

export interface BoundaryInput {
  continuation: OpsWalkContinuation
  run: RunContext
  nodes: NodeDefinition[]
  edges: EdgeDefinition[]
  /** Every step the walk completed, in order, each with the edge it left by. */
  path: readonly CheckpointStep[]
  /** The step the walk goes to next. */
  next: NodeDefinition
  ctx: ExecutionContext
  spend: SliceSpend
  /** When the walk began, on the run's clock. */
  walkStartedAt: number
  /** Set once the binding is found missing, so a run says it once. */
  said: { storeMissing: boolean }
}

/**
 * One boundary in observe mode. Answers when it is done, whatever happened,
 * except that a lost claim throws RunStopped.
 */
export async function observeBoundary(input: BoundaryInput): Promise<void> {
  const { continuation: c, run, path, next, ctx, spend } = input
  const ids = { run_request_id: run.run.runRequestId, workflow_id: run.run.workflowId }
  const line = (step: string, fields: Record<string, string | number | boolean | null> = {}) => {
    try {
      c.log({ event: 'ops_continuation', step, ...ids, ...fields })
    } catch {
      // A log line never changes how the run goes.
    }
  }
  const failed = (reason: string, error: string) => line('observe_failed', { reason, error, steps: path.length })

  let store: CheckpointStore
  try {
    store = c.store()
  } catch (err) {
    if (!(err instanceof CheckpointStoreMissing)) throw err
    if (!input.said.storeMissing) failed('store_missing', err.message)
    input.said.storeMissing = true
    return
  }

  const now = run.now()
  const computeMs = Math.max(0, now - input.walkStartedAt)
  const cp: Checkpoint = {
    v: CHECKPOINT_FORMAT,
    runRequestId: run.run.runRequestId,
    organizationId: run.run.organizationId,
    workflowId: run.run.workflowId,
    workflowVersion: run.run.workflowVersion,
    executionChainId: run.run.executionChainId,
    stateVersion: run.stateVersion,
    executionId: run.executionId,
    attempt: run.attempt,
    writtenAt: new Date(now).toISOString(),
    path: [...path],
    nextNodeId: next.id,
    totals: { steps: path.length, computeMs, slices: 1 },
  }
  let enc: Awaited<ReturnType<typeof encodeCheckpoint>>
  try {
    enc = await encodeCheckpoint(cp)
  } catch (err) {
    failed('encode_failed', formatErr(err))
    return
  }
  if (computeMs > c.budget.runComputeMs) line('cap_crossed', { cap: 'max_compute_exceeded', value: computeMs, limit: c.budget.runComputeMs })
  if (enc.bytes > c.budget.runStateBytes) line('cap_crossed', { cap: 'max_state_exceeded', value: enc.bytes, limit: c.budget.runStateBytes })

  // 1. Write, only where nothing is.
  try {
    await store.put(enc.key, enc.body, enc.sha256)
  } catch (err) {
    failed(err instanceof CheckpointRefused ? err.reason : 'write_failed', formatErr(err))
    return
  }
  // 2. Name it on the run. A stale answer is a lost claim, passed on as RunStopped.
  try {
    const named = await run.checkpoints.name({ steps: path.length, key: enc.key, sha256: enc.sha256, bytes: enc.bytes })
    if (named === 'superseded') {
      failed('superseded', `the run names a later checkpoint than ${enc.key}`)
      return
    }
  } catch (err) {
    if (err instanceof RunStopped) throw err
    failed(err instanceof CheckpointNotNamed ? 'not_named' : 'name_failed', formatErr(err))
    return
  }
  // 3. Read it back as the resume will: the run's row first (L581), then R2.
  try {
    const pointer = await run.checkpoints.read()
    if (pointer === null || pointer.key !== enc.key) {
      failed('not_named_on_read', `the run names ${pointer === null ? 'no checkpoint' : pointer.key}, not ${enc.key}`)
      return
    }
    const body = await store.get(pointer.key)
    if (body === null) {
      failed('checkpoint_missing', `${pointer.key} is named on the run and absent from R2`)
      return
    }
    const back = await decodeCheckpoint(body, pointer, run.run)
    const at = replayCheckpoint(input.nodes, input.edges, back)
    if (at.next.id !== next.id || at.lastCompletedNamespace !== ctx.lastCompletedNamespace) {
      failed('replay_differs', `the replay resumes at ${at.next.id} after ${at.lastCompletedNamespace ?? 'nothing'}, and the walk is at ${next.id} after ${ctx.lastCompletedNamespace ?? 'nothing'}`)
      return
    }
    const differ = Object.keys(ctx.steps).filter((ns) => !sameJson(ctx.steps[ns]?.output, at.steps[ns]?.output))
    if (differ.length > 0 || Object.keys(at.steps).length !== Object.keys(ctx.steps).length) {
      failed('replay_differs', `the output of step ${differ.join(', ') || '(a step the walk does not hold)'} would not come back the same from a checkpoint`)
      return
    }
  } catch (err) {
    if (err instanceof RunStopped) throw err
    failed(err instanceof CheckpointRefused ? err.reason : 'read_failed', formatErr(err))
    return
  }
  line('would_suspend', {
    key: enc.key, steps: path.length, bytes: enc.bytes, next_node_id: next.id,
    slice_ms: Math.max(0, now - spend.startedAt), slice_steps: spend.steps, slice_sends: spend.sends, compute_ms: computeMs,
  })
}
