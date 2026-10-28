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
 *
 * ITS VARIABLES (#2702). A step reading env.X is given the plain values the
 * workflow's newest saved version kept, as a run of it would be: this Worker
 * reads that version and sends them with the step, and ops refuses by name a
 * secret variable or one the version did not keep.
 *
 * FROM A PAST RUN (#2339, #2703). With an execution_id, ops rebuilds the step's
 * context from that run's payload and recorded step outputs, within the
 * organization, and refuses by name a run it cannot rebuild it from (gone after
 * 7 days, not this workflow's, a step it reads not recorded); each is worded
 * here. A payload or steps the browser gives replace the run's.
 */
import type { Context } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { callOpsConnections, isOpsConnectionsUnavailable, OPS_CONNECTIONS_UNAVAILABLE_STATUS } from '../../lib/ops-connections-client'
import type { OpsConnectionsRefused, StepTestView, TestStepCall } from '../../lib/ops-connections-contract'
import { envReferences } from '../../lib/definition-env-references'
import { formatErr } from '../../lib/format-error'
import { createSupabaseClient } from '../../lib/supabase'
import { servedVersionVariables } from '../../lib/version-variables'
import { sampleRows } from '@bidspoke/references'
import { isUuid } from '../../lib/query-validators'

type Ctx = Context<{ Bindings: Env; Variables: AuthVariables }>

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The picker's rows beside the kept result; a failure has none. */
function withRows(result: StepTestView) {
  const { rows, truncated } = result.status === 'completed' && result.output !== null ? sampleRows(`steps.${result.namespace}.output`, result.output) : { rows: [], truncated: false }
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
    // A test from a past run (#2703). ops names the step ids in the detail; the person gets the remedy.
    case 'step_test_run_not_found':
      return c.json({ error: answer.refused, message: 'That run is not one of this workflow\'s runs on ops. Nothing was sent. Test with an example payload, or pick another run.' }, 404)
    case 'step_test_run_records_gone':
      return c.json({ error: answer.refused, message: 'That run is more than 7 days old, so its step records are gone. Nothing was sent. Test with an example payload, or pick a newer run.' }, 410)
    case 'step_test_run_steps_missing':
      return c.json({ error: answer.refused, detail: answer.detail, message: 'That run did not record every earlier step this one reads. Nothing was sent. Pick a run that reached this step.' }, 409)
    case 'step_test_run_output_not_kept':
      return c.json({ error: answer.refused, detail: answer.detail, message: 'That run kept only the size of an output this step reads. Nothing was sent. Test with an example payload instead.' }, 409)
    case 'step_test_run_payload_not_held':
      return c.json({ error: answer.refused, message: 'That run\'s payload is not held where a test can read it. Nothing was sent. Give a payload to test with.' }, 409)
    case 'step_test_run_unavailable':
      return c.json({ error: answer.refused, message: 'That run\'s step records could not be read. Nothing was sent. Try again in a moment.' }, 503)
    // A variable the step cannot be given (#2702): ops names each in the sentence it gives.
    case 'step_test_variable_unavailable':
      return c.json({ error: answer.refused, message: `${answer.detail.charAt(0).toUpperCase()}${answer.detail.slice(1)}.` }, 409)
    default:
      return c.json({ error: answer.refused, message: answer.detail }, 502)
  }
}

/**
 * The workflow's newest saved version and the variables kept with it that the
 * step reads (#2702), which ops gives the step as a run of that version would
 * be given them; null when the workflow has no saved version. Read only for a
 * step that reads a variable. Throws on a failed read or kept variables it
 * cannot read, so the test is refused rather than sent with blanks.
 */
async function newestVersionFor(c: Ctx, workflowId: string, step: Record<string, unknown>): Promise<TestStepCall['version']> {
  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase
    .from('workflow_versions')
    .select('version_number, env_capture')
    .eq('workflow_id', workflowId)
    .order('version_number', { ascending: false })
    .limit(1)
  if (error) throw new Error(`the workflow's saved versions could not be read (${error.code ?? 'no code'}): ${error.message}`)
  const newest = (data ?? [])[0] as { version_number: number; env_capture: unknown } | undefined
  if (newest === undefined) return null
  const variables = servedVersionVariables(newest.env_capture, workflowId, { nodes: [step], edges: [] }, `workflow ${workflowId} version ${newest.version_number}`)
  return { number: newest.version_number, variables }
}

/** POST test-node for an ops workflow's app_action step. `node` is the step as the canvas holds it. */
export async function testOpsStep(c: Ctx, workflowId: string, body: Record<string, unknown>, node: { id: string; namespace: string; config: unknown }): Promise<Response> {
  const { orgId, userId } = c.get('user')
  const fromRun = body.execution_id !== undefined && body.execution_id !== null
  if (fromRun && (typeof body.execution_id !== 'string' || !isUuid(body.execution_id))) {
    return c.json({ error: 'execution_id_invalid', message: 'The run to test with is not one this page can name. Nothing was sent.' }, 400)
  }
  const config = isRecord(node.config) ? node.config : {}
  const steps = isRecord(body.steps) ? (body.steps as Record<string, { output: unknown; status: string }>) : null
  const step = { id: node.id, namespace: node.namespace, type: 'app_action', config }
  let version: TestStepCall['version'] | undefined
  if (envReferences({ nodes: [step], edges: [] }).length > 0) {
    try {
      version = await newestVersionFor(c, workflowId, step)
    } catch (err) {
      console.error(`[ops-step-test] the variables of workflow ${workflowId} could not be read: ${formatErr(err)}`)
      return c.json({ error: 'step_test_variables_unavailable', message: 'The workflow\'s saved variables could not be read, so this step could not be given them. Nothing was sent. Try again in a moment.' }, 503)
    }
  }
  const answer = await callOpsConnections(c.env, 'testStep', {
    organization_id: orgId,
    workflow_id: workflowId,
    tested_by: userId,
    // The person testing is the step's binder, whatever the browser sent (app-action-binders.ts holds the same for a save).
    node: { id: node.id, namespace: node.namespace, config: { ...config, boundBy: userId } },
    // From a past run (#2703), ops rebuilds the context from that run's records; what the browser gave replaces the run's.
    ...(fromRun
      ? {
        execution_id: body.execution_id as string,
        ...(body.trigger_payload !== undefined && body.trigger_payload !== null ? { trigger_payload: body.trigger_payload } : {}),
        ...(steps !== null ? { steps } : {}),
      }
      : { trigger_payload: body.trigger_payload ?? {}, steps: steps ?? {} }),
    confirm_send: body.confirm_send === true,
    ...(version !== undefined ? { version } : {}),
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
    output_dropped: result.output_dropped,
    requests: result.requests,
    recorded: answer.recorded,
    rows: result.rows,
    rows_truncated: result.rows_truncated,
  })
}

/** GET test-results for one step of an ops workflow: the kept result, or null once there is none under 7 days old. */
export async function readOpsStepTest(c: Ctx, workflowId: string, nodeId: string): Promise<Response> {
  const { orgId } = c.get('user')
  const answer = await callOpsConnections(c.env, 'stepTestResult', { organization_id: orgId, workflow_id: workflowId, node_id: nodeId })
  if (isOpsConnectionsUnavailable(answer)) {
    return c.json({ error: answer.refused, cause: answer.cause, message: answer.detail }, OPS_CONNECTIONS_UNAVAILABLE_STATUS)
  }
  if (!answer.ok) return refusedAnswer(c, answer)
  return c.json({ result: answer.result === null ? null : withRows(answer.result) })
}
