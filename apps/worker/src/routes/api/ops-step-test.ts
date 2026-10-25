/**
 * Testing an ops workflow's app_action step from the canvas (#2339, phase 9 of
 * #1689), on behalf of routes/api/workflows.ts: POST test-node forwards the step
 * to the ops Worker's testStep, and GET test-results reads the kept result back
 * for the data picker, both through OPS_CONNECTIONS (lib/ops-connections-client.ts).
 *
 * Dan decided on 2026-10-23 (recorded on #2339): a step's test result is kept
 * in the ops database only, the latest per step, for 7 days, and read back
 * through the ops connection. So this Worker writes nothing: it only asks ops.
 *
 * WHO MAY CALL IT. A signed in person, for a workflow of their own organization
 * stored in the ops lane: workflows.ts finds the row by its id and the
 * organization from the verified JWT before calling here (404 otherwise), and
 * every request to ops names that organization, which ops scopes to.
 *
 * WHOSE ACCOUNT. The step is stamped as bound by the person testing, whatever
 * the browser sent, so the executor's own account rule (app-action.ts) lets a
 * person's own account be tested only by its owner.
 *
 * A TEST SENDS FOR REAL. Ops refuses a step that changes something in its
 * service unless confirm_send is true (step_test_send_unconfirmed, 409 here).
 */
import type { Context } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { callOpsStepTest, isOpsConnectionsUnavailable, OPS_CONNECTIONS_UNAVAILABLE_STATUS } from '../../lib/ops-connections-client'
import type { OpsConnectionsRefused, StepTestView } from '../../lib/ops-connections-contract'
import { stepTestRows } from '../../lib/step-test-rows'

type Ctx = Context<{ Bindings: Env; Variables: AuthVariables }>

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The picker's rows beside the kept result; a failure has none. */
function withRows(result: StepTestView) {
  const { rows, truncated } = result.status === 'completed' && result.output !== null ? stepTestRows(result.namespace, result.output) : { rows: [], truncated: false }
  return { ...result, rows, rows_truncated: truncated }
}

function refusedAnswer(c: Ctx, answer: OpsConnectionsRefused): Response {
  switch (answer.refused) {
    case 'step_test_send_unconfirmed':
      return c.json({
        error: answer.refused,
        message: 'This step changes something in the service, so testing it sends for real. Nothing was sent. Confirm the send to test it.',
      }, 409)
    case 'ops_connections_request_invalid':
      return c.json({ error: answer.refused, message: `The test could not be read: ${answer.detail}. Nothing was sent.` }, 400)
    case 'step_test_unavailable':
      return c.json({ error: answer.refused, message: 'The step\'s test result could not be read. Try again in a moment.' }, 503)
    default:
      return c.json({ error: answer.refused, message: answer.detail }, 502)
  }
}

/** POST test-node for an ops workflow's app_action step. `node` is the step as the canvas holds it. */
export async function testOpsStep(c: Ctx, workflowId: string, body: Record<string, unknown>, node: { id: string; namespace: string; config: unknown }): Promise<Response> {
  const { orgId, userId } = c.get('user')
  if (body.execution_id !== undefined && body.execution_id !== null) {
    return c.json({
      error: 'step_test_from_run_unsupported',
      message: 'An ops workflow\'s runs are kept on ops, so its steps are tested with an example payload, not a past run. Nothing was sent.',
    }, 400)
  }
  const config = isRecord(node.config) ? node.config : {}
  const answer = await callOpsStepTest(c.env, 'testStep', {
    organization_id: orgId,
    workflow_id: workflowId,
    tested_by: userId,
    // The person testing is the step's binder, whatever the browser sent (app-action-binders.ts holds the same for a save).
    node: { id: node.id, namespace: node.namespace, config: { ...config, boundBy: userId } },
    trigger_payload: body.trigger_payload ?? {},
    steps: isRecord(body.steps) ? (body.steps as Record<string, { output: unknown; status: string }>) : {},
    confirm_send: body.confirm_send === true,
  })
  if (isOpsConnectionsUnavailable(answer)) {
    return c.json({ error: answer.refused, cause: answer.cause, message: answer.detail }, OPS_CONNECTIONS_UNAVAILABLE_STATUS)
  }
  if (!answer.ok) return refusedAnswer(c, answer)
  const result = withRows(answer.result)
  return c.json({
    output: result.output,
    status: result.status,
    error_message: result.error,
    duration_ms: result.duration_ms,
    tested_at: result.tested_at,
    output_bytes: result.output_bytes,
    requests: result.requests,
    recorded: answer.recorded,
    rows: result.rows,
    rows_truncated: result.rows_truncated,
  })
}

/** GET test-results for one step of an ops workflow: the kept result, or null once there is none under 7 days old. */
export async function readOpsStepTest(c: Ctx, workflowId: string, nodeId: string): Promise<Response> {
  const { orgId } = c.get('user')
  const answer = await callOpsStepTest(c.env, 'stepTestResult', { organization_id: orgId, workflow_id: workflowId, node_id: nodeId })
  if (isOpsConnectionsUnavailable(answer)) {
    return c.json({ error: answer.refused, cause: answer.cause, message: answer.detail }, OPS_CONNECTIONS_UNAVAILABLE_STATUS)
  }
  if (!answer.ok) return refusedAnswer(c, answer)
  return c.json({ result: answer.result === null ? null : withRows(answer.result) })
}
