/**
 * Lane checks for a run (#1707, plan 0.C). A workflow is stored under a lane,
 * money or ops, and the Worker running it serves one lane. Both refusals happen
 * before an execution row is written or a node runs, so a misrouted workflow
 * leaves no half recorded run behind.
 */
import { isNodeType, nodeTypeRunsInLane, type WorkflowLane } from '@bidspoke/node-types'
import type { WorkflowDefinition } from '../types'

/** A node type the workflow's lane may not run: an ops workflow never reaches a money executor. */
export class LaneRefusedNodeError extends Error {
  constructor(type: string, lane: WorkflowLane) {
    super(`Node type ${type} cannot run in an ${lane} workflow`)
    this.name = 'LaneRefusedNodeError'
  }
}

/** A workflow stored under a lane this Worker does not serve. */
export class WorkflowLaneError extends Error {
  constructor(workflowId: string, workflowLane: WorkflowLane, workerLane: WorkflowLane) {
    super(`Workflow ${workflowId} runs in the ${workflowLane} lane, not ${workerLane}`)
    this.name = 'WorkflowLaneError'
  }
}

/**
 * Refuses a definition carrying a node type its lane cannot run. A type this
 * build has never heard of is left to the executor, which fails loud on it by
 * name when the walk reaches it, as it always has.
 */
export function assertDefinitionRunsInLane(definition: WorkflowDefinition, lane: WorkflowLane): void {
  for (const node of definition.nodes) {
    if (isNodeType(node.type) && !nodeTypeRunsInLane(node.type, lane)) throw new LaneRefusedNodeError(node.type, lane)
  }
}
