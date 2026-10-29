/**
 * The ops run body (#1950, PR 5 of B3): one workflow version's definition,
 * walked step by step inside invokeRun (run-invocation.ts).
 *
 * WHAT RUNS A STEP. The ops lane's in memory node types run on the engine's own
 * executors, the same code the bidding Worker runs for them (filter, branch,
 * transform, response; branch_end and exit only route or stop): nothing they do
 * leaves the Worker. Every other step runs through a handler registered for its
 * type, which reaches outside only through the run's ctx.send, the ledgered,
 * fenced, deadlined send: app_action (app-action.ts, #2339), which
 * run-body.ts registers. A type with neither
 * is refused by name before any step runs, so a run never does half its graph
 * and stops at a step it cannot take; the ops lane's webhook and code steps are
 * refused that way until they send through ctx.send.
 *
 * WHAT IT REFUSES BEFORE RUNNING. A definition that is not nodes and edges, has
 * no step or no entry, or names a type nothing runs. And one reading an
 * environment variable (env.X, {{env.X}}) it was not given, so no step ever
 * runs on a blank (#2998, Dan's decisions of 2026-10-28 and 29): a run is
 * given the variables it read when it started (run-variables.ts runVariablesFor),
 * only those its definition reads: each plain one as the run recorded it at its
 * first start (ctx.runVariables), and each secret one as served for this start
 * (options.secretValues), since a secret's value is never kept. A variable that
 * did not exist when the run started is refused by name as missing, a secret
 * not served again by name, and any variable when the run has no record.
 *
 * A SECRET IS NEVER KEPT (#2998). Every secret value the run was given is
 * masked (mask-secrets.ts, replaced by its variable's name) in each step's
 * record, output and error, and in the error the run ends with, so neither
 * ops_step_records nor the run's last_error holds one. A slice boundary whose
 * checkpoint would hold one (a step output carrying it) is skipped, logged once
 * as checkpoint_skipped, and the slice carries on: a checkpoint is written to
 * R2, and masking it would change what the next slice's steps read.
 *
 * HOW IT ENDS. Done when a step has no next edge, an exit or a filter's exit
 * route is reached. Failed, naming the step, when a step reports an error or
 * throws; a step's error is deterministic, so retrying the run would only
 * repeat it. Failed with max_steps_exceeded past OPS_WALK_MAX_STEPS steps (a
 * loop). A step that throws StepEndsRun ends the run as it says (a retry or
 * needs_human), naming the step. RunStopped from ctx.send is passed on, so
 * invokeRun ends the run by the answer that stopped it.
 *
 * TIME SLICES (#1951). With a continuation in a mode other than off, the walk
 * keeps every completed step with the edge it left by, and counts what the
 * slice has spent (its wall clock, steps and a handler's sends). Between two
 * steps, once the slice has spent its budget, it hands that to the boundary
 * (continuation.ts): a checkpoint is written, named, read back and replayed.
 * In observe mode the walk then carries on; in on mode a verified boundary
 * ends the slice to continue (RunBodyEnd continue), and one that did not
 * verify carries on. Off, it reads the clock no more than before and keeps
 * nothing.
 *
 * A CONTINUED RUN (#1951, #1698 1.8). When the run's start answered
 * continuations above 0, the walk does not start at the entry step: after the
 * checks above (so a type nothing runs, a money only one included, is refused
 * before any checkpoint is read), it resumes from the checkpoint the run
 * names (continuation.ts resumeFromCheckpoint), every completed step's output
 * restored and the recorded routes followed, never an edge evaluated again,
 * in every mode. The whole run's steps count toward OPS_WALK_MAX_STEPS, so a
 * run that loops across slices still ends at the cap; its compute and slices
 * carry into its next checkpoint. A slice's step records are its own
 * attempt's, from place 0, and a checkpoint's places are the whole run's.
 *
 * WHAT IT RECORDS (#2703). Each step, as it finishes and before the next one
 * runs, through run.recordStep: its place in the attempt, node, step id, type,
 * status, start, duration, its output (kept under the step output cap,
 * step-output.ts, and otherwise named by its size) and its error. A step that
 * failed, threw or ended the run is recorded failed with the error the run ends
 * with. A step stopped with its run (RunStopped) is not recorded: the run's end
 * names it. A definition refused before any step ran records nothing.
 *
 * A RECORD NOT KEPT (Dan, 2026-10-24: kept like step test results, so a failed
 * run shows what came before the step that failed). When a step's record cannot
 * be written after every try, the run ends at that step, never going on past a
 * step it has no record of: a step that completed ends the run as a retry
 * naming the step (invokeRun makes that failed when a send already made cannot
 * be repeated), and a step that failed ends it as it would have, its error
 * saying the record was not kept either. So an attempt's records are always the
 * steps it walked, from the first, and a run that went on is never one whose
 * records are silently short.
 */
import { buildContext } from '../engine/context'
import { evaluateEdge, findEntryNode, findNode, outgoingEdges } from '../engine/graph'
import { executeBranchNode } from '../engine/nodes/branch'
import { executeFilterNode } from '../engine/nodes/filter'
import { executeResponseNode } from '../engine/nodes/response'
import { executeTransformNode } from '../engine/nodes/transform'
import { envReferences } from '../lib/definition-env-references'
import { formatErr } from '../lib/format-error'
import type { EdgeDefinition, ExecutionContext, NodeDefinition, StepExecutionResult } from '../types'
import type { CheckpointStep } from './checkpoint'
import {
  checkpointBoundary, NOTHING_CARRIED, overBudget, resumeFromCheckpoint, type CarriedTotals, type OpsWalkContinuation, type SliceSpend,
} from './continuation'
import { holdsSecret, maskSecrets } from './mask-secrets'
import { RunStopped, StepUnrecorded, type RunBodyEnd, type RunContext } from './run-invocation'
import { runVariablesFor } from './run-variables'
import type { OpsStepRecordStatus } from './run-vocabulary'
import { clipError, keepOutput } from './step-output'

/** The most steps one run walks: a loop ends here, failed by name. */
export const OPS_WALK_MAX_STEPS = 200

/** A step that may reach outside the Worker, and only through run.send. */
export type OpsStepHandler = (args: { node: NodeDefinition; ctx: ExecutionContext; run: RunContext }) => Promise<StepExecutionResult>

/** How a step may end its run: never done, and never to continue, which only a slice boundary decides (#1951). */
export type StepEnd = Exclude<RunBodyEnd, { outcome: 'done' } | { outcome: 'continue' }>

/**
 * Thrown by a handler whose step decides how the whole run ends rather than
 * failing it (#2339): a retry when nothing it did can have changed anything
 * (a copy it could not read, a GET past its deadline, an idempotent action's
 * unknown outcome), needs_human when a non idempotent send's outcome is
 * unknown. The walk ends the run so, naming the step; invokeRun still turns a
 * retry after a send that cannot be repeated into failed.
 */
export class StepEndsRun extends Error {
  constructor(readonly end: StepEnd) {
    super(end.error ?? end.outcome)
    this.name = 'StepEndsRun'
  }
}

/** The in memory executors: pure, reaching nothing outside the Worker. */
const IN_MEMORY: Readonly<Record<string, (node: NodeDefinition, ctx: ExecutionContext) => StepExecutionResult>> = {
  filter: executeFilterNode,
  branch: executeBranchNode,
  transform: executeTransformNode,
  response: executeResponseNode,
  branch_end: () => ({ output: null }),
  exit: () => ({ output: null, earlyExit: true }),
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

const failed = (error: string): Extract<RunBodyEnd, { outcome: 'failed' }> => ({ outcome: 'failed', error })

export interface OpsWalkOptions {
  /** Time sliced continuation (#1951): absent or off, the walk never stops at a boundary. */
  continuation?: OpsWalkContinuation
  /**
   * The secret variables' values served for this start (#2998), carried in the
   * run's dispatch and never kept; the plain ones come from the run's record
   * (ctx.runVariables). Absent, a definition reading a secret is refused.
   */
  secretValues?: Readonly<Record<string, string>>
}

/** The end with its error masked of every secret the run was given (#2998). */
function maskedEnd(end: RunBodyEnd, secrets: Readonly<Record<string, string>>): RunBodyEnd {
  return 'error' in end && typeof end.error === 'string' ? { ...end, error: maskSecrets(end.error, secrets) as string } : end
}

export async function walkOpsDefinition(
  definition: unknown, run: RunContext, handlers: Readonly<Record<string, OpsStepHandler>>, options: OpsWalkOptions = {},
): Promise<RunBodyEnd> {
  /** The secrets the run was given, set once they are known; every end's error is masked of them. */
  const given: { secrets: Record<string, string> } = { secrets: {} }
  return maskedEnd(await walk(definition, run, handlers, options, given), given.secrets)
}

async function walk(
  definition: unknown, run: RunContext, handlers: Readonly<Record<string, OpsStepHandler>>, options: OpsWalkOptions, masking: { secrets: Record<string, string> },
): Promise<RunBodyEnd> {
  if (!isRecord(definition) || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) {
    return failed('the definition is not nodes and edges, so nothing was run')
  }
  const nodes = definition.nodes as NodeDefinition[]
  const edges = definition.edges as EdgeDefinition[]
  if (nodes.length === 0) return failed('the definition has no step, so nothing was run')

  const unrunnable = [...new Set(nodes.map((n) => String(n.type)).filter((t) => !Object.hasOwn(IN_MEMORY, t) && !Object.hasOwn(handlers, t)))]
  if (unrunnable.length > 0) {
    return failed(`an ops run cannot take a step of type ${unrunnable.join(', ')} yet, so nothing was run`)
  }
  // Steps and edge conditions alike resolve against the run's environment: what it read when it started.
  const given = runVariablesFor(envReferences(definition), run.runVariables ?? null, options.secretValues ?? {})
  if ('refused' in given) return failed(given.refused)
  masking.secrets = given.secrets
  const secrets = given.secrets

  let current: NodeDefinition | undefined
  try {
    current = findEntryNode(nodes, edges)
  } catch {
    return failed('the definition has no entry step, so nothing was run')
  }

  const ctx = buildContext(run.run.payload, run.run.triggerKind, run.run.workflowId, run.executionId, given.env, run.run.organizationId, run.executionId)
  /** Every completed step of the run, across its slices, with the edge it left by (#1951). */
  const path: CheckpointStep[] = []
  /** Steps the whole run has walked: its earlier slices', then this one's. */
  let steps = 0
  let carried: CarriedTotals = NOTHING_CARRIED
  // A continued run resumes from its checkpoint, in every mode (#1951): never from its first step.
  if (run.continuations > 0) {
    const resumed = await resumeFromCheckpoint({ continuation: options.continuation, run, nodes, edges })
    if (resumed.kind === 'end') return resumed.end
    Object.assign(ctx.steps, resumed.at.steps)
    ctx.lastCompletedNamespace = resumed.at.lastCompletedNamespace
    current = resumed.at.next
    steps = resumed.at.walked
    path.push(...resumed.checkpoint.path)
    carried = { computeMs: resumed.checkpoint.totals.computeMs, slices: resumed.checkpoint.totals.slices }
  }
  const firstStep = steps
  // Time sliced continuation (#1951): what this slice has spent.
  const continuation = options.continuation !== undefined && options.continuation.mode !== 'off' ? options.continuation : null
  // The clock is read only when slicing, so a walk with continuation off reads it exactly as before.
  const walkStartedAt = continuation === null ? 0 : run.now()
  const spend: SliceSpend = { startedAt: walkStartedAt, steps: 0, sends: 0 }
  const said = { storeMissing: false, holdsSecret: false }
  // A handler's sends are counted against the slice; otherwise they are the run's own.
  const counted: RunContext = continuation === null ? run : { ...run, send: (s) => { spend.sends++; return run.send(s) } }
  while (current !== undefined) {
    if (steps >= OPS_WALK_MAX_STEPS) {
      return { outcome: 'failed', reason: 'max_steps_exceeded', error: `the run walked ${OPS_WALK_MAX_STEPS} steps, the most one run may` }
    }
    /** Its place in the whole run, as a checkpoint holds it. */
    const place = steps
    /** Its place in this attempt, as its record holds it. */
    const seq = steps - firstStep
    steps++
    const step: NodeDefinition = current
    const name = `step ${step.namespace} (${step.type})`
    const startedAt = run.now()
    /** Records this step (#2703); answers why its record was not kept, or null once it is. RunStopped passes on. */
    const keep = async (status: OpsStepRecordStatus, output: unknown, error: string | null): Promise<string | null> => {
      // Masked before it is measured or kept (#2998): a record never holds a secret's value.
      const kept = status === 'completed' ? keepOutput(maskSecrets(output, secrets)) : { output: null, outputBytes: null }
      try {
        await run.recordStep({
          seq, nodeId: step.id, namespace: step.namespace, stepType: String(step.type), status, startedAt: new Date(startedAt),
          durationMs: Math.max(0, run.now() - startedAt), output: kept.output, outputBytes: kept.outputBytes, error: error === null ? null : clipError(maskSecrets(error, secrets) as string),
        })
        return null
      } catch (err) {
        if (err instanceof StepUnrecorded) return err.reason
        throw err
      }
    }
    /** A step that ended the run is recorded failed; the run ends as it said, with a record not kept named too. */
    const endedBy = async (end: StepEnd): Promise<RunBodyEnd> => {
      const why = end.error ?? end.outcome
      const unkept = await keep('failed', null, why)
      return unkept === null ? end : { ...end, error: `${why}; its step record was not kept either (${unkept})` }
    }
    let result: StepExecutionResult
    // Own keys only, as the up front check reads them: a type named like an inherited property is a handler's.
    const inMemory = Object.hasOwn(IN_MEMORY, step.type)
    try {
      result = inMemory ? IN_MEMORY[step.type](step, ctx) : await handlers[step.type]({ node: step, ctx, run: counted })
    } catch (err) {
      if (err instanceof RunStopped) throw err
      if (err instanceof StepEndsRun) return endedBy({ ...err.end, error: `${name}: ${err.end.error ?? err.end.outcome}` })
      return endedBy(failed(`${name}: ${formatErr(err)}`))
    }
    if (result.error !== undefined) return endedBy(failed(`${name}: ${result.error}`))
    // Recorded before the next step runs, so the run never goes on past a step it has no record of.
    const unkept = await keep('completed', result.output, null)
    if (unkept !== null) return { outcome: 'retry', error: `${name}: its step record was not kept (${unkept}), so the run stopped after it` }
    ctx.steps[step.namespace] = { output: result.output, status: 'completed' }
    ctx.lastCompletedNamespace = step.namespace
    if (result.earlyExit) return { outcome: 'done' }

    const out = outgoingEdges(step.id, edges)
    // Only an in memory step routes by _route: a handler's output carries an
    // outside answer, which must never pick the next step.
    const route = inMemory && isRecord(result.output) && typeof result.output._route === 'string' ? result.output._route : null
    // A routing step goes where its route says, and nowhere when that handle is not wired (a filter's exit).
    const next = route !== null ? out.find((e) => e.source_handle === route) : out.find((e) => evaluateEdge(e, ctx))
    current = next === undefined ? undefined : findNode(next.target, nodes)

    // A slice boundary (#1951) falls between two steps: this one recorded, the next not begun.
    if (continuation !== null && next !== undefined && current !== undefined) {
      path.push({ seq: place, nodeId: step.id, namespace: step.namespace, output: result.output, edgeId: next.id })
      spend.steps++
      if (overBudget(continuation.budget, spend, run.now())) {
        // A checkpoint is written to R2, so one that would hold a secret is never written (#2998): the slice carries on.
        if (holdsSecret(path, secrets)) {
          if (!said.holdsSecret) {
            try {
              continuation.log({ event: 'ops_continuation', step: 'checkpoint_skipped', reason: 'holds_secret', run_request_id: run.run.runRequestId, workflow_id: run.run.workflowId, steps: path.length })
            } catch {
              // A log line never changes how the run goes.
            }
          }
          said.holdsSecret = true
        } else {
          const verdict = await checkpointBoundary({ continuation, run, nodes, edges, path, next: current, ctx, spend, walkStartedAt, carried, said })
          // Suspended only once its checkpoint is named and verified; otherwise the slice carries on.
          if (verdict === 'verified' && continuation.mode === 'on') return { outcome: 'continue' }
        }
        Object.assign(spend, { startedAt: run.now(), steps: 0, sends: 0 })
      }
    }
  }
  return { outcome: 'done' }
}
