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
 * runs on a blank (#2702, Dan's decisions of 2026-10-28): a run is given the
 * plain variables kept with its version at its save (options.variables), and
 * only those its definition reads. A secret variable is refused by name, since
 * an ops run is never given a secret and a credential belongs in a connection;
 * a variable the version did not keep is refused by name as missing; and any
 * variable is refused when the version kept none (saved before they were kept).
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
 * (continuation.ts): in observe mode a checkpoint is written, named, read back
 * and replayed, and the walk carries on. Off, it reads the clock no more than
 * before and keeps nothing.
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
import { envReferences, judgeVariables, namedVariables as named } from '../lib/definition-env-references'
import { formatErr } from '../lib/format-error'
import type { OpsVersionVariables } from '../lib/ops-gateway-contract'
import type { EdgeDefinition, ExecutionContext, NodeDefinition, StepExecutionResult } from '../types'
import type { CheckpointStep } from './checkpoint'
import { observeBoundary, overBudget, type OpsWalkContinuation, type SliceSpend } from './continuation'
import { RunStopped, StepUnrecorded, type RunBodyEnd, type RunContext } from './run-invocation'
import type { OpsStepRecordStatus } from './run-vocabulary'
import { clipError, keepOutput } from './step-output'

/** The most steps one run walks: a loop ends here, failed by name. */
export const OPS_WALK_MAX_STEPS = 200

/** A step that may reach outside the Worker, and only through run.send. */
export type OpsStepHandler = (args: { node: NodeDefinition; ctx: ExecutionContext; run: RunContext }) => Promise<StepExecutionResult>

/**
 * Thrown by a handler whose step decides how the whole run ends rather than
 * failing it (#2339): a retry when nothing it did can have changed anything
 * (a copy it could not read, a GET past its deadline, an idempotent action's
 * unknown outcome), needs_human when a non idempotent send's outcome is
 * unknown. The walk ends the run so, naming the step; invokeRun still turns a
 * retry after a send that cannot be repeated into failed.
 */
export class StepEndsRun extends Error {
  constructor(readonly end: Exclude<RunBodyEnd, { outcome: 'done' }>) {
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

/**
 * The values a run is given: the plain variables kept with its version that
 * its definition reads, or why it can be given none, as the run's error.
 */
function runVariables(definition: Record<string, unknown>, variables: OpsVersionVariables | null, version: number): { env: Record<string, string> } | { refused: string } {
  const reads = envReferences(definition)
  const judged = judgeVariables(reads, variables)
  if (judged.kind === 'given') return { env: judged.env }
  if (judged.kind === 'none_kept') {
    return { refused: `the definition reads ${named(reads)}, and version ${version} was saved before ops kept the values of its variables with it, so nothing was run; save the workflow again` }
  }
  const { secret, missing } = judged
  const secretSaid = `reads the secret ${secret.length === 1 ? 'variable' : 'variables'} ${named(secret)}, and an ops run is never given a secret: a credential an ops step uses belongs in a connection`
  const missingSaid = `${named(missing)}, which ${missing.length === 1 ? 'was not a variable' : 'were not variables'} of this workflow when version ${version} was saved, so nothing was run`
  if (secret.length > 0 && missing.length > 0) return { refused: `the definition ${secretSaid}; and it reads ${missingSaid}` }
  if (secret.length > 0) return { refused: `the definition ${secretSaid}, so nothing was run` }
  return { refused: `the definition reads ${missingSaid}; add ${missing.length === 1 ? 'it' : 'them'} and save the workflow again` }
}

export interface OpsWalkOptions {
  /** Time sliced continuation (#1951): absent or off, the walk never stops at a boundary. */
  continuation?: OpsWalkContinuation
  /** The variables kept with the run's version (#2702); absent or null, a definition reading any is refused. */
  variables?: OpsVersionVariables | null
}

export async function walkOpsDefinition(
  definition: unknown, run: RunContext, handlers: Readonly<Record<string, OpsStepHandler>>, options: OpsWalkOptions = {},
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
  // Steps and edge conditions alike resolve against the run's environment: only what the version kept.
  const given = runVariables(definition, options.variables ?? null, run.run.workflowVersion)
  if ('refused' in given) return failed(given.refused)

  let current: NodeDefinition | undefined
  try {
    current = findEntryNode(nodes, edges)
  } catch {
    return failed('the definition has no entry step, so nothing was run')
  }

  const ctx = buildContext(run.run.payload, run.run.triggerKind, run.run.workflowId, run.executionId, given.env, run.run.organizationId, run.executionId)
  // Time sliced continuation (#1951): what this slice has spent, and every completed step with the edge it left by.
  const continuation = options.continuation !== undefined && options.continuation.mode !== 'off' ? options.continuation : null
  // The clock is read only when slicing, so a walk with continuation off reads it exactly as before.
  const walkStartedAt = continuation === null ? 0 : run.now()
  const spend: SliceSpend = { startedAt: walkStartedAt, steps: 0, sends: 0 }
  const path: CheckpointStep[] = []
  const said = { storeMissing: false }
  // A handler's sends are counted against the slice; otherwise they are the run's own.
  const counted: RunContext = continuation === null ? run : { ...run, send: (s) => { spend.sends++; return run.send(s) } }
  let steps = 0
  while (current !== undefined) {
    if (steps >= OPS_WALK_MAX_STEPS) {
      return { outcome: 'failed', reason: 'max_steps_exceeded', error: `the run walked ${OPS_WALK_MAX_STEPS} steps, the most one run may` }
    }
    const seq = steps
    steps++
    const step: NodeDefinition = current
    const name = `step ${step.namespace} (${step.type})`
    const startedAt = run.now()
    /** Records this step (#2703); answers why its record was not kept, or null once it is. RunStopped passes on. */
    const keep = async (status: OpsStepRecordStatus, output: unknown, error: string | null): Promise<string | null> => {
      const kept = status === 'completed' ? keepOutput(output) : { output: null, outputBytes: null }
      try {
        await run.recordStep({
          seq, nodeId: step.id, namespace: step.namespace, stepType: String(step.type), status, startedAt: new Date(startedAt),
          durationMs: Math.max(0, run.now() - startedAt), output: kept.output, outputBytes: kept.outputBytes, error: error === null ? null : clipError(error),
        })
        return null
      } catch (err) {
        if (err instanceof StepUnrecorded) return err.reason
        throw err
      }
    }
    /** A step that ended the run is recorded failed; the run ends as it said, with a record not kept named too. */
    const endedBy = async (end: Exclude<RunBodyEnd, { outcome: 'done' }>): Promise<RunBodyEnd> => {
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
      path.push({ seq, nodeId: step.id, namespace: step.namespace, output: result.output, edgeId: next.id })
      spend.steps++
      if (overBudget(continuation.budget, spend, run.now())) {
        await observeBoundary({ continuation, run, nodes, edges, path, next: current, ctx, spend, walkStartedAt, said })
        Object.assign(spend, { startedAt: run.now(), steps: 0, sends: 0 })
      }
    }
  }
  return { outcome: 'done' }
}
