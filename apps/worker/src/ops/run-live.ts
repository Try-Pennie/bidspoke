/**
 * OpsInternal.run's live wiring (#1950, PR 4b of B3): one claimed run the tick
 * dispatched, from its signed envelope to the end of its claim.
 *
 * WHO MAY CALL IT. Only this Worker's own minute tick, through the SELF binding
 * to OpsInternal (the public edge reaches only the default export, spike P6),
 * with an envelope signed under the dispatch key (dispatch-auth.ts) and a run
 * item; anything else is refused by name. A replay is refused by the database:
 * the item's claim token is its nonce (dispatch-auth.ts says how).
 *
 * WHOSE DATA. The one organization the claimed run carries: every ops write is
 * an organization scoped function given that organization (ops-writes.ts), and
 * the definition is read and frozen within it.
 *
 * ORDER.
 *  1. The lane, the signature, the item.
 *  2. The run's definition at its recorded version (#1698 1.3: never a newer
 *     one): the frozen copy ops holds (ops_workflow_definitions), else asked of
 *     the bidding Worker and frozen. A run whose definition cannot be had is
 *     returned to the queue RUN_DEFINITION_RETRY_MS on, never started, so it
 *     spends no attempt.
 *  3. invokeRun (run-invocation.ts) with the ops database's own functions,
 *     the real clock, a UUIDv7 execution id, and the body for the definition
 *     (run-body.ts), whose app_action steps send through connectionFetch with
 *     the OpsConnections live dependencies (ops-connections-live.ts, #2339).
 */
import { uuidv7 } from '@bidspoke/uuidv7'
import { parseServedOpsDefinitions } from '../lib/ops-gateway-contract'
import { raceDeadline } from '../lib/alert-claim'
import { formatErr } from '../lib/format-error'
import { dispatchKey, verifyDispatch } from './dispatch-auth'
import type { OpsEnv } from './index'
import { opsInternalIdentity, OpsInternalRefused } from './internal'
import { createOpsSupabaseClient, OpsDatabaseConfigError, organizationIdFrom, type OpsSupabaseClient } from './ops-db'
import {
  completeRunRequest, extendRunLease, readWorkflowDefinition, recordSendIntent, recordSendResult, saveWorkflowDefinition, startRunExecution,
  type ClaimedRun,
} from './ops-writes'
import { appActionDeps } from './app-action'
import { liveOpsConnectionsDeps } from './ops-connections-live'
import { opsStepHandlers, runBodyFor } from './run-body'
import { invokeRun, type RunClock, type RunDb, type RunInvocationReport } from './run-invocation'

/** How long a run whose definition could not be had waits before it is claimed again. */
export const RUN_DEFINITION_RETRY_MS = 60_000
/** The bidding Worker's definition read, as the tick's gateway calls are bounded (tick-live.ts GATEWAY_DEADLINE_MS). */
export const RUN_DEFINITION_FETCH_DEADLINE_MS = 15_000

/** What OpsInternal.run answers: the run's report, a run returned for want of its definition, or a refusal by name. */
export type RunDispatchAnswer =
  | RunInvocationReport
  | { outcome: 'definition_unavailable'; error: string }
  | { refused: string }

export interface RunLiveDeps {
  nowMs: number
  /** For tests: the ops client's fetch. */
  opsFetch?: typeof fetch
  clock?: RunClock
  newExecutionId?: () => string
  delay?: (ms: number) => Promise<void>
}

/** The real clock: a timer that resolves at once when its signal aborts, so none outlives the wait it bounds. */
export const realRunClock: RunClock = {
  now: () => Date.now(),
  timer: (ms, signal) => new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  }),
}

/** The ops database as a run uses it: each call one of the ops functions, in the run's organization. */
export function liveRunDb(client: OpsSupabaseClient): RunDb {
  return {
    start: (run, executionId) => startRunExecution(client, run.organizationId, run.runRequestId, run.claimToken, executionId),
    extend: (run, leaseSeconds) => extendRunLease(client, run.organizationId, run.runRequestId, run.claimToken, leaseSeconds),
    recordIntent: (run, intent) => recordSendIntent(client, run.organizationId, { ...intent, runRequestId: run.runRequestId, claimToken: run.claimToken }),
    recordResult: (run, ledgerId, result) => recordSendResult(client, run.organizationId, ledgerId, result),
    complete: (run, end) => completeRunRequest(client, run.organizationId, run.runRequestId, run.claimToken, end),
  }
}

/** The run's definition at its version: the frozen copy, else the bidding Worker's, frozen. Throws when neither can be had. */
async function definitionOf(env: OpsEnv, client: OpsSupabaseClient, run: ClaimedRun, delay: RunLiveDeps['delay']): Promise<Record<string, unknown>> {
  const held = await readWorkflowDefinition(client, run.organizationId, run.workflowId, run.workflowVersion)
  if (held !== null) return held.definition
  const gateway = env.OPS_GATEWAY
  if (!gateway) throw new Error('the OPS_GATEWAY binding to the bidding Worker is missing from this deploy')
  const asked = [{ workflowId: run.workflowId, versionNumber: run.workflowVersion }]
  const r = await raceDeadline(() => gateway.opsWorkflowDefinitions({ versions: [{ workflow_id: run.workflowId, version_number: run.workflowVersion }] }), RUN_DEFINITION_FETCH_DEADLINE_MS, delay)
  if (r.kind === 'timed_out') throw new Error(`the bidding Worker did not serve the definition within ${RUN_DEFINITION_FETCH_DEADLINE_MS / 1000} s`)
  if (r.kind === 'threw') throw r.error
  const served = parseServedOpsDefinitions(r.value, asked)
  const def = served.definitions.find((d) => d.workflowId === run.workflowId && d.versionNumber === run.workflowVersion)
  if (def === undefined) throw new Error(`the bidding Worker holds no ops lane version ${run.workflowVersion} of workflow ${run.workflowId}`)
  if (def.organizationId !== run.organizationId) throw new Error(`the bidding Worker served workflow ${run.workflowId} under another organization than its run`)
  const saved = await saveWorkflowDefinition(client, run.organizationId, run.workflowId, run.workflowVersion, def.definition)
  // A conflict keeps ops's own copy, which is the one to run; read it back.
  if (saved === 'conflict') {
    const kept = await readWorkflowDefinition(client, run.organizationId, run.workflowId, run.workflowVersion)
    if (kept !== null) return kept.definition
  }
  return def.definition
}

export async function runDispatched(env: OpsEnv, signed: unknown, deps: RunLiveDeps): Promise<RunDispatchAnswer> {
  let run: ClaimedRun
  try {
    opsInternalIdentity(env)
    const envelope = await verifyDispatch(await dispatchKey(env.PORTING_CAPTURE_MASTER), signed, deps.nowMs)
    if (envelope.item.kind !== 'run') throw new OpsInternalRefused('not_a_run')
    run = { ...envelope.item.run, organizationId: organizationIdFrom(envelope.item.run.organizationId) }
  } catch (err) {
    if (err instanceof OpsInternalRefused) return { refused: err.reason }
    throw err
  }

  // Every answer is a value (internal.ts): a deploy missing the ops database is a refusal by name.
  let client: OpsSupabaseClient
  try {
    client = createOpsSupabaseClient(env, deps.opsFetch ? { fetch: deps.opsFetch } : {})
  } catch (err) {
    if (err instanceof OpsDatabaseConfigError) return { refused: `ops_database_not_configured: ${formatErr(err)}` }
    throw err
  }
  let definition: Record<string, unknown>
  try {
    definition = await definitionOf(env, client, run, deps.delay)
  } catch (err) {
    const why = `the run's definition (workflow ${run.workflowId} version ${run.workflowVersion}) could not be had: ${formatErr(err)}`
    const end = { outcome: 'retry' as const, error: why, notBefore: new Date(deps.nowMs + RUN_DEFINITION_RETRY_MS) }
    // Not started, so this spends no attempt; the claim ends and the run waits a minute.
    try {
      await completeRunRequest(client, run.organizationId, run.runRequestId, run.claimToken, end)
    } catch (completeErr) {
      // Not started, so no ledger row: the lease lapses and the sweep returns the run to the queue.
      console.log(JSON.stringify({ event: 'ops_run', step: 'definition_unavailable_complete_failed', run_request_id: run.runRequestId, workflow_id: run.workflowId, error: formatErr(completeErr) }))
      return { outcome: 'complete_failed', end, error: `${why}; and the return to the queue could not be recorded: ${formatErr(completeErr)}` }
    }
    console.log(JSON.stringify({ event: 'ops_run', step: 'definition_unavailable', run_request_id: run.runRequestId, workflow_id: run.workflowId }))
    return { outcome: 'definition_unavailable', error: why }
  }

  return invokeRun({
    db: liveRunDb(client),
    clock: deps.clock ?? realRunClock,
    newExecutionId: deps.newExecutionId ?? (() => uuidv7()),
    log: (fields) => console.log(JSON.stringify(fields)),
  }, run, runBodyFor(definition, opsStepHandlers({
    // Built the first time an app_action step reaches its connection (app-action.ts), so a run with
    // none never needs the ops connections key, and a deploy without it fails that step by name.
    appAction: appActionDeps(() => {
      const live = liveOpsConnectionsDeps(env, { opensLogins: true, ...(deps.opsFetch ? { opsFetch: deps.opsFetch } : {}) })
      return { ...live.connection, rulesFor: (service) => live.services(service)?.rules }
    }),
  })))
}
