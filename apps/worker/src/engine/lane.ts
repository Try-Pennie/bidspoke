/**
 * Lane checks for a run (#1707, plan 0.C). A workflow is stored under a lane,
 * money or ops, and the Worker running it serves one lane. Both refusals happen
 * before an execution row is written or a node runs, so a misrouted workflow
 * leaves no half recorded run behind.
 *
 * The walk holds the same line again on every node it reaches (#1725), through
 * laneRefusalFor, so code that reaches walkGraph without the entry check still
 * cannot run a node its lane does not allow.
 */
import { isNodeType, isWorkflowLane, nodeTypeRunsInLane, type WorkflowLane } from '@bidspoke/node-types'
import type { WorkflowDefinition } from '../types'

/** A node type the workflow's lane may not run: an ops workflow never reaches a money executor. */
export class LaneRefusedNodeError extends Error {
  /** Read by the retry classifier: a refusal is the same on every attempt. */
  readonly permanent = true

  constructor(readonly nodeType: string, readonly lane: WorkflowLane) {
    super(`Node type ${nodeType} cannot run in the ${lane} lane`)
    this.name = 'LaneRefusedNodeError'
  }
}

/** A workflow stored under a lane this Worker does not serve. */
export class WorkflowLaneError extends Error {
  constructor(readonly workflowId: string, readonly workflowLane: WorkflowLane, readonly workerLane: WorkflowLane) {
    super(`Workflow ${workflowId} runs in the ${workflowLane} lane, not ${workerLane}`)
    this.name = 'WorkflowLaneError'
  }
}

/**
 * The refusal for one node type in a lane, or null when the lane may run it.
 * A type this build has never heard of is left to the executor, which fails
 * loud on it by name when the walk reaches it, as it always has.
 */
export function laneRefusalFor(type: string, lane: WorkflowLane): LaneRefusedNodeError | null {
  return isNodeType(type) && !nodeTypeRunsInLane(type, lane) ? new LaneRefusedNodeError(type, lane) : null
}

/** Refuses a definition carrying a node type its lane cannot run. */
export function assertDefinitionRunsInLane(definition: WorkflowDefinition, lane: WorkflowLane): void {
  for (const node of definition.nodes) {
    const refusal = laneRefusalFor(node.type, lane)
    if (refusal) throw refusal
  }
}

/**
 * Refuses a workflow stored under a lane other than the one this Worker serves.
 * The one predicate for that question: the engine asks it of the loaded
 * definition, and a dashboard route asks it of the row it already read, so it
 * can refuse before doing any work of its own (#1725). A stored value that is
 * no lane at all is refused by name rather than guessed.
 */
export function assertWorkflowServedInLane(workflowId: string, storedLane: unknown, workerLane: WorkflowLane): void {
  if (!isWorkflowLane(storedLane)) throw new Error(`Workflow ${workflowId} has unknown lane ${JSON.stringify(storedLane)}`)
  if (storedLane !== workerLane) throw new WorkflowLaneError(workflowId, storedLane, workerLane)
}
