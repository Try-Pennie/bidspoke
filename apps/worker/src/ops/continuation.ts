/**
 * A slice boundary of an ops run, and the resume of the next slice (#1951, B4
 * of the #1698 run engine): what the walk (run-walk.ts) does when a slice has
 * spent its budget (checkpoint.ts CONTINUATION_BUDGET), and where a continued
 * run's next attempt starts.
 *
 * A BOUNDARY. It writes the checkpoint to R2, names it on the run
 * (record_run_checkpoint, fenced by the claim token and the state version),
 * reads it back the way the resume will (through the run's row, then R2, then
 * the digest, the run and the state version), replays its recorded route
 * against the definition, and checks the replay lands where the walk is with
 * the same outputs. Only a checkpoint that passed all of that is verified.
 *  - observe: the walk then carries on in the same invocation, so the write and
 *    read path runs on real runs and how a run ends never changes.
 *  - on: a verified boundary ends the slice to continue (RunBodyEnd continue),
 *    which invokeRun completes as a continue suspend; complete_run_request
 *    refuses one whose attempt named no checkpoint (supabase-ops migration
 *    20261028220000). A boundary that did not verify never suspends: the slice
 *    says why and carries on, and tries again at its next boundary.
 *
 * A SECRET IS NEVER WRITTEN (#3024). The checkpoint is encoded with every
 * secret the run was given masked (checkpoint.ts, format 2), and read back
 * with them refilled, so the boundary's check that the replay lands where the
 * walk is also proves the masks come back off exactly. A checkpoint whose
 * masked form would still show a value is not written: one checkpoint_skipped
 * line (holds_secret) per slice, and the slice carries on, as before #3024.
 *
 * HOW A BOUNDARY FAILS. Loudly and harmlessly: each failure is one
 * ops_continuation line, observe_failed in observe and suspend_failed in on,
 * naming its reason (store_missing, encode_failed, write_failed, not_named,
 * name_failed, superseded, not_named_on_read, checkpoint_missing, read_failed,
 * a checkpoint refusal from checkpoint.ts such as checkpoint_corrupt or
 * checkpoint_key_taken, or replay_differs), and the run goes on. The one
 * exception is a lost claim: a stale acknowledgement means the run is not this
 * holder's any more, so RunStopped is passed on and invokeRun ends the holder's
 * part there, as for any other fenced write.
 *
 * THE RESUME (#1698 1.8). An attempt of a run that has continued (its start
 * answered continuations above 0) resumes from the checkpoint the run names,
 * in every mode, whatever the attempt was resumed by: a retry after a later
 * failure resumes there too, because walking the graph again from its first
 * step would repeat every send its earlier slices made. The checkpoint is
 * read only through the run's row, answered to its holder alone (a stale
 * holder is told its claim is lost), and trusted only when its digest, run and
 * state version are the ones the row names; the walk then follows its
 * recorded routes and never evaluates an edge again. A checkpoint that cannot
 * be trusted, or that the row does not name, fails the run by name; a fault
 * that may pass (the read, the bucket, R2) retries it, nothing having run.
 * Never is a continued run walked from its first step.
 *
 * THE CAPS (#1698 1.5). At each boundary the run's compute so far (this slice's
 * walk plus every earlier slice's, carried in the checkpoint) and its
 * checkpoint's size are held to the whole run caps; a crossing is a cap_crossed
 * line naming the reason it will end the run with once enforced, and nothing
 * else (observe first). The whole run step cap is the walk's own
 * OPS_WALK_MAX_STEPS, counted from the steps the checkpoint holds.
 */
import { formatErr } from '../lib/format-error'
import type { EdgeDefinition, ExecutionContext, NodeDefinition } from '../types'
import {
  CHECKPOINT_FORMAT, CheckpointHoldsSecret, CheckpointRefused, CheckpointStoreMissing, decodeCheckpoint, encodeCheckpoint, replayCheckpoint,
  type Checkpoint, type CheckpointStep, type CheckpointStore, type ContinuationBudget, type ReplayedPosition, type WrittenCheckpoint,
} from './checkpoint'
import { CheckpointNotNamed, RunStopped, type RunBodyEnd, type RunContext } from './run-invocation'
import type { ContinuationMode } from './run-vocabulary'

/** What the walk is given to slice a run. */
export interface OpsWalkContinuation {
  mode: ContinuationMode
  budget: ContinuationBudget
  /** The R2 store. Called only at a boundary or a resume, so a run in off mode that never continued never needs the binding; throws CheckpointStoreMissing without it. */
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

/** The whole run's totals its earlier slices carried in (#1698 1.5), from the checkpoint it resumed from. */
export interface CarriedTotals {
  computeMs: number
  slices: number
}

/** A walk from the run's first step carries nothing in. */
export const NOTHING_CARRIED: CarriedTotals = { computeMs: 0, slices: 0 }

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

/** One ops_continuation line; a log line never changes how the run goes. */
function lineFor(c: OpsWalkContinuation, run: RunContext) {
  const ids = { run_request_id: run.run.runRequestId, workflow_id: run.run.workflowId }
  return (step: string, fields: Record<string, string | number | boolean | null> = {}) => {
    try {
      c.log({ event: 'ops_continuation', step, ...ids, ...fields })
    } catch {
      // A log line never changes how the run goes.
    }
  }
}

export interface BoundaryInput {
  continuation: OpsWalkContinuation
  run: RunContext
  nodes: NodeDefinition[]
  edges: EdgeDefinition[]
  /** Every step the run completed, in order across all its slices, each with the edge it left by. */
  path: readonly CheckpointStep[]
  /** The step the walk goes to next. */
  next: NodeDefinition
  ctx: ExecutionContext
  spend: SliceSpend
  /** When this slice's walk began, on the run's clock. */
  walkStartedAt: number
  /** What the run's earlier slices carried in. */
  carried: CarriedTotals
  /** The secret values the run was given, masked out of the checkpoint and refilled on its read back (#3024). */
  secrets: Readonly<Record<string, string>>
  /** Set once the binding is found missing, or a checkpoint would hold a secret, so a slice says each once. */
  said: { storeMissing: boolean; holdsSecret: boolean }
}

/**
 * One boundary. Answers verified once the checkpoint is written, named on the
 * run and would resume exactly where the walk is, and failed (said by name)
 * otherwise; a lost claim throws RunStopped.
 */
export async function checkpointBoundary(input: BoundaryInput): Promise<'verified' | 'failed'> {
  const { continuation: c, run, path, next, ctx, spend } = input
  const line = lineFor(c, run)
  const on = c.mode === 'on'
  const failed = (reason: string, error: string): 'failed' => {
    line(on ? 'suspend_failed' : 'observe_failed', { reason, error, steps: path.length })
    return 'failed'
  }

  let store: CheckpointStore
  try {
    store = c.store()
  } catch (err) {
    if (!(err instanceof CheckpointStoreMissing)) throw err
    if (!input.said.storeMissing) failed('store_missing', err.message)
    input.said.storeMissing = true
    return 'failed'
  }

  const now = run.now()
  const computeMs = input.carried.computeMs + Math.max(0, now - input.walkStartedAt)
  const cp: WrittenCheckpoint = {
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
    totals: { steps: path.length, computeMs, slices: input.carried.slices + 1 },
  }
  let enc: Awaited<ReturnType<typeof encodeCheckpoint>>
  try {
    enc = await encodeCheckpoint(cp, input.secrets)
  } catch (err) {
    if (!(err instanceof CheckpointHoldsSecret)) return failed('encode_failed', formatErr(err))
    if (!input.said.holdsSecret) line('checkpoint_skipped', { reason: 'holds_secret', steps: path.length })
    input.said.holdsSecret = true
    return 'failed'
  }
  if (computeMs > c.budget.runComputeMs) line('cap_crossed', { cap: 'max_compute_exceeded', value: computeMs, limit: c.budget.runComputeMs })
  if (enc.bytes > c.budget.runStateBytes) line('cap_crossed', { cap: 'max_state_exceeded', value: enc.bytes, limit: c.budget.runStateBytes })

  // 1. Write, only where nothing is.
  try {
    await store.put(enc.key, enc.body, enc.sha256)
  } catch (err) {
    return failed(err instanceof CheckpointRefused ? err.reason : 'write_failed', formatErr(err))
  }
  // 2. Name it on the run. A stale answer is a lost claim, passed on as RunStopped.
  try {
    const named = await run.checkpoints.name({ steps: path.length, key: enc.key, sha256: enc.sha256, bytes: enc.bytes })
    if (named === 'superseded') return failed('superseded', `the run names a later checkpoint than ${enc.key}`)
  } catch (err) {
    if (err instanceof RunStopped) throw err
    return failed(err instanceof CheckpointNotNamed ? 'not_named' : 'name_failed', formatErr(err))
  }
  // 3. Read it back as the resume will: the run's row first (L581), then R2.
  try {
    const pointer = await run.checkpoints.read()
    if (pointer === null || pointer.key !== enc.key) {
      return failed('not_named_on_read', `the run names ${pointer === null ? 'no checkpoint' : pointer.key}, not ${enc.key}`)
    }
    const body = await store.get(pointer.key)
    if (body === null) return failed('checkpoint_missing', `${pointer.key} is named on the run and absent from R2`)
    const back = await decodeCheckpoint(body, pointer, run.run, input.secrets)
    const at = replayCheckpoint(input.nodes, input.edges, back)
    if (at.next.id !== next.id || at.lastCompletedNamespace !== ctx.lastCompletedNamespace) {
      return failed('replay_differs', `the replay resumes at ${at.next.id} after ${at.lastCompletedNamespace ?? 'nothing'}, and the walk is at ${next.id} after ${ctx.lastCompletedNamespace ?? 'nothing'}`)
    }
    const differ = Object.keys(ctx.steps).filter((ns) => !sameJson(ctx.steps[ns]?.output, at.steps[ns]?.output))
    if (differ.length > 0 || Object.keys(at.steps).length !== Object.keys(ctx.steps).length) {
      return failed('replay_differs', `the output of step ${differ.join(', ') || '(a step the walk does not hold)'} would not come back the same from a checkpoint`)
    }
  } catch (err) {
    if (err instanceof RunStopped) throw err
    return failed(err instanceof CheckpointRefused ? err.reason : 'read_failed', formatErr(err))
  }
  line(on ? 'suspend' : 'would_suspend', {
    key: enc.key, steps: path.length, bytes: enc.bytes, next_node_id: next.id,
    slice_ms: Math.max(0, now - spend.startedAt), slice_steps: spend.steps, slice_sends: spend.sends, compute_ms: computeMs, slices: cp.totals.slices,
  })
  return 'verified'
}

/** Where a continued run's attempt starts, or how it ends without running a step. */
export type ResumeAnswer =
  | { kind: 'resumed'; checkpoint: Checkpoint; at: ReplayedPosition }
  | { kind: 'end'; end: Extract<RunBodyEnd, { outcome: 'failed' } | { outcome: 'retry' }> }

/**
 * The place a continued run resumes from (run.continuations above 0): the
 * checkpoint the run names, read through its row, trusted only as
 * decodeCheckpoint allows, its masked secrets refilled from the ones served to
 * this slice (a masked secret not served fails the run by name, #3024), its
 * route replayed. Throws RunStopped when the run is no longer this holder's.
 * Never answers the run's first step.
 */
export async function resumeFromCheckpoint(input: {
  continuation: OpsWalkContinuation | undefined
  run: RunContext
  nodes: NodeDefinition[]
  edges: EdgeDefinition[]
  /** The secret values served to this slice, refilled where its checkpoint masked them. */
  secrets: Readonly<Record<string, string>>
}): Promise<ResumeAnswer> {
  const { run, continuation: c } = input
  const n = run.continuations
  const line = c === undefined ? () => undefined : lineFor(c, run)
  const continued = `the run has continued ${n} ${n === 1 ? 'time' : 'times'}`
  /** A refusal that will not pass: the run fails by name, never walked from its first step. */
  const fail = (reason: string, error: string): ResumeAnswer => {
    line('resume_refused', { reason, error, continuations: n })
    return { kind: 'end', end: { outcome: 'failed', error } }
  }
  /** A fault that may pass: nothing has run, so the run is retried and resumes then. */
  const retry = (reason: string, why: string): ResumeAnswer => {
    line('resume_refused', { reason, error: why, continuations: n })
    return { kind: 'end', end: { outcome: 'retry', error: `${continued}, and its checkpoint could not be read (${why}), so nothing was run` } }
  }

  let pointer
  try {
    pointer = await run.checkpoints.read()
  } catch (err) {
    if (err instanceof RunStopped) throw err
    return retry('read_failed', formatErr(err))
  }
  if (pointer === null) {
    return fail('not_named', `${continued} and names no checkpoint, so it cannot resume, and it is never walked again from its first step`)
  }
  let store: CheckpointStore
  try {
    if (c === undefined) throw new CheckpointStoreMissing()
    store = c.store()
  } catch (err) {
    return retry(err instanceof CheckpointStoreMissing ? 'store_missing' : 'read_failed', formatErr(err))
  }
  let body: string | null
  try {
    body = await store.get(pointer.key)
  } catch (err) {
    return retry('read_failed', formatErr(err))
  }
  if (body === null) {
    return fail('checkpoint_missing', `checkpoint_missing: ${pointer.key} is named on the run and absent from R2, so ${continued} and cannot resume`)
  }
  let checkpoint: Checkpoint
  let at: ReplayedPosition
  try {
    checkpoint = await decodeCheckpoint(body, pointer, run.run, input.secrets)
    at = replayCheckpoint(input.nodes, input.edges, checkpoint)
  } catch (err) {
    if (err instanceof CheckpointRefused) return fail(err.reason, err.message)
    return retry('read_failed', formatErr(err))
  }
  line('resumed', { key: pointer.key, steps: at.walked, slices: checkpoint.totals.slices, next_node_id: at.next.id, continuations: n })
  return { kind: 'resumed', checkpoint, at }
}
