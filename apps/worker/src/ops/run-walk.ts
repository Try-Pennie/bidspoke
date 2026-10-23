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
 * no step or no entry, names a type nothing runs, or reads an environment
 * variable (env.X): ops runs load none yet, so such a step would run on blanks.
 *
 * HOW IT ENDS. Done when a step has no next edge, an exit or a filter's exit
 * route is reached. Failed, naming the step, when a step reports an error or
 * throws; a step's error is deterministic, so retrying the run would only
 * repeat it. Failed with max_steps_exceeded past OPS_WALK_MAX_STEPS steps (a
 * loop). A step that throws StepEndsRun ends the run as it says (a retry or
 * needs_human), naming the step. RunStopped from ctx.send is passed on, so
 * invokeRun ends the run by the answer that stopped it.
 */
import { buildContext } from '../engine/context'
import { evaluateEdge, findEntryNode, findNode, outgoingEdges } from '../engine/graph'
import { executeBranchNode } from '../engine/nodes/branch'
import { executeFilterNode } from '../engine/nodes/filter'
import { executeResponseNode } from '../engine/nodes/response'
import { executeTransformNode } from '../engine/nodes/transform'
import { formatErr } from '../lib/format-error'
import type { EdgeDefinition, ExecutionContext, NodeDefinition, StepExecutionResult } from '../types'
import { RunStopped, type RunBodyEnd, type RunContext } from './run-invocation'

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

/** Every environment variable a definition reads: env.X as a path, or {{env.X}} in a template. */
function envReferences(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/(?:^|\{\{\s*)env\.([A-Za-z0-9_]+)/g)) found.add(`env.${m[1]}`)
  } else if (Array.isArray(value)) {
    for (const v of value) envReferences(v, found)
  } else if (isRecord(value)) {
    for (const v of Object.values(value)) envReferences(v, found)
  }
  return found
}

const failed = (error: string): RunBodyEnd => ({ outcome: 'failed', error })

export async function walkOpsDefinition(
  definition: unknown, run: RunContext, handlers: Readonly<Record<string, OpsStepHandler>>,
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
  // Steps and edge conditions alike: both resolve against the run's (empty) environment.
  const env = [...envReferences(edges, envReferences(nodes))]
  if (env.length > 0) {
    return failed(`the definition reads ${env.join(', ')}, and ops runs load no environment variables yet, so nothing was run`)
  }

  let current: NodeDefinition | undefined
  try {
    current = findEntryNode(nodes, edges)
  } catch {
    return failed('the definition has no entry step, so nothing was run')
  }

  const ctx = buildContext(run.run.payload, run.run.triggerKind, run.run.workflowId, run.executionId, {}, run.run.organizationId, run.executionId)
  let steps = 0
  while (current !== undefined) {
    if (steps >= OPS_WALK_MAX_STEPS) {
      return { outcome: 'failed', reason: 'max_steps_exceeded', error: `the run walked ${OPS_WALK_MAX_STEPS} steps, the most one run may` }
    }
    steps++
    const step: NodeDefinition = current
    const name = `step ${step.namespace} (${step.type})`
    let result: StepExecutionResult
    // Own keys only, as the up front check reads them: a type named like an inherited property is a handler's.
    const inMemory = Object.hasOwn(IN_MEMORY, step.type)
    try {
      result = inMemory ? IN_MEMORY[step.type](step, ctx) : await handlers[step.type]({ node: step, ctx, run })
    } catch (err) {
      if (err instanceof RunStopped) throw err
      if (err instanceof StepEndsRun) return { ...err.end, error: `${name}: ${err.end.error ?? err.end.outcome}` }
      return failed(`${name}: ${formatErr(err)}`)
    }
    if (result.error !== undefined) return failed(`${name}: ${result.error}`)
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
  }
  return { outcome: 'done' }
}
