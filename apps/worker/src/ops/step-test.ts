/**
 * The ops step test (#2339, phase 9 of #1689): one app_action step of an ops
 * workflow run for real, through the same executor a run uses (app-action.ts)
 * and connectionFetch, and its result kept on the ops database.
 *
 * Dan decided on 2026-10-23 (recorded on #2339): a step's test result is kept
 * in the ops database only, never the bidding database; only the latest result
 * per step is kept, deleted 7 days after the test (the nightly purge, and the
 * reader serves nothing older); it is read back for the data picker through the
 * ops connection, with the token removal rule applied before it is stored.
 *
 * WHO CALLS IT. The OpsConnections entrypoint's testStep and stepTestResult,
 * called by the bidding Worker's test-node and test result routes for a signed
 * in person of the organization the request names (routes/api/workflows.ts).
 * That route stamps the step's boundBy with the person testing, so a person's
 * own account is tested only by its owner: the executor's own comparison.
 *
 * A TEST SENDS FOR REAL. An action that changes something in the service
 * (sideEffect in the catalogue) runs only when the request says the person
 * confirmed it (confirm_send); otherwise it is refused as step_test_send_unconfirmed
 * and nothing is sent or kept. A read runs without asking.
 *
 * NOT A RUN. A test has no run request, so no lease and no send ledger: each
 * request goes straight to connectionFetch under its own deadline, and the
 * whole test under the entrypoint's ceiling. A send whose outcome is unknown is
 * never repeated here; the result says it may have been applied.
 *
 * WHAT IS KEPT. The answer (scrubbed by connectionFetch of the connection's
 * secrets before the action ever sees it), each request as connectionFetch
 * sanitised it before applying the login, the status, the error and the time
 * taken. An answer over STEP_TEST_OUTPUT_MAX_BYTES is kept by its size alone.
 */
import { readAppActionConfig } from '@bidspoke/service-catalogue/schema'
import { buildContext } from '../engine/context'
import { formatErr } from '../lib/format-error'
import type { StepTestResultAnswer, StepTestResultRequest, StepTestView, TestStepAnswer, TestStepRequest } from '../lib/ops-connections-contract'
import type { NodeDefinition, StepOutput } from '../types'
import { appActionHandler, type AppActionDeps } from './app-action'
import type { RecordedRequest } from './connections/sanitise'
import { organizationIdFrom, type OrganizationId } from './ops-db'
import type { ClaimedRun, StepTestRecord, StoredStepTest } from './ops-writes'
import { RunStopped, StepNotSent, stepRequestId, type RunContext, type StepSend } from './run-invocation'
import { StepEndsRun } from './run-walk'
import { STEP_OUTPUT_MAX_BYTES, byteLength, clip, clipError, keepOutput } from './step-output'

/** The largest answer kept: the one cap a run's step records share (step-output.ts, #2703). */
export const STEP_TEST_OUTPUT_MAX_BYTES = STEP_OUTPUT_MAX_BYTES

/** The requests kept, in bytes of JSON: the database's 64 KB, by the same half again margin. */
export const STEP_TEST_REQUESTS_MAX_BYTES = 40_000

/** One request's body is kept to this many characters. */
const REQUEST_BODY_MAX = 2_000

export interface StepTestDeps {
  /** The executor's dependencies, as a run's (run-live.ts). */
  appAction: AppActionDeps
  /** record_step_test: answers when it was recorded. */
  record(organizationId: OrganizationId, workflowId: string, result: StepTestRecord): Promise<string>
  /** step_test_result: null when the step has none under 7 days old. */
  read(organizationId: OrganizationId, workflowId: string, nodeId: string): Promise<StoredStepTest | null>
  now(): number
  /** A fresh id per test: the step request ids the action hands the service derive from it. */
  newRunId(): string
}

/** Collects each sanitised request, keeping what fits and counting what does not. */
function requestCollector(): { record: (request: RecordedRequest) => Promise<void>; kept: () => unknown[] } {
  const kept: unknown[] = []
  let bytes = 2
  let omitted = 0
  return {
    record: (request) => {
      const entry = { ...request, body: request.body === null ? null : clip(request.body, REQUEST_BODY_MAX) }
      const size = byteLength(entry) + 1
      // Room is left for the closing count of what was not kept.
      if (omitted > 0 || bytes + size > STEP_TEST_REQUESTS_MAX_BYTES - 64) {
        omitted++
        return Promise.resolve()
      }
      kept.push(entry)
      bytes += size
      return Promise.resolve()
    },
    kept: () => (omitted > 0 ? [...kept, { omitted }] : [...kept]),
  }
}

/** The run a test's step sees: its organization, workflow and a fresh id. No lease, no ledger. */
function testRun(request: TestStepRequest, organizationId: OrganizationId, runRequestId: string, now: number): ClaimedRun {
  return {
    runRequestId, organizationId, workflowId: request.workflow_id, workflowVersion: 0, triggerKind: 'step_test', claimToken: 'step-test',
    claimExpiresAt: new Date(now).toISOString(), stateVersion: 0, attempts: 1, unchargedAttempts: 0, maxAttempts: 1, resumeReason: null,
    executionChainId: runRequestId, resumedFromExecutionId: null, payload: request.trigger_payload, payloadRef: null,
  }
}

function testContext(run: ClaimedRun, signal: AbortSignal, now: () => number): RunContext {
  return {
    run,
    executionId: run.runRequestId,
    attempt: 1,
    signal,
    now,
    // A test keeps its result as a test (record_step_test), never as a run's step; the executor never records.
    recordStep: () => Promise.reject(new Error('a step test keeps its result as a test result, not as a run step')),
    async send<T>(step: StepSend<T>) {
      if (signal.aborted) throw new RunStopped()
      let answer
      try {
        answer = await step.forward({ signal, requestId: await stepRequestId(run.runRequestId, step.nodeId, step.seq) })
      } catch (err) {
        if (signal.aborted) throw new RunStopped()
        // A failure after the request may have left: never repeated in a test, and never read as not sent.
        throw new Error(step.method === 'GET' ? formatErr(err) : `${formatErr(err)}; the ${step.method} may have reached the service and been applied`, { cause: err })
      }
      if (answer.kind === 'answered') return { status: answer.status, value: answer.value }
      if (answer.kind === 'not_sent') throw new StepNotSent(step.nodeId, answer.reason)
      throw new StepNotSent(step.nodeId, `the service asked to wait until ${answer.notBefore.toISOString()} (${answer.cause}), so test again after then`)
    },
  }
}

function view(stored: StoredStepTest): StepTestView {
  return {
    node_id: stored.nodeId, namespace: stored.namespace, tested_by: stored.testedBy, tested_at: stored.testedAt, status: stored.status,
    output: stored.output, output_bytes: stored.outputBytes, error: stored.error, requests: stored.requests, duration_ms: stored.durationMs,
  }
}

/** Runs one step for real and keeps its result. Every answer is a value. */
export async function runStepTest(deps: StepTestDeps, request: TestStepRequest, signal: AbortSignal): Promise<TestStepAnswer> {
  const organizationId = organizationIdFrom(request.organization_id)

  // Ask first for an action that changes something in the service. Settings that cannot be
  // read, or a version the catalogue lacks, fall through to the executor, which names them.
  const settings = readAppActionConfig(request.node.config)
  if (settings.ok) {
    const resolved = deps.appAction.resolveAction(settings.config.action, settings.config.actionVersion)
    if (resolved.ok && resolved.action.sideEffect && !request.confirm_send) {
      return {
        ok: false, refused: 'step_test_send_unconfirmed', retry_at: null,
        detail: `${settings.config.action} changes something in the service, so testing it sends for real; confirm the send to test it`,
      }
    }
  }

  const collector = requestCollector()
  const handler = appActionHandler({ ...deps.appAction, record: collector.record })
  const started = deps.now()
  const run = testRun(request, organizationId, deps.newRunId(), started)
  const ctx = buildContext(request.trigger_payload, 'step_test', request.workflow_id, run.runRequestId, {}, organizationId, run.runRequestId)
  ctx.steps = Object.fromEntries(Object.entries(request.steps).map(([namespace, step]) => [namespace, { output: step.output, status: step.status as StepOutput['status'] }]))
  const node: NodeDefinition = { id: request.node.id, namespace: request.node.namespace, type: 'app_action', config: request.node.config }

  let output: unknown = null
  let error: string | null = null
  try {
    const result = await handler({ node, ctx, run: testContext(run, signal, deps.now) })
    if (result.error) error = result.error
    else output = result.output ?? null
  } catch (err) {
    if (err instanceof StepEndsRun) error = err.message
    else if (err instanceof RunStopped) error = 'the test was stopped before the step finished'
    else error = formatErr(err)
  }

  // Only an answer over the cap is kept by its size; a plain null answer is kept as null.
  const kept = error === null ? keepOutput(output) : null
  const outputBytes = kept === null ? null : kept.bytes
  const result: StepTestRecord = {
    nodeId: request.node.id,
    namespace: request.node.namespace,
    testedBy: request.tested_by,
    status: error === null ? 'completed' : 'failed',
    output: kept === null ? null : kept.output,
    outputBytes: kept === null ? null : kept.outputBytes,
    error: error === null ? null : clipError(error),
    requests: collector.kept(),
    durationMs: Math.max(0, deps.now() - started),
  }

  let testedAt: string
  let recorded = true
  try {
    testedAt = await deps.record(organizationId, request.workflow_id, result)
  } catch (err) {
    recorded = false
    testedAt = new Date(deps.now()).toISOString()
    // Names only: the workflow, the step and the kind of failure, never the result.
    console.warn(JSON.stringify({ event: 'step_test_unrecorded', organization_id: organizationId, workflow_id: request.workflow_id, node_id: request.node.id, error_kind: err instanceof Error ? err.name : 'unknown' }))
  }
  return {
    ok: true,
    recorded,
    result: { ...view({ ...result, testedAt }), output_bytes: outputBytes },
  }
}

/** One step's kept result, or null. A read that fails is refused by name, never answered as none. */
export async function readStepTest(deps: StepTestDeps, request: StepTestResultRequest): Promise<StepTestResultAnswer> {
  let stored: StoredStepTest | null
  try {
    stored = await deps.read(organizationIdFrom(request.organization_id), request.workflow_id, request.node_id)
  } catch (err) {
    return { ok: false, refused: 'step_test_unavailable', retry_at: null, detail: `the step's test result could not be read (${err instanceof Error ? err.name : 'an unexpected error'})` }
  }
  return { ok: true, result: stored === null ? null : view(stored) }
}
