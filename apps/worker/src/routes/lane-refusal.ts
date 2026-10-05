/**
 * How every route answers a run refused for its lane (#1707, #1725). One home,
 * so the public routes and the dashboard routes keep one vocabulary.
 *
 * A workflow stored under a lane this Worker does not serve is 421, on every
 * route. The public routes (webhooks, custom endpoints) tell the sender only
 * that it reached the wrong place, since an outside caller is never shown
 * anything internal (#107). The dashboard routes are behind sign in, so the
 * person who pressed Test, Resume or Replay is told in plain words what is
 * wrong and that nothing ran. A definition carrying a step its lane cannot run
 * is 422 there: the workflow is in the right place, its content is what cannot
 * run.
 */
import type { Context } from 'hono'
import type { WorkflowLane } from '@bidspoke/node-types'
import { assertWorkflowServedInLane, LaneRefusedNodeError, WorkflowLaneError } from '../engine/lane'

export const WRONG_LANE_STATUS = 421
export const STEP_OUTSIDE_LANE_STATUS = 422

/** What a public caller is told for a workflow stored under another lane. */
export const PUBLIC_WRONG_LANE_ERROR = 'Workflow is not served on this host'

const A_WORKFLOW_OF: Record<WorkflowLane, string> = {
  money: 'a money workflow',
  ops: 'an ops workflow',
}

// Both refusals happen in the engine before an execution row is written, and
// the routes' own check comes before any deploy, so this is true of each.
const NOTHING_RAN = 'Nothing was run and no execution was recorded.'

/** The dashboard's answer for a lane refusal, or null when err is not one. */
export function dashboardLaneRefusal(c: Context, err: unknown): Response | null {
  if (err instanceof WorkflowLaneError) {
    return c.json(
      { error: `This workflow is stored as ${A_WORKFLOW_OF[err.workflowLane]}, and this server runs only ${err.workerLane} workflows. ${NOTHING_RAN}` },
      WRONG_LANE_STATUS,
    )
  }
  if (err instanceof LaneRefusedNodeError) {
    return c.json(
      { error: `This workflow has a step of type ${err.nodeType}, which ${err.lane} workflows cannot run. ${NOTHING_RAN}` },
      STEP_OUTSIDE_LANE_STATUS,
    )
  }
  return null
}

/**
 * Refuses, from the workflow row a dashboard route already read, a workflow
 * stored under a lane this Worker does not serve, so the route stops before
 * work of its own (a code deploy, a node run) rather than after it. Asks the
 * engine's own predicate. A stored value that is no lane at all is not a lane
 * refusal: it is rethrown, to fail as the defect it is.
 */
export function refuseRowOutsideLane(c: Context, workflowId: string, storedLane: unknown, workerLane: WorkflowLane): Response | null {
  try {
    assertWorkflowServedInLane(workflowId, storedLane, workerLane)
    return null
  } catch (err) {
    const refused = dashboardLaneRefusal(c, err)
    if (refused) return refused
    throw err
  }
}
