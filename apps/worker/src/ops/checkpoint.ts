/**
 * The ops run checkpoint (#1951, track B4 of the #1698 run engine, ops lane
 * only; the money lane's resume is unchanged and never reaches this module).
 *
 * WHY. Spike 0 (docs/ops-ceilings-spike.md, P2 and P4) measured that a run the
 * minute tick dispatches has 30 s of CPU of its own but no wall clock of its
 * own: it dies with its tick. A ported workflow longer than that can only
 * finish across several invocations, each a slice that stops at a boundary,
 * writes where it got to, and lets the next one carry on from there. This
 * module is what a slice writes and what the next one reads.
 *
 * WHAT A CHECKPOINT HOLDS (#1698 1.8). Every step the run completed, in walk
 * order, with its output and the edge it left by, and the step the walk goes
 * to next. The edge is the route: a branch or filter routes by its output's
 * _route, which its edges do not carry, so evaluating its edges again would
 * take the first arm whatever it took (the first recorded resume failure).
 * replayCheckpoint therefore restores the outputs and follows the recorded
 * edges, and never evaluates one.
 *
 * WHERE. In the OPS_CHECKPOINTS R2 bucket, under
 * checkpoints/v1/<organization>/<run>/<state version>-<steps>.json. The state
 * version is the one the writing holder's start answered (#1698 D2), so two
 * holders of one run never share a key, and the steps make each of one
 * holder's checkpoints its own. A key is written only where nothing is: a
 * repeat after a lost answer finds its own object, and any other body at the
 * key is refused, never overwritten.
 *
 * WHICH ONE IS TRUSTED. Only the one the run's row names (record_run_checkpoint,
 * supabase-ops migration 20261027150000), with the digest and size recorded
 * there. A checkpoint written but not acknowledged is never read: the row does
 * not name it. An object at the named key whose digest, run, state version or
 * step count differs is refused by name (L617: what a kill leaves behind reads
 * as healthy to any content check).
 *
 * THE MODE. OPS_CONTINUATION in wrangler.ops.toml: off (unset) writes nothing;
 * observe writes, acknowledges and reads back a checkpoint at each slice
 * boundary and carries on in the same invocation, so the whole write and read
 * path runs on real runs without changing how any run ends. Suspending a run
 * and resuming it in a later invocation (on) is the next slice of #1951 and is
 * not in this build, so it is refused here and reported, never half run.
 */
import { findEntryNode, findNode } from '../engine/graph'
import type { EdgeDefinition, NodeDefinition, StepOutput } from '../types'
import { CONTINUATION_MODES, type ContinuationMode } from './run-vocabulary'

/** The checkpoint format this build writes and reads. */
export const CHECKPOINT_FORMAT = 1

/** One completed step, and the edge the walk left it by. */
export interface CheckpointStep {
  /** Its place in the walk, from 0. */
  seq: number
  nodeId: string
  namespace: string
  output: unknown
  /** The edge the walk took from this step. Every step in a checkpoint has one: a checkpoint is written only where the walk goes on. */
  edgeId: string
}

export interface Checkpoint {
  v: typeof CHECKPOINT_FORMAT
  runRequestId: string
  organizationId: string
  workflowId: string
  workflowVersion: number
  executionChainId: string
  /** The state version of the holder that wrote it (#1698 D2). */
  stateVersion: number
  executionId: string
  attempt: number
  writtenAt: string
  path: CheckpointStep[]
  /** Where the walk resumes. */
  nextNodeId: string
  /** Across the whole run so far, for its caps (#1698 1.5). */
  totals: { steps: number; computeMs: number; slices: number }
}

/** What the run's row says of the checkpoint it acknowledged. */
export interface CheckpointPointer {
  key: string
  stateVersion: number
  steps: number
  sha256: string
  bytes: number
}

/** Why a checkpoint was not written or not trusted, each by name. */
export const CHECKPOINT_REFUSALS = [
  'checkpoint_corrupt',
  'checkpoint_stale',
  'checkpoint_not_this_run',
  'checkpoint_format_unknown',
  'checkpoint_route_mismatch',
  'checkpoint_missing',
  'checkpoint_key_taken',
] as const
export type CheckpointRefusal = (typeof CHECKPOINT_REFUSALS)[number]

export class CheckpointRefused extends Error {
  constructor(readonly reason: CheckpointRefusal, detail: string) {
    super(`${reason}: ${detail}`)
    this.name = 'CheckpointRefused'
  }
}

const SAFE_PART = /^[0-9a-f-]{36}$/

export function checkpointKey(organizationId: string, runRequestId: string, stateVersion: number, steps: number): string {
  if (!SAFE_PART.test(organizationId)) throw new Error(`a checkpoint key's organization must be a uuid, not ${JSON.stringify(organizationId)}`)
  if (!SAFE_PART.test(runRequestId)) throw new Error(`a checkpoint key's run must be a uuid, not ${JSON.stringify(runRequestId)}`)
  if (!Number.isSafeInteger(stateVersion) || stateVersion < 1) throw new Error(`a checkpoint key's state version must be a whole number from 1, not ${stateVersion}`)
  if (!Number.isSafeInteger(steps) || steps < 1) throw new Error(`a checkpoint key's steps must be a whole number from 1, not ${steps}`)
  return `checkpoints/v${CHECKPOINT_FORMAT}/${organizationId}/${runRequestId}/${stateVersion}-${steps}.json`
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function encodeCheckpoint(cp: Checkpoint): Promise<{ key: string; body: string; bytes: number; sha256: string }> {
  const body = JSON.stringify(cp)
  return {
    key: checkpointKey(cp.organizationId, cp.runRequestId, cp.stateVersion, cp.path.length),
    body,
    bytes: new TextEncoder().encode(body).length,
    sha256: await sha256Hex(body),
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

function isStep(v: unknown, i: number): v is CheckpointStep {
  return isRecord(v) && v.seq === i && typeof v.nodeId === 'string' && typeof v.namespace === 'string' && 'output' in v && typeof v.edgeId === 'string'
}

/** The run a checkpoint must belong to. */
export interface CheckpointIdentity {
  runRequestId: string
  organizationId: string
  workflowId: string
  workflowVersion: number
  executionChainId: string
}

/**
 * The checkpoint in body, trusted only if it is exactly the one pointer
 * acknowledges, of this run. Throws CheckpointRefused naming why not.
 */
export async function decodeCheckpoint(body: string, pointer: CheckpointPointer, run: CheckpointIdentity): Promise<Checkpoint> {
  if ((await sha256Hex(body)) !== pointer.sha256) {
    throw new CheckpointRefused('checkpoint_corrupt', `the object at ${pointer.key} is not the one acknowledged (its digest differs)`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new CheckpointRefused('checkpoint_corrupt', `the object at ${pointer.key} is not JSON`)
  }
  if (!isRecord(parsed)) throw new CheckpointRefused('checkpoint_corrupt', `the object at ${pointer.key} is not a checkpoint`)
  if (parsed.v !== CHECKPOINT_FORMAT) throw new CheckpointRefused('checkpoint_format_unknown', `format ${JSON.stringify(parsed.v)}, and this build reads ${CHECKPOINT_FORMAT}`)
  const totals = parsed.totals
  if (!Array.isArray(parsed.path) || !parsed.path.every(isStep) || typeof parsed.nextNodeId !== 'string' || !isWhole(parsed.stateVersion)
    || typeof parsed.executionId !== 'string' || !isWhole(parsed.attempt) || typeof parsed.writtenAt !== 'string'
    || !isRecord(totals) || !isWhole(totals.steps) || !isWhole(totals.computeMs) || !isWhole(totals.slices)) {
    throw new CheckpointRefused('checkpoint_corrupt', `the object at ${pointer.key} is not a whole checkpoint`)
  }
  const cp = parsed as unknown as Checkpoint
  if (cp.runRequestId !== run.runRequestId || cp.organizationId !== run.organizationId || cp.workflowId !== run.workflowId
    || cp.workflowVersion !== run.workflowVersion || cp.executionChainId !== run.executionChainId) {
    throw new CheckpointRefused('checkpoint_not_this_run', `the object at ${pointer.key} belongs to another run, organization, workflow version or chain`)
  }
  if (cp.stateVersion !== pointer.stateVersion || cp.path.length !== pointer.steps) {
    throw new CheckpointRefused('checkpoint_stale', `the object at ${pointer.key} was written at state version ${cp.stateVersion} with ${cp.path.length} steps, and the run acknowledged ${pointer.stateVersion} with ${pointer.steps}`)
  }
  return cp
}

/** Where a replayed checkpoint leaves the walk. */
export interface ReplayedPosition {
  /** The context's steps as the walk had them, each later output of a step walked twice over its earlier one. */
  steps: Record<string, StepOutput>
  lastCompletedNamespace: string | undefined
  next: NodeDefinition
  /** How many steps were walked: the next step's place. */
  walked: number
}

/**
 * The walk's place, restored from cp by following its recorded edges from the
 * entry step. No step is executed and no edge is evaluated. A recorded route
 * that does not fit the definition is refused by name, never walked some other
 * way.
 */
export function replayCheckpoint(nodes: NodeDefinition[], edges: EdgeDefinition[], cp: Checkpoint): ReplayedPosition {
  const mismatch = (detail: string) => new CheckpointRefused('checkpoint_route_mismatch', detail)
  if (cp.path.length === 0) throw mismatch('the checkpoint holds no step')
  let current: NodeDefinition | undefined
  try {
    current = findEntryNode(nodes, edges)
  } catch {
    throw mismatch('the definition has no entry step')
  }
  const steps: Record<string, StepOutput> = {}
  let last: string | undefined
  for (const step of cp.path) {
    if (current === undefined || current.id !== step.nodeId) {
      throw mismatch(`place ${step.seq} recorded step ${step.nodeId}, and the recorded route reaches ${current?.id ?? 'no step'} there`)
    }
    if (current.namespace !== step.namespace) throw mismatch(`step ${step.nodeId} was recorded as ${step.namespace}, and the definition names it ${current.namespace}`)
    steps[step.namespace] = { output: step.output, status: 'completed' }
    last = step.namespace
    const taken = edges.find((e) => e.id === step.edgeId)
    if (taken === undefined) throw mismatch(`step ${step.nodeId} left by edge ${step.edgeId}, which the definition does not hold`)
    if (taken.source !== step.nodeId) throw mismatch(`edge ${step.edgeId} does not leave step ${step.nodeId}`)
    current = findNode(taken.target, nodes)
  }
  if (current === undefined || current.id !== cp.nextNodeId) {
    throw mismatch(`the recorded route ends at ${current?.id ?? 'no step'}, and the checkpoint resumes at ${cp.nextNodeId}`)
  }
  return { steps, lastCompletedNamespace: last, next: current, walked: cp.path.length }
}

// ── the store ───────────────────────────────────────────────────────────────

export interface CheckpointStore {
  /** Writes body at key only where nothing is. already_written: the same body is there (a repeat after a lost answer). */
  put(key: string, body: string, sha256: string): Promise<'written' | 'already_written'>
  /** The body at key, or null when there is none. */
  get(key: string): Promise<string | null>
}

export function r2CheckpointStore(bucket: R2Bucket): CheckpointStore {
  return {
    async put(key, body, sha256) {
      // R2 refuses the write if the bytes it received do not hash to sha256, and writes only where no object is.
      const put = await bucket.put(key, body, { onlyIf: { etagDoesNotMatch: '*' }, sha256, httpMetadata: { contentType: 'application/json' } })
      if (put !== null) return 'written'
      const there = await bucket.get(key)
      const text = there === null ? null : await there.text()
      if (text === body) return 'already_written'
      throw new CheckpointRefused('checkpoint_key_taken', `${key} already holds another checkpoint, and is never overwritten`)
    },
    async get(key) {
      const object = await bucket.get(key)
      return object === null ? null : object.text()
    },
  }
}

/** The binding is missing from this deploy: the continuation cannot write, and says so by name. */
export class CheckpointStoreMissing extends Error {
  constructor() {
    super('the OPS_CHECKPOINTS R2 binding is missing from this deploy, so no checkpoint can be written or read')
    this.name = 'CheckpointStoreMissing'
  }
}

export function checkpointStoreFrom(env: { OPS_CHECKPOINTS?: R2Bucket }): CheckpointStore {
  if (env.OPS_CHECKPOINTS === undefined) throw new CheckpointStoreMissing()
  return r2CheckpointStore(env.OPS_CHECKPOINTS)
}

// ── the mode and the budgets ────────────────────────────────────────────────

/** The modes OPS_CONTINUATION may name in this build. Anything else is off, and named as not configured. */
export function continuationModeFrom(value: string | undefined): { mode: ContinuationMode; unknown: string | null } {
  const v = value?.trim() ?? ''
  if (v === '') return { mode: 'off', unknown: null }
  if ((CONTINUATION_MODES as readonly string[]).includes(v)) return { mode: v as ContinuationMode, unknown: null }
  return { mode: 'off', unknown: value ?? null }
}

/**
 * Where a slice stops (#1698 1.5), and the caps on a whole run. The slice
 * budget is what a slice may spend before its boundary: wall clock (CPU is
 * not measurable inside a Worker, and the clock moves only across I/O, so
 * wall time is the proxy), steps and sends. The run caps are observed only:
 * a crossing is logged, nothing is ended (#1698 1.5, observe first). The whole
 * run's step cap is not here: OPS_WALK_MAX_STEPS in run-walk.ts already ends a
 * run by name.
 */
export interface ContinuationBudget {
  sliceWallMs: number
  sliceSteps: number
  sliceSends: number
  runComputeMs: number
  runStateBytes: number
}

/**
 * The defaults, from the spike's ceilings with headroom (L704): 5 minutes of
 * a dispatched run's 14.5 minute window (the plan's starting figure, #1698
 * 1.5), 50 steps and 500 sends (subrequests, well inside the 10,000 a call may
 * make, spike P3). A run's compute is capped at 30 minutes and its checkpoint
 * at 8 MB, observed.
 */
export const CONTINUATION_BUDGET: ContinuationBudget = {
  sliceWallMs: 5 * 60_000,
  sliceSteps: 50,
  sliceSends: 500,
  runComputeMs: 30 * 60_000,
  runStateBytes: 8 * 1024 * 1024,
}
