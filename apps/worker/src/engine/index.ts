import type { SupabaseClient } from '@supabase/supabase-js'
import { coerceString } from '../lib/coerce'
import { parseJson } from '../lib/json'
import { generateTraceId, deriveIdempotencyKey } from '../lib/crypto'
import { checkIdempotency, setIdempotencyProcessing, setIdempotencyResult, clearIdempotency } from './idempotency'
import { loadWorkflowDefinition } from './definition-loader'
import { loadEnvVars } from '../lib/env-loader'
import { sandboxEnvBindings } from '../lib/sandbox-env'
import { loadPartnerConstants } from '../lib/partner-constants-loader'
import { buildContext, recordStepOutput, resolveValue } from './context'
import { executeNode } from './nodes/index'
import { executeParallelNode } from './nodes/parallel'
import type { ParallelChildResult } from './nodes/parallel'
import { executeBidGroupNode } from './nodes/bid-group'
import type { BidGroupAttempt, BidGroupOutput } from './nodes/bid-group'
import { executePartnerBidNode } from './nodes/partner-bid'
import { buildCodeStepInput, unionReferencedSteps, scopeSteps } from './nodes/code'
import { findEntryNode, outgoingEdges, findNode, evaluateEdge } from './graph'
import { classifyHttpError, classifyTransportError, classifyStepError, formatCodeErrorMessage } from './error-classifier'
import { PartnerApiError } from './nodes/partner-bid'
import { withRetry } from './retry'
import { createExecutionRecord, updateExecutionRecord, flushStepLogs } from './step-logger'
import type { StepLogEntry } from './step-logger'
import { estimateStepBasedCost } from './cost-rates'
import {
  insertSighting,
  upsertPerson,
  extractSightingFields,
  extractPersonFields,
  finalizeSighting,
  recordBidAttempt,
  extractEnrichment,
  deriveRejectReason,
  extractBidGroupSummary,
} from './lead-sightings'
import { deriveCodeNodeBidAttempts, deriveCodeNodeBidSummary, pickBidSummary } from './bid-log'
import type { OutcomeAlertDeps } from './durability'
import { formatSsn } from './persons-crypto'
import { extractAchieveEvaluations, insertAchieveEvaluations } from './achieve-log'
import { fireExecutionAlert } from '../lib/execution-alerts'
import { matchesMutedSignal } from '../lib/failure-rate'
import { classifyOutageCause } from '../lib/upstream-outage'
import { enforceSourceAssignment, SourceNotAuthorizedError, SourceAuthUnavailableError } from './source-assignment'
import { log } from '../lib/logger'
import type { Env } from '../index'
import type {
  ExecutionContext,
  NodeDefinition,
  StepStatus,
  ErrorType,
  WorkflowDefinition,
  ResolvedStepInput,
} from '../types'

// Pull resolvedInput off a thrown error if the executor attached one. Mirrors
// the existing `(err as { logs?: ... }).logs` pattern used a few lines below
// for captured console output. Lets failed nodes still surface their input.
function extractResolvedInput(err: unknown): ResolvedStepInput | null {
  const tagged = err as { resolvedInput?: ResolvedStepInput } | undefined
  return tagged?.resolvedInput ?? null
}

// Carries step context through the throw so the alert can report which step failed
class StepFailureError extends Error {
  constructor(
    message: string,
    public readonly stepNamespace: string,
    public readonly errorType: ErrorType,
    public readonly suppressAlert: boolean = false
  ) {
    super(message)
  }
}

export { SourceNotAuthorizedError, SourceAuthUnavailableError }

// Hard ceiling on main-loop node visits in a single walk (#260). The walk
// follows edge targets with no cycle detection, so a cyclic definition would
// loop forever, repeating paid outbound calls and DB writes until the Worker
// CPU limit kills it. A real workflow visits only the distinct nodes on the
// taken path (branches pick one edge; parallel/group children are handled
// inline, not as main-loop iterations) — tens of nodes even for the largest
// flow. 500 is far above any legitimate walk yet a firm backstop for a runaway.
export const MAX_WALK_STEPS = 500

export interface ExecuteOptions {
  workflowId: string
  payload: unknown
  source: string
  idempotencyKeyHeader?: string
  resumeFromExecutionId?: string
  /** Set on a fresh replay so parent_execution_id is populated without
   *  triggering the resume-context preload. */
  parentExecutionId?: string
  isTest?: boolean
  executionId?: string
  definitionOverride?: WorkflowDefinition
  /** Ephemeral code bundle name for test runs (from deployTestCodeBundle), so
   *  code nodes dispatch to the just-deployed unsaved code. */
  codeBundleName?: string
  /** When true, verify the source is unrestricted or explicitly assigned to this workflow. */
  enforceSourceAssignment?: boolean
  /** When 'dry_run', outbound node executors return stubs instead of firing —
   *  the shadow-mirror volume test. 'stand_in' additionally resolves a
   *  deterministic Partner Bid (no outbound submission) so routing can be
   *  rehearsed (#232). See engine/shadow.ts. */
  shadowMode?: 'off' | 'dry_run' | 'stand_in'
}

export interface ExecuteResult {
  executionId: string
  response: unknown
  status: number
  traceId: string
  idempotentReplay?: boolean
  responseHeaders?: Record<string, string>
}

export interface WalkGraphResult {
  body: unknown
  status: number
  headers?: Record<string, string>
}

export async function executeWorkflow(
  options: ExecuteOptions,
  env: Env,
  supabase: SupabaseClient,
  executionCtx: ExecutionContext_CF
): Promise<ExecuteResult> {
  const { workflowId, payload, source } = options
  const traceId = generateTraceId()

  // Load workflow definition (KV-cached), allowing a caller-supplied override (e.g. test runs with unsaved changes).
  // Test runs bypass the is_active filter so authors can iterate before flipping a workflow live.
  const loaded = await loadWorkflowDefinition(workflowId, env.WORKFLOW_CACHE, supabase, {
    allowInactive: options.isTest === true,
  })
  const { workflow_version_id, workflow_name, org_id, slack_channel, capture_sightings } = loaded
  const definition = options.definitionOverride ?? loaded.definition

  if (options.enforceSourceAssignment) {
    await enforceSourceAssignment(supabase, org_id, source, workflowId)
  }

  // Resolve idempotency key (needs definition)
  const idempotencyConfig = definition.trigger.config.idempotency
  let resolvedIdempotencyKey: string | null = null

  if (idempotencyConfig?.enabled) {
    resolvedIdempotencyKey = options.idempotencyKeyHeader ?? null
    if (!resolvedIdempotencyKey && idempotencyConfig.derive_from_fields?.length) {
      resolvedIdempotencyKey = await deriveIdempotencyKey(payload, idempotencyConfig.derive_from_fields)
    }
  }
  // const so the useIdempotency alias below narrows it at the call sites
  const idempotencyKey = resolvedIdempotencyKey

  // Clamp the configured TTL: `?? 300` alone wouldn't catch a 0 (the UI can
  // persist ttl_seconds: 0 from a cleared number input), and Cloudflare KV
  // rejects expirationTtl below 60s. A 0 here would make the idempotency PUT
  // fail silently, so duplicate-lead suppression would never store — and the
  // same lead could fire duplicate partner bids. Floor at the KV minimum.
  const ttl = Math.max(idempotencyConfig?.ttl_seconds || 300, 60)

  // Resume/replay are deliberate operator recovery actions: they must always
  // execute, never be answered from the cache (the key derives from the same
  // stored payload, so without this the recovery action is exactly the request
  // most likely to hit the cached entry). They still write back on success so
  // a subsequent source retry of the same lead replays the recovered response
  // instead of re-running partner bids. Test runs never touch the cache at
  // all — a test payload matching a live lead must neither read nor poison
  // the production entry.
  const isRecoveryRun = Boolean(options.resumeFromExecutionId || options.parentExecutionId)
  const useIdempotency = idempotencyKey !== null && !options.isTest

  // Parallel: idempotency check + env var load (both independent once we have definition/org_id)
  const executionId = options.executionId ?? crypto.randomUUID()
  const startedAt = new Date().toISOString()

  const [idempotencyCached, envVars] = await Promise.all([
    useIdempotency && !isRecoveryRun
      ? checkIdempotency(env.IDEMPOTENCY, workflowId, idempotencyKey)
      : Promise.resolve(null),
    loadEnvVars(org_id, env.WORKFLOW_CACHE, supabase),
    // Pre-warm partner constants KV so constants node finds a hot cache instead of
    // paying the Supabase roundtrip cost mid-execution. Swallow errors — the constants
    // node retries on its own access and surfaces any real failure there.
    loadPartnerConstants(org_id, env.WORKFLOW_CACHE, supabase).catch(() => undefined),
  ])

  if (idempotencyCached) {
    if (idempotencyCached.status === 'processing') {
      log({ event: 'idempotency_hit', trace_id: traceId, workflow_id: workflowId, status: 'processing' })
      return { executionId, response: { error: 'Duplicate request in progress' }, status: 409, traceId }
    }
    log({ event: 'idempotency_hit', trace_id: traceId, workflow_id: workflowId, status: 'replay' })
    return {
      executionId,
      response: idempotencyCached.response,
      // Replay the original wire contract. Entries cached before
      // responseStatus existed carry neither field — default to 200.
      status: idempotencyCached.responseStatus ?? 200,
      traceId,
      idempotentReplay: true,
      responseHeaders: idempotencyCached.responseHeaders,
    }
  }

  // Kick off the idempotency-processing KV write and the execution-record
  // insert. The execution-record insert runs in parallel WITH the walk — it's
  // independent of step execution and we await it before flushing step logs at
  // the end (execution_steps has a FK on workflow_executions.id, so the record
  // must exist before the batch insert). The processing marker, by contrast, is
  // awaited before the first step runs (see below, #67) so a concurrent
  // duplicate can observe it. We start it here so it overlaps the synchronous
  // setup that follows and adds minimal latency before that await.
  const idempotencyProcessingPromise = useIdempotency && !isRecoveryRun
    ? setIdempotencyProcessing(env.IDEMPOTENCY, workflowId, idempotencyKey, ttl)
    : Promise.resolve()
  const executionRecordPromise = createExecutionRecord(supabase, {
    id: executionId,
    workflow_id: workflowId,
    workflow_version_id,
    source,
    trigger_payload: payload,
    trace_id: traceId,
    started_at: startedAt,
    is_test: options.isTest ?? false,
    parent_execution_id: options.parentExecutionId ?? options.resumeFromExecutionId,
    resumed_from_execution_id: options.resumeFromExecutionId,
  }, undefined, env)

  log({ event: 'execution_start', trace_id: traceId, workflow_id: workflowId, workflow_version_id, execution_id: executionId })

  // Lead sighting trigger boundary: insert in_flight sighting + upsert persons
  // row before the walk starts. Snowflake mirror is populated nightly. Writes
  // run in waitUntil; failures don't block the workflow.
  // Skipped for test runs and for workflows with capture_sightings=false.
  const sightingId = (options.isTest || !capture_sightings) ? undefined : crypto.randomUUID()
  // Tier-2 outcome-write alert deps (#309): route the engine's lead_sightings /
  // lead_sighting_bids / persons writes through writeOutcome so a loss after
  // retries dead-letters instead of vanishing into a log line.
  const outcomeDeps: OutcomeAlertDeps = { kv: env.IDEMPOTENCY, orgId: org_id, appUrl: env.APP_URL }

  if (sightingId) {
    const sightingPayloadFields = extractSightingFields(payload)
    const personFields = extractPersonFields(payload)
    const startedAtDate = new Date(startedAt)
    const sightingWritePromise = (async () => {
      let personId: string | null = null
      if (personFields) {
        personId = await upsertPerson(
          supabase,
          { organization_id: org_id, ...personFields },
          env.SECRET_ENCRYPTION_KEY,
          env.SSN_HASH_PEPPER,
          outcomeDeps,
        )
      }
      await insertSighting(supabase, {
        id: sightingId,
        trace_id: traceId,
        execution_id: executionId,
        workflow_id: workflowId,
        workflow_version_id: workflow_version_id ?? null,
        source_name: source ?? null,
        is_test: false,
        execution_started_at_utc: startedAtDate,
        execution_started_at_et: startedAtDate,
        payload_fields: sightingPayloadFields,
        ssn: personFields?.ssn ? formatSsn(personFields.ssn) : null,
        person_id: personId,
      }, outcomeDeps)
    })().catch((e) => console.error('[lead-sightings] trigger boundary write failed:', e))
    executionCtx.waitUntil(sightingWritePromise)
  }

  // Build execution context
  const ctx = buildContext(payload, source, workflowId, traceId, envVars, org_id, executionId, env.APP_URL, sightingId)
  if (options.codeBundleName) ctx.codeBundleName = options.codeBundleName
  if (options.shadowMode) ctx.shadow_mode = options.shadowMode

  // Resume re-runs the workflow from the entry node — no completed steps are
  // pre-loaded and nothing is skipped (it behaves like a fresh run, same as
  // replay, differing only in lineage via resumed_from_execution_id). The
  // prior skip-and-reuse path mis-routed past completed multi-output nodes
  // (a bid_group that routed no_winner resumed down the winner arm) and
  // re-fired never-completed wait_for:first parallel children. Running every
  // node fresh removes that whole class of resume-routing bugs. Trade-off:
  // resume re-fires partner calls, which is acceptable for a manual recovery
  // action (correctness over cost).

  // Walk the graph
  let response: unknown = null
  let executionStatus = 'completed'
  let errorMessage: string | undefined
  let failedStep: string | undefined
  let failedErrorType: ErrorType = null
  let failedSuppressAlert = false

  // #248: failures whose message matches one of these get their per-run page
  // muted (the aggregated rate alert in lib/failure-rate.ts pages once if they
  // spike). Muting only silences the page — the run still records as failed.
  const mutedFailureSignals = definition.trigger.config.muted_failure_signals ?? []

  // Step logs are accumulated here and flushed in a single Supabase insert after
  // the walk completes. Avoids serializing graph execution on N per-step writes.
  const stepLogQueue: StepLogEntry[] = []

  let walkStatus = 200
  let walkHeaders: Record<string, string> | undefined

  // Respond-early mechanics: when a code node returns continueExecution:true,
  // walkGraph signals the response is ready via onRespondEarly. We race that
  // signal against full walk completion. Whichever fires first unblocks the
  // caller. The remaining walk (for continueExecution flows) finishes in the
  // background via ctx.waitUntil, matching Pipedream's $.respond() semantics.
  let earlyResponseResolve: (r: WalkGraphResult) => void = () => {}
  const earlyResponsePromise = new Promise<WalkGraphResult>((res) => { earlyResponseResolve = res })

  // #67: the idempotency processing marker must be durably written before the
  // first outbound side effect. The put was kicked off above and has overlapped
  // all the synchronous setup since, so awaiting it here adds minimal latency —
  // but it closes the window where two duplicates arriving a few milliseconds
  // apart both pass the unawaited check-then-set and both fire partner bids.
  // What remains is only KV's own (inherent, PRD 2.9) check-then-set race.
  // Errors are swallowed: a failed marker write must not fail the execution
  // (the end-of-run handlers already chain on this same promise's catch).
  await idempotencyProcessingPromise.catch(() => {})

  const walkPromise = walkGraph(
    ctx, definition, executionId, startedAt, supabase, env, workflow_version_id, stepLogQueue,
    (r) => earlyResponseResolve(r)
  )

  // Swallow walk errors here — they're re-caught below after awaiting. Raw
  // walkPromise is referenced by both the race and the background continuation.
  const walkPromiseCaught = walkPromise.catch((err: unknown) => ({ __error: err }))

  // Race: whichever resolves first becomes the response to the caller.
  const raceResult = await Promise.race([
    earlyResponsePromise.then((r) => ({ kind: 'early' as const, body: r.body, status: r.status, headers: r.headers })),
    walkPromiseCaught.then((r) => {
      if (r && typeof r === 'object' && '__error' in r) {
        return { kind: 'error' as const, err: (r as { __error: unknown }).__error }
      }
      const walkRes = r as WalkGraphResult
      return { kind: 'complete' as const, body: walkRes.body, status: walkRes.status, headers: walkRes.headers }
    }),
  ])

  let hasContinuation = false
  if (raceResult.kind === 'early') {
    response = raceResult.body
    walkStatus = raceResult.status
    walkHeaders = raceResult.headers
    hasContinuation = true
  } else if (raceResult.kind === 'complete') {
    response = raceResult.body
    walkStatus = raceResult.status
    walkHeaders = raceResult.headers
  } else {
    const err = raceResult.err
    executionStatus = 'failed'
    errorMessage = err instanceof Error ? err.message : String(err)
    if (err instanceof StepFailureError) {
      failedStep = err.stepNamespace
      failedErrorType = err.errorType
      failedSuppressAlert = err.suppressAlert
    }
    response = { error: errorMessage, trace_id: traceId }
  }

  // Code-node sentinel responses with status >= 500 are real failures even
  // though the walk completed normally (the node logged itself as failed but
  // doesn't throw). Promote the most recent failed step to execution-level so
  // the failure alert path fires. Mirrors Pipedream's slack_alert step which
  // fired on any non-200 response.
  if (executionStatus === 'completed' && walkStatus >= 500) {
    const attribution = attributeWalkFailure(stepLogQueue, walkStatus, ctx.lastCompletedNamespace)
    if (attribution) {
      executionStatus = 'failed'
      failedStep = attribution.failedStep
      failedErrorType = attribution.failedErrorType
      errorMessage = attribution.errorMessage
    }
  }

  // Flush accumulated step logs. Must await the execution-record insert
  // first — execution_steps has a FK to workflow_executions.id, so the
  // batch insert fails if the record isn't there yet. Test runs await
  // the flush so the UI's post-response fetch finds rows; production
  // uses waitUntil so the HTTP response returns without waiting.
  //
  // Also: if we returned early due to continueExecution, the remaining walk
  // is still running. Chain the flush AFTER the walk fully completes so
  // post-response steps get their logs written too.
  const flushPromise: Promise<string | null> = walkPromiseCaught
    .then(() => executionRecordPromise)
    .then(() => flushStepLogs(supabase, stepLogQueue, env.PII_REDACTION_FIELDS ?? '', { workflowId, isTest: options.isTest ?? false }, env))
    .catch((e) => {
      console.error('[step-logger] flush failed:', e)
      return e instanceof Error ? e.message : String(e)
    })

  if (options.isTest) {
    // Test mode: wait for everything so the UI sees a complete step list.
    await walkPromiseCaught
    await flushPromise
  } else {
    executionCtx.waitUntil(flushPromise)
    if (hasContinuation) executionCtx.waitUntil(walkPromiseCaught)
    // Also keep idempotencyProcessing alive past the response so it can complete
    executionCtx.waitUntil(idempotencyProcessingPromise.catch(() => {}))
  }

  const completedAt = new Date().toISOString()
  const durationMs = Date.now() - new Date(startedAt).getTime()

  if (executionStatus === 'completed') {
    log({ event: 'execution_complete', trace_id: traceId, workflow_id: workflowId, workflow_version_id, execution_id: executionId, duration_ms: durationMs })
  } else {
    log({ event: 'execution_failed', trace_id: traceId, workflow_id: workflowId, workflow_version_id, execution_id: executionId, duration_ms: durationMs, error_message: errorMessage, error_type: failedErrorType, step_namespace: failedStep })
  }

  const successNamespaces = definition.trigger.config.success_node_namespaces ?? []

  // Update execution record (fire-and-forget). Wait for the walk to finish
  // so continueExecution flows include post-response steps in the cost
  // rollup AND so a success node fired during post-response work is
  // reflected in the outcome attribution. (ctx.lastCompletedNamespace at
  // this point only sees steps up to the early-response — the Patch
  // Prospect step that fires after Offer Response runs in the background.)
  // The tail consumer adds the main-Worker CPU slice on top once Cloudflare
  // reports true cpuTime for the invocation.
  executionCtx.waitUntil(
    Promise.all([walkPromiseCaught, flushPromise])
      .then(async ([walkResult, flushError]) => {
        const finalNodeNamespace = ctx.lastCompletedNamespace ?? null

        // Continuation failure: a post-response step (continue_after_response)
        // threw AFTER the early response was already sent to the caller. The
        // walk error is swallowed into walkPromiseCaught and the race already
        // resolved 'early', so executionStatus is still 'completed' even though
        // the background work failed (e.g. the Salesforce patch after Offer
        // Response). Without surfacing it here the run is silently recorded as
        // a success with no alert — the failed step row is the only trace.
        const continuationError =
          walkResult && typeof walkResult === 'object' && '__error' in walkResult
            ? (walkResult as { __error: unknown }).__error
            : null

        // Backstop: a "completed" execution that actually failed downstream of
        // the response, never advanced past the trigger (no node recorded a
        // successful output), or whose step rows were rejected by Postgres
        // (e.g. missing-column migration drift) is not a success. Promote to
        // failed so the dashboard, Slack alert, and outcome reflect reality.
        // The HTTP response already sent to the caller is unaffected;
        // response_status below still records what they actually received.
        let finalStatus = executionStatus
        let finalErrorMessage = errorMessage
        if (finalStatus === 'completed' && continuationError) {
          finalStatus = 'failed'
          if (continuationError instanceof StepFailureError) {
            failedStep = continuationError.stepNamespace
            failedErrorType = continuationError.errorType
            failedSuppressAlert = continuationError.suppressAlert
          } else {
            failedErrorType = failedErrorType ?? 'permanent'
          }
          finalErrorMessage = continuationError instanceof Error ? continuationError.message : coerceString(continuationError)
        } else if (finalStatus === 'completed' && flushError) {
          finalStatus = 'failed'
          failedErrorType = failedErrorType ?? 'permanent'
          finalErrorMessage = `Step logs failed to persist: ${flushError}`
        } else if (finalStatus === 'completed' && finalNodeNamespace == null) {
          finalStatus = 'failed'
          failedErrorType = failedErrorType ?? 'permanent'
          finalErrorMessage = 'Execution did not advance past the trigger — no step completed.'
        }

        const passedThroughSuccessNode = successNamespaces.some(
          (ns) => ctx.steps[ns]?.status === 'completed'
        )
        const outcome: 'successful' | 'completed' | 'failed' =
          finalStatus === 'failed'
            ? 'failed'
            : passedThroughSuccessNode ? 'successful' : 'completed'
        const cost = estimateStepBasedCost(stepLogQueue)
        const finalNodeId = finalNodeNamespace
          ? definition.nodes.find((n) => n.namespace === finalNodeNamespace)?.id ?? null
          : null
        await updateExecutionRecord(supabase, executionId, startedAt, {
          status: finalStatus,
          outcome,
          final_node_namespace: finalNodeNamespace,
          final_node_id: finalNodeId,
          completed_at: completedAt,
          duration_ms: durationMs,
          response_body: response,
          // The status the caller actually received (mirrors the fetch return
          // at the bottom of this function). Read by the sightings backfill,
          // which has no walk context to recompute it from.
          response_status: executionStatus === 'completed' ? walkStatus : 500,
          error_message: finalErrorMessage,
          cost_usd: cost,
        }, env)

        // Mirror the immediate alert gate: skip business rejections
        // (errorType === null) and explicitly suppressed failures so a
        // post-response business-rejection records as failed but doesn't page.
        // No-op for the flush-error/never-advanced promotions above (those set
        // a non-null 'permanent' type and never suppress).
        if (
          finalStatus === 'failed' &&
          executionStatus === 'completed' &&
          !options.isTest &&
          failedErrorType !== null &&
          !failedSuppressAlert &&
          !matchesMutedSignal(finalErrorMessage, mutedFailureSignals) &&
          // Shared-upstream outages page once via the aggregated cron (#331),
          // not per lead.
          !classifyOutageCause(finalErrorMessage)
        ) {
          executionCtx.waitUntil(
            fireExecutionAlert({
              alertType: 'failure',
              supabase,
              env,
              executionCtx,
              orgId: org_id,
              slackChannel: slack_channel,
              workflowId,
              workflowName: workflow_name,
              executionId,
              executionStartedAt: startedAt,
              durationMs,
              failedStep,
              errorMessage: finalErrorMessage ?? 'Unknown error',
              errorType: failedErrorType ?? 'permanent',
              timestamp: completedAt,
              stepLogQueue,
            }).catch((e) => console.error('[slack] backstop alert failed:', e))
          )
        }
      })
      .catch((e) => console.error('[execution] failed to update execution record:', e))
  )

  // Lead sighting finalize: flip outcome_state to 'finalized', populate
  // terminal/enrichment/bid summary, derive reject_reason, mark winning bid.
  // Skipped for test runs (no sighting was inserted at the trigger boundary).
  if (sightingId && !options.isTest) {
    const startedAtDate = new Date(startedAt)
    executionCtx.waitUntil(
      walkPromiseCaught
        .then(async () => {
          const completedAtDate = new Date(completedAt)
          const finalNs = ctx.lastCompletedNamespace ?? null
          const terminalNode = finalNs ? definition.nodes.find((n) => n.namespace === finalNs) ?? null : null
          const terminalStep = finalNs ? ctx.steps[finalNs] : undefined
          // Prefer the bid_group summary; fall back to the code-node (Tripoint)
          // summary when the flow bid via code nodes, so the finalize winner flip
          // and bid counts work for those flows too (#349).
          const bidSummary = pickBidSummary(
            extractBidGroupSummary(ctx.steps),
            deriveCodeNodeBidSummary(ctx.steps),
          )
          const enrichment = extractEnrichment(ctx.steps)
          const responseStatusCode = walkStatus
          const filterPassed =
            terminalNode?.type === 'filter' && terminalStep
              ? Boolean((terminalStep.output as { passed?: unknown } | null)?.passed)
              : null
          const bidRoute =
            terminalNode?.type === 'bid_group' && terminalStep
              ? ((terminalStep.output as { _route?: string } | null)?._route ?? null)
              : null
          const terminalHandle =
            terminalNode?.type === 'filter' && filterPassed === false ? 'exit'
            : terminalNode?.type === 'filter' && filterPassed === true ? 'pass'
            : terminalNode?.type === 'bid_group' && bidRoute ? bidRoute
            : null

          const rejectReason = deriveRejectReason({
            winning_partner_slug: bidSummary.winner_slug,
            response_status_code: responseStatusCode,
            terminal_node_type: terminalNode?.type ?? null,
            terminal_node_label: terminalNode?.namespace ?? finalNs,
            terminal_node_handle: terminalHandle,
            terminal_step_output: terminalStep?.output,
          })

          // Mirror the outcome attribution used for workflow_executions.outcome.
          // Any completed step in success_node_namespaces marks the run successful,
          // even if the workflow continues past it (e.g. branch_end / parallel_end
          // becomes the actual terminal node).
          const passedThroughSuccessNs = successNamespaces.some(
            (ns) => ctx.steps[ns]?.status === 'completed'
          )
          const sightingOutcome: 'successful' | 'completed' | 'failed' =
            executionStatus === 'failed'
              ? 'failed'
              : passedThroughSuccessNs ? 'successful' : 'completed'

          // Code-node bidding flows (e.g. the Engine Bidding Workflow's
          // tripoint_ping) never reach recordBidAttempt through partner_bid/
          // bid_group, so derive the bid attempt from the existing node output
          // and register it here (#349). Gated by sightingId above (capture on).
          for (const bid of deriveCodeNodeBidAttempts(ctx.steps, {
            sighting_id: sightingId,
            trace_id: traceId,
            execution_id: executionId,
            attempted_at_utc: startedAtDate,
            is_test: false,
          })) {
            ctx.pendingBidWrites ??= []
            ctx.pendingBidWrites.push(recordBidAttempt(supabase, bid, outcomeDeps))
          }

          // Wait for every bid-attempt insert to commit before finalize's
          // winner UPDATE runs (#88). The UPDATE matches lead_sighting_bids on
          // execution_id + partner_slug; if it ran before an insert committed it
          // would match zero rows and leave the winner is_winner=false forever.
          // These inserts are otherwise unawaited (registered here, not in the
          // walk), so this await is also what keeps them alive past teardown.
          await Promise.allSettled(ctx.pendingBidWrites ?? [])

          await finalizeSighting(supabase, {
            sighting_id: sightingId,
            execution_id: executionId,
            execution_started_at_utc: startedAtDate,
            execution_finished_at_et: completedAtDate,
            execution_ended_at_utc: completedAtDate,
            duration_ms: durationMs,
            terminal_node_id: terminalNode?.id ?? null,
            terminal_node_label: terminalNode?.namespace ?? finalNs,
            response_status_code: responseStatusCode,
            prospect_id: enrichment.prospect_id,
            equifax_status: enrichment.equifax_status,
            equifax_error_type: enrichment.equifax_error_type,
            equifax_score: enrichment.equifax_score,
            winning_partner_slug: bidSummary.winner_slug,
            winning_bid_cents: bidSummary.winner_bid_cents,
            partners_attempted: bidSummary.attempted,
            partners_responded: bidSummary.responded,
            reject_reason: rejectReason,
            outcome: sightingOutcome,
          }, outcomeDeps)
        })
        .catch((e) => console.error('[lead-sightings] finalize failed:', e))
    )
  }

  // Achieve evaluation log: after the walk completes, scan step outputs for
  // the achieve_fdr marker and persist request/offers to achieve_evaluations.
  // Test runs are recorded with is_test=true so sandbox validation is visible.
  executionCtx.waitUntil(
    walkPromiseCaught
      .then(async () => {
        const payloadSubmissionId = (payload as { Submission__c?: unknown } | null)?.Submission__c
        const achieveRows = extractAchieveEvaluations(stepLogQueue, {
          trace_id: traceId,
          execution_id: executionId,
          workflow_id: workflowId,
          submission_id: typeof payloadSubmissionId === 'string' ? payloadSubmissionId : null,
          is_test: options.isTest ?? false,
        })
        await insertAchieveEvaluations(supabase, achieveRows)
      })
      .catch((e) => console.error('[achieve-log] write failed:', e))
  )

  // Slow executions are no longer alerted per-run (too noisy — one transiently
  // slow lead = one page). The duration threshold (trigger.config.duration_alert_ms)
  // is still the per-run "slow" definition, but alerting is now aggregated: the
  // minute cron (lib/slow-execution-rate.ts) fires only when slow runs SPIKE
  // across a 5-minute window. See runSlowExecutionCheck.

  if (executionStatus === 'failed' && !options.isTest && failedErrorType !== null && !failedSuppressAlert && !matchesMutedSignal(errorMessage, mutedFailureSignals) && !classifyOutageCause(errorMessage)) {
    executionCtx.waitUntil(
      fireExecutionAlert({
        alertType: 'failure',
        supabase,
        env,
        executionCtx,
        orgId: org_id,
        slackChannel: slack_channel,
        workflowId,
        workflowName: workflow_name,
        executionId,
        executionStartedAt: startedAt,
        durationMs,
        failedStep,
        errorMessage: errorMessage ?? 'Unknown error',
        errorType: failedErrorType,
        timestamp: completedAt,
        stepLogQueue,
      }).catch((e) => console.error('[slack] alert failed:', e))
    )
  }

  // Cache idempotency result — only for completed executions. A failed run
  // clears the entry instead: caching the error would hand the source's retry
  // the stale failure (previously as a bare 200, so upstream stopped retrying
  // and the lead was lost for the whole TTL). Recovery runs (resume/replay)
  // write back on success but leave the cache untouched on failure — a failed
  // replay must not clobber a legitimately cached result for the same lead.
  // Both writes chain on the processing put so the earlier unawaited PUT can't
  // land after them on a fast walk.
  if (useIdempotency) {
    if (executionStatus === 'completed') {
      executionCtx.waitUntil(
        idempotencyProcessingPromise
          .catch(() => {})
          .then(() => setIdempotencyResult(env.IDEMPOTENCY, workflowId, idempotencyKey, response, ttl, walkStatus, walkHeaders))
          .catch((e) => console.error('[idempotency] failed to cache result:', e))
      )
    } else if (!isRecoveryRun) {
      executionCtx.waitUntil(
        idempotencyProcessingPromise
          .catch(() => {})
          .then(() => clearIdempotency(env.IDEMPOTENCY, workflowId, idempotencyKey))
          .catch((e) => console.error('[idempotency] failed to clear failed-run entry:', e))
      )
    }
  }

  return {
    executionId,
    response,
    status: executionStatus === 'completed' ? walkStatus : 500,
    traceId,
    responseHeaders: walkHeaders,
  }
}

// Walk the graph from entry node to completion, executing each step.
// Exported for unit testing only — not part of the public API.
//
// onRespondEarly: called as soon as a code node fires continueExecution:true,
// with the response that should be sent to the caller. The walk CONTINUES
// after this callback fires (running post-response nodes like patch-after-
// respond). The outer executeWorkflow uses this to send the HTTP response
// immediately and push the remaining walk into ctx.waitUntil, matching
// Pipedream's $.respond()-then-continue semantics.
export async function walkGraph(
  ctx: ExecutionContext,
  definition: { nodes: NodeDefinition[]; edges: import('../types').EdgeDefinition[] },
  executionId: string,
  executionStartedAt: string,
  supabase: SupabaseClient,
  env: Env,
  workflowVersionId = '',
  stepLogQueue: StepLogEntry[] = [],
  onRespondEarly?: (response: WalkGraphResult) => void
): Promise<WalkGraphResult> {
  let current: NodeDefinition | undefined = findEntryNode(definition.nodes, definition.edges)
  let stepOrder = 0
  let lastOutput: unknown = null
  let pendingResponse: WalkGraphResult | null = null
  // Bound the walk so a cyclic definition can't loop forever (#260). stepOrder is
  // reset/offset by parallel and bid_group handling, so count main-loop visits
  // separately.
  let walkSteps = 0

  while (current) {
    const node = current

    if (++walkSteps > MAX_WALK_STEPS) {
      throw new StepFailureError(
        `Workflow exceeded the maximum step count (${MAX_WALK_STEPS}); aborting to prevent a runaway loop. Check the graph for a cycle (an edge path that returns to an earlier node).`,
        node.namespace,
        'permanent',
      )
    }

    // ── Parallel node — fan out to children concurrently ───────────────────────
    if (node.type === 'parallel') {
      const stepStartedAt = new Date().toISOString()
      log({ event: 'step_start', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type })
      // Resolve children from edges off the start node — sourceHandle starting
      // with `child-` indicates a slot. Sort by slot index so logs stay ordered.
      const slotEdges = outgoingEdges(node.id, definition.edges)
        .filter((e) => (e.source_handle ?? '').startsWith('child-'))
        .sort((a, b) => {
          const ai = parseInt((a.source_handle ?? '').replace('child-', ''), 10)
          const bi = parseInt((b.source_handle ?? '').replace('child-', ''), 10)
          return ai - bi
        })
      const slotChildren = slotEdges
        .map((e) => findNode(e.target, definition.nodes))
        .filter((n): n is NodeDefinition => n !== undefined && n.type !== 'parallel_end')

      // Backwards-compat: pre-2026-04-30 definitions stored child ids on
      // `NodeDef.children` (top-level) and wait_for/timeout on the matching
      // parallel_end node. If no slot edges exist, fall back to the legacy form.
      const resolvedChildren: NodeDefinition[] = slotChildren.length > 0
        ? slotChildren
        : ((node.children ?? []) as string[])
            .map((id) => findNode(id, definition.nodes))
            .filter((n): n is NodeDefinition => n !== undefined)

      const parallelStartOrder = stepOrder
      const childOrderBase = stepOrder + 1
      const parallelEndOrder = childOrderBase + resolvedChildren.length

      // Config now lives on the start node. For legacy definitions whose end
      // node still holds wait_for/timeout, merge those in as a fallback.
      // parallel_end is found by checking three sources, in order:
      //  1. Children's immediate outgoing edges (single-node slot pattern)
      //  2. The parallel start's `output` handle edge (canvas skeleton edge)
      //  3. Walk each child's downstream chain looking for parallel_end
      const previewChildEdges = resolvedChildren.flatMap((c) => outgoingEdges(c.id, definition.edges))
      let endNodePreview = previewChildEdges
        .map((e) => findNode(e.target, definition.nodes))
        .find((n) => n?.type === 'parallel_end')
      if (!endNodePreview) {
        const skeletonEdge = outgoingEdges(node.id, definition.edges).find((e) => e.source_handle === 'output')
        if (skeletonEdge) {
          const target = findNode(skeletonEdge.target, definition.nodes)
          if (target?.type === 'parallel_end') endNodePreview = target
        }
      }
      if (!endNodePreview) {
        // BFS through children's chains looking for parallel_end
        const seen = new Set<string>()
        const queue = [...resolvedChildren]
        while (queue.length > 0) {
          const cur = queue.shift()!
          if (seen.has(cur.id)) continue
          seen.add(cur.id)
          if (cur.type === 'parallel_end') { endNodePreview = cur; break }
          for (const e of outgoingEdges(cur.id, definition.edges)) {
            const t = findNode(e.target, definition.nodes)
            if (t) queue.push(t)
          }
        }
      }
      const execNode = endNodePreview && endNodePreview.config && Object.keys(endNodePreview.config).length > 0
        ? { ...node, config: { ...endNodePreview.config, ...node.config } }
        : node

      let output: unknown = null
      let stepStatus: StepStatus = 'completed'
      let errorMessage: string | undefined
      let errorType: ErrorType = null

      try {
        // Slot handle ids parallel to resolvedChildren — needed when wait_for='specific'.
        const slotHandleIds = slotChildren.length > 0
          ? slotEdges.map((e) => e.source_handle ?? '')
          : []
        // Chain-walk children only when a parallel_end is present in the
        // workflow. Legacy parallel definitions (no parallel_end) rely on
        // single-node child execution and the parent's last-child-edge
        // continuation logic; chain walking would double-execute downstream nodes.
        const chainEndId = endNodePreview?.id
        const result = await executeParallelNode(
          execNode,
          resolvedChildren,
          (child, childIndex, abandonSignal) =>
            runParallelChild(child, ctx, env, supabase, executionId, executionStartedAt, childOrderBase + childIndex, node.id, workflowVersionId, stepLogQueue, definition, chainEndId, abandonSignal),
          slotHandleIds
        )
        output = result.output
        lastOutput = output

        // Children cut off by the parent's timeout never get their own step log
        // written (runParallelChild was abandoned). Synthesize one so clicking
        // the child in the UI shows what happened instead of "not reached".
        if (Array.isArray(output)) {
          const timeoutMs = (execNode.config.timeout_ms as number | undefined) ?? 15000
          for (const childResult of output as ParallelChildResult[]) {
            if (childResult.status !== 'timeout') continue
            const childIndex = resolvedChildren.findIndex((c) => c.namespace === childResult.namespace)
            if (childIndex < 0) continue
            const child = resolvedChildren[childIndex]
            const errMsg = `Parallel group timed out after ${timeoutMs}ms before this child completed`
            recordStepOutput(ctx, child.namespace, { output: null, status: 'failed', error: errMsg, error_type: 'transient' })
            logStep(stepLogQueue, executionId, executionStartedAt, child, 'failed', null, null, errMsg, 'transient', 0, stepStartedAt, childOrderBase + childIndex, node.id)
          }
        }
      } catch (err) {
        stepStatus = 'failed'
        errorMessage = err instanceof Error ? err.message : String(err)
        // A parallel failure (a child rejected, or the group timed out) is an
        // operational error, never a clean business rejection — give it a real
        // type so the failure alert fires. A null type is read as a business
        // rejection and stays silent (#64).
        errorType = classifyStepError(err) ?? 'transient'
      }

      const parallelDurationMs = Date.now() - new Date(stepStartedAt).getTime()
      if (stepStatus === 'completed') {
        log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: parallelDurationMs })
      } else {
        log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: parallelDurationMs, error_message: errorMessage, error_type: errorType })
      }

      recordStepOutput(ctx, node.namespace, { output, status: stepStatus, error: errorMessage, error_type: errorType })
      logStep(stepLogQueue, executionId, executionStartedAt, node, stepStatus, null, output, errorMessage, errorType, 0, stepStartedAt, parallelStartOrder)

      // Locate the parallel_end join node. Reuse the same detection logic
      // used to enable chain walking — children's edges, then the parallel
      // start's skeleton edge, then BFS through the chain.
      const childIdSet = new Set(resolvedChildren.map((c) => c.id))
      const endNode = endNodePreview
      if (endNode) {
        recordStepOutput(ctx, endNode.namespace, { output, status: stepStatus, error: errorMessage, error_type: errorType }, endNode.type)
        logStep(stepLogQueue, executionId, executionStartedAt, endNode, stepStatus, null, output, errorMessage, errorType, 0, stepStartedAt, parallelEndOrder)
      }

      if (stepStatus === 'failed') {
        throw new StepFailureError(errorMessage!, node.namespace, errorType)
      }

      if (endNode) {
        const contEdges = outgoingEdges(endNode.id, definition.edges)
        const nextEdge = contEdges.find((e) => evaluateEdge(e, ctx))
        current = nextEdge ? findNode(nextEdge.target, definition.nodes) : undefined
      } else {
        // Backward compat: last child's outgoing edge
        const lastChild = resolvedChildren.length > 0 ? resolvedChildren[resolvedChildren.length - 1] : null
        const contEdges = lastChild
          ? outgoingEdges(lastChild.id, definition.edges).filter((e) => !childIdSet.has(e.target))
          : outgoingEdges(node.id, definition.edges).filter((e) => !childIdSet.has(e.target))
        const nextEdge = contEdges.find((e) => evaluateEdge(e, ctx))
        current = nextEdge ? findNode(nextEdge.target, definition.nodes) : undefined
      }
      // Advance past the whole parallel block (parallel_start + children + parallel_end)
      stepOrder = parallelEndOrder + 1
      continue
    }

    // ── Bid Group node — fan out to N partners and pick a winner ─────────────
    if (node.type === 'bid_group') {
      const groupStartedAt = new Date().toISOString()
      log({ event: 'step_start', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type })

      // Allocate a step_order block:
      //   group_start, attempt_0, attempt_1, ..., (potential fallback)
      const groupStartOrder = stepOrder
      const attemptOrderBase = stepOrder + 1
      const config = node.config as Record<string, unknown>
      const partnerIds = (config.partner_ids as string[] | undefined) ?? []
      const fallbackId = config.fallback_partner_id as string | null | undefined
      const tiers = (config.tiers as Array<{ partner_ids?: string[] }> | undefined) ?? []
      const tieredPartnerCount = tiers.reduce((sum, t) => sum + (t.partner_ids?.length ?? 0), 0)
      const maxAttempts = (config.mode === 'tiered' ? tieredPartnerCount : partnerIds.length) + (fallbackId ? 1 : 0)
      const groupEndOrder = attemptOrderBase + maxAttempts

      // Pre-load partner slugs in one query so the synthesized namespaces use the slug
      // instead of the UUID — much friendlier in the test panel.
      const tieredPartnerIds = tiers.flatMap((t) => t.partner_ids ?? [])
      const allIds = Array.from(new Set([...partnerIds, ...tieredPartnerIds, ...(fallbackId ? [fallbackId] : [])]))
      const slugByPartnerId = new Map<string, string>()
      if (allIds.length > 0) {
        const { data: rows, error: slugErr } = await supabase
          .from('partner_configs')
          .select('id, slug')
          .in('id', allIds)
        // On error the map stays empty and namespaces fall back to `partner-N`.
        // That's a cosmetic mislabel (don't fail a bid over it), but log it so the
        // mislabeled analytics rows aren't a silent mystery.
        if (slugErr) console.error('[bid-group] partner slug preload failed; using partner-N fallback:', slugErr)
        for (const r of (rows ?? []) as { id: string; slug: string }[]) {
          slugByPartnerId.set(r.id, r.slug)
        }
      }

      const runAttempt = async ({ partner_id, attemptIndex }: { partner_id: string; attemptIndex: number }): Promise<BidGroupAttempt> => {
        const slug = slugByPartnerId.get(partner_id) ?? `partner-${attemptIndex}`
        const childNamespace = `${node.namespace}.${slug}`
        const childNode: NodeDefinition = {
          id: `${node.id}::${slug}`,
          namespace: childNamespace,
          type: 'partner_bid',
          config: { partner_id },
        }
        const attemptStart = new Date().toISOString()
        const attemptStartMs = Date.now()

        let attemptStatus: StepStatus = 'completed'
        let attemptError: string | undefined
        let attemptErrorType: ErrorType = null
        let attemptOutput: import('./nodes/partner-bid').PartnerBidOutput | null = null
        let attemptResolvedInput: ResolvedStepInput | null = null

        try {
          const result = await executePartnerBidNode(childNode, ctx, env, supabase)
          attemptOutput = result.output as import('./nodes/partner-bid').PartnerBidOutput
          attemptResolvedInput = result.resolvedInput ?? null
        } catch (err) {
          attemptStatus = 'failed'
          attemptError = err instanceof Error ? err.message : String(err)
          attemptErrorType = classifyStepError(err)
          attemptResolvedInput = extractResolvedInput(err)
        }

        recordStepOutput(ctx, childNamespace, { output: attemptOutput, status: attemptStatus, error: attemptError, error_type: attemptErrorType })
        // Log with the bid_group's REAL node id as step_node_id. childNode.id is
        // synthetic (`${node.id}::${slug}`) and step_node_id is a uuid column —
        // logging the synthetic id makes the whole step batch insert fail with
        // "invalid input syntax for type uuid", silently dropping every step for
        // the run (no path visible, canvas doesn't light up). The synthesized
        // attempts belong to the bid_group node, so node.id is the right ref.
        // Fallback shape preserves `partner_id` as the input marker when the
        // partner-bid executor didn't populate resolvedInput (e.g. very early
        // failures before payload construction).
        const attemptInput: ResolvedStepInput = attemptResolvedInput
          ?? { template: { partner_id }, resolved: { partner_id } }
        logStep(stepLogQueue, executionId, executionStartedAt, { ...childNode, id: node.id }, attemptStatus, attemptInput, attemptOutput, attemptError, attemptErrorType, 0, attemptStart, attemptOrderBase + attemptIndex, node.id)

        const attemptStatusLog = attemptStatus === 'completed' ? 'step_complete' : 'step_error'
        log({ event: attemptStatusLog, trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: childNamespace, step_type: 'partner_bid', duration_ms: Date.now() - attemptStartMs, error_message: attemptError, error_type: attemptErrorType })

        return {
          namespace: childNamespace,
          partner_id,
          partner_slug: slug,
          output: attemptOutput,
          status: attemptStatus,
          error: attemptError,
          error_type: attemptErrorType,
          started_at: attemptStart,
          duration_ms: Date.now() - attemptStartMs,
        }
      }

      // Resolve the BidGroup's `context` map and stash on ctx for the duration
      // of the group's partner attempts. Each value is a template string that
      // may reference steps.*, trigger.*, env.*. Partner formulas can then use
      // `context.<name>` for workflow-portable references (see bid-resolver.ts).
      const contextConfig = node.config.context as Record<string, unknown> | undefined
      let resolvedContext: Record<string, unknown> | undefined
      if (contextConfig && typeof contextConfig === 'object') {
        resolvedContext = {}
        for (const [k, v] of Object.entries(contextConfig)) {
          resolvedContext[k] = resolveValue(v, ctx)
        }
        ctx.bidGroupContext = resolvedContext
      }

      let groupOutput: BidGroupOutput | null = null
      let groupStatus: StepStatus = 'completed'
      let groupErrorMessage: string | undefined
      let groupErrorType: ErrorType = null
      try {
        groupOutput = await executeBidGroupNode(node, ctx, env, supabase, runAttempt, (id) => slugByPartnerId.get(id))
      } catch (err) {
        groupStatus = 'failed'
        groupErrorMessage = err instanceof Error ? err.message : String(err)
        // A bid_group execution error is operational, not a business rejection
        // (a no-winner routes via _route, it doesn't throw) — give it a real type
        // so the failure alert fires (#64).
        groupErrorType = classifyStepError(err) ?? 'transient'
      } finally {
        // Clear bidGroupContext so subsequent steps (or nested groups, if ever)
        // don't see stale values. Idempotent — safe even when context wasn't set.
        ctx.bidGroupContext = undefined
      }

      const groupDurationMs = Date.now() - new Date(groupStartedAt).getTime()
      if (groupStatus === 'completed' && groupOutput) {
        log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: groupDurationMs })
      } else {
        log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: groupDurationMs, error_message: groupErrorMessage })
      }

      recordStepOutput(ctx, node.namespace, { output: groupOutput, status: groupStatus, error: groupErrorMessage, error_type: groupErrorType })
      const groupResolvedInput: ResolvedStepInput = {
        template: {
          mode: config.mode,
          partner_ids: partnerIds,
          tiers,
          fallback_partner_id: fallbackId,
          min_bid_threshold: config.min_bid_threshold,
          timeout_ms: config.timeout_ms,
          context: node.config.context,
          no_winner_behavior: config.no_winner_behavior,
        },
        resolved: {
          mode: config.mode,
          partner_slugs: partnerIds.map((id) => slugByPartnerId.get(id) ?? id),
          fallback_partner_slug: fallbackId ? (slugByPartnerId.get(fallbackId) ?? fallbackId) : null,
          tiered_partner_slugs: tiers.map((t) => (t.partner_ids ?? []).map((id) => slugByPartnerId.get(id) ?? id)),
          context: resolvedContext,
        },
      }
      logStep(stepLogQueue, executionId, executionStartedAt, node, groupStatus, groupResolvedInput, groupOutput, groupErrorMessage, groupErrorType, 0, groupStartedAt, groupStartOrder)

      lastOutput = groupOutput

      if (groupStatus === 'failed') {
        throw new StepFailureError(groupErrorMessage!, node.namespace, groupErrorType)
      }

      // no_winner_behavior: 'exit' short-circuits the workflow with the group's output.
      // 'route' (or legacy 'fail') falls through to the no_winner outgoing edge below.
      // Default to 'route' so unconfigured groups follow the wired edge rather than
      // throw — matches the 'fail'-as-routing semantics that's been live since BidGroup
      // shipped. See bid-group.ts `no_winner_behavior` doc comment.
      if (groupOutput && groupOutput._route === 'no_winner') {
        const noWinnerBehavior = (config.no_winner_behavior as string | undefined) ?? 'route'
        if (noWinnerBehavior === 'exit') {
          stepOrder = groupEndOrder + 1
          return { body: groupOutput, status: 200 }
        }
      }

      // Pick the outgoing edge by _route (winner / no_winner). Falls back to
      // the first matching condition if no _route handle is wired (older configs).
      const outEdges = outgoingEdges(node.id, definition.edges)
      const route = groupOutput?._route
      let nextEdge = route ? outEdges.find((e) => e.source_handle === route) : undefined
      if (!nextEdge) nextEdge = outEdges.find((e) => evaluateEdge(e, ctx))
      current = nextEdge ? findNode(nextEdge.target, definition.nodes) : undefined

      stepOrder = groupEndOrder + 1
      continue
    }

    // ── Code-node chain execution ──────────────────────────────────────────────
    // When adjacent code nodes are eligible to chain (no retries, no service,
    // no conditions on edges between them, no sentinels expected at intermediate
    // steps), execute them in ONE subrequest to the bundled worker and process
    // all results at once. Saves N-1 subrequest round-trips per run.
    // Skip when there's no dispatch namespace binding — tests mock executeNode
    // per step and won't have the binding wired up.
    if (node.type === 'code' && env.DYNAMIC_WORKER_LOADER) {
      const chain = collectCodeChain(node, definition)
      if (chain.length > 1) {
        const chainResult = await executeCodeChain(chain, ctx, env)
        // Log + record each result. Any sentinel or failure in the chain stops
        // further chain processing (bundled worker also stops at the first
        // sentinel/failure).
        let terminated = false
        for (let i = 0; i < chainResult.results.length; i++) {
          const r = chainResult.results[i]
          const chainNode = chain[i]
          const stepStartedAtIso = new Date(Date.now() - r.durationMs).toISOString()
          if (r.status === 'completed') {
            log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: chainNode.namespace, step_type: chainNode.type, duration_ms: r.durationMs })
          } else {
            log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: chainNode.namespace, step_type: chainNode.type, duration_ms: r.durationMs, error_message: r.error, error_type: 'transient' })
          }
          recordStepOutput(ctx, chainNode.namespace, { output: r.output ?? null, status: r.status, error: r.error, error_type: r.status === 'failed' ? 'transient' : null })
          // Chained code steps don't get the standard ResolvedStepInput from the
          // executor (the bundled worker batches them). Reconstruct the same
          // template/resolved shape from the chain node's props config — the
          // resolved values were already computed inside executeCodeChain's
          // chainPayload build, but aren't returned per-step, so re-resolve here.
          // resolveValue is cheap (string templating against ctx); fine on the
          // hot path for a chain of ~3-5 nodes.
          const chainResolvedInput = buildCodeStepInput(chainNode, ctx)
          logStep(stepLogQueue, executionId, executionStartedAt, chainNode, r.status, chainResolvedInput, r.output ?? null, r.error, r.status === 'failed' ? 'transient' : null, 0, stepStartedAtIso, stepOrder, undefined, r.logs)
          stepOrder++
          if (r.status === 'completed') lastOutput = r.output

          // Handle sentinel on this step (bundled worker already short-circuited
          // the chain on sentinel, so this is the last result we'll see).
          if (r.sentinel) {
            terminated = true
            if (r.sentinel.kind === 'exit') {
              return { body: r.output ?? null, status: 200 }
            }
            // 'response' sentinel
            const resp = (r.output as { response?: { status?: number; body?: unknown } } | null)?.response
            const body = resp?.body ?? null
            const status = resp?.status ?? 200
            if (r.sentinel.continueAfter) {
              pendingResponse = { body, status }
              onRespondEarly?.(pendingResponse)
              // advance to next node after the chain's last node
              const contEdges = outgoingEdges(chainNode.id, definition.edges)
              const nextEdge = contEdges.find((e) => evaluateEdge(e, ctx))
              current = nextEdge ? findNode(nextEdge.target, definition.nodes) : undefined
              break
            } else {
              return { body, status }
            }
          }

          if (r.status === 'failed') {
            terminated = true
            throw new StepFailureError(r.error ?? 'Code node failed', chainNode.namespace, 'transient')
          }
        }

        if (terminated) continue

        // No sentinel, no error — normal end-of-chain advance past the last node.
        const lastChainNode = chain[chain.length - 1]
        const contEdges = outgoingEdges(lastChainNode.id, definition.edges)
        const nextEdge = contEdges.find((e) => evaluateEdge(e, ctx))
        current = nextEdge ? findNode(nextEdge.target, definition.nodes) : undefined
        continue
      }
    }

    // ── Sequential step execution ───────────────────────────────────────────────
    const stepStartedAt = new Date().toISOString()
    log({ event: 'step_start', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type })
    let stepStatus: StepStatus = 'running'
    let output: unknown = null
    let errorMessage: string | undefined
    let errorType: ErrorType = null
    let retriesUsed = 0
    // Mutated in place by withRetry (below) on both the success and throw path,
    // then copied into retriesUsed so every logStep call records the real count.
    const retryStats = { retries: 0 }
    // Resolved input — captured from executor result on success, or from a
    // thrown error's `.resolvedInput` on failure. Lets the Results panel show
    // both the template the author wrote and the resolved values, so debugging
    // a bad value doesn't require panel-hopping back to the trigger.
    let resolvedInput: ResolvedStepInput | null = null

    const retryConfig = {
      // Default retries=2 so transient blips (timeouts, 5xx, network) self-heal
      // without manual config. Non-transient errors (business 4xx) still don't
      // retry — see classifyHttpError / classifyTransportError.
      retries: (node.config.retries as number) ?? 2,
      // Exponential backoff (500ms, 1s, 2s) gives downstream services breathing
      // room when they're under stress; linear retries pile on instead.
      backoff: (node.config.retry_backoff as 'linear' | 'exponential') ?? 'exponential',
      timeout_ms: (node.config.timeout_ms as number) ?? 30000,
    }

    // Tracks whether the earlyResponse branch already logged the step so the
    // outer completion path doesn't double-log it.
    let loggedEarly = false
    // Captured console output from the node (only populated by code nodes today).
    // Stays undefined for non-code nodes; threads to logStep on both the success
    // and error paths.
    let stepLogs: import('../types').StepLogEntry[] | undefined

    try {
      const result = await withRetry(
        (signal) => executeNode(node, ctx, env, supabase, signal),
        retryConfig,
        classifyStepError,
        retryStats
      )
      retriesUsed = retryStats.retries
      output = result.output
      stepStatus = 'completed'
      lastOutput = output
      stepLogs = result.logs
      resolvedInput = result.resolvedInput ?? null

      // Early exit / respond sentinels from translated Pipedream patterns:
      //   { response } alone          → respond + exit ($.respond() + $.flow.exit())
      //   { response, continueExecution: true } → respond + continue ($.respond() only)
      //   { exit: true }              → exit silently ($.flow.exit() only)
      if (result.earlyResponse ?? result.earlyExit) {
        const seqDurationMsEarly = Date.now() - new Date(stepStartedAt).getTime()
        // If the code node responded with a 4xx/5xx, treat the step as FAILED
        // in the UI and logs — even though the code ran to completion. An HTTP
        // error status is the node's own signal that something went wrong, and
        // rendering it green is confusing ("step succeeded but gave me an error").
        // 2xx/3xx sentinels stay 'completed' (the happy respond-and-exit path).
        const respStatus = result.earlyResponse?.status
        // `expected: true` opts out of fail-on-4xx/5xx — mirrors the Salesforce
        // expected_errors path. Step stays `completed` (no Slack, green border)
        // while the response body still carries the error status to the caller.
        const sentinelFailed = respStatus !== undefined && respStatus >= 400 && !result.expected
        const earlyStepStatus: StepStatus = sentinelFailed ? 'failed' : 'completed'
        const earlyErrorMessage = sentinelFailed
          ? formatCodeErrorMessage(respStatus!, result.earlyResponse?.body)
          : undefined
        const earlyErrorType: ErrorType = sentinelFailed ? classifyHttpError(respStatus!) : null

        if (sentinelFailed) {
          log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMsEarly, error_message: earlyErrorMessage, error_type: earlyErrorType })
        } else {
          log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMsEarly })
        }
        recordStepOutput(ctx, node.namespace, { output, status: earlyStepStatus, error: earlyErrorMessage, error_type: earlyErrorType }, node.type)
        logStep(stepLogQueue, executionId, executionStartedAt, node, earlyStepStatus, resolvedInput, output, earlyErrorMessage, earlyErrorType, retriesUsed, stepStartedAt, stepOrder, undefined, stepLogs)
        loggedEarly = true
        if (result.continueAfterResponse && result.earlyResponse) {
          pendingResponse = { body: result.earlyResponse.body, status: result.earlyResponse.status, headers: result.earlyResponse.headers }
          // Signal to the outer handler that the response is ready now; the
          // remaining walk continues here but the caller doesn't have to wait
          // for it (outer pushes the continuation into ctx.waitUntil).
          onRespondEarly?.(pendingResponse)
          // fall through — continue walking the graph
        } else {
          if (result.earlyResponse) {
            return { body: result.earlyResponse.body, status: result.earlyResponse.status, headers: result.earlyResponse.headers }
          }
          return { body: output, status: 200 }
        }
      }

    } catch (err) {
      // withRetry exhausted (or hit a permanent error) — record how many retries
      // it burned through so the failed step logs the true count.
      retriesUsed = retryStats.retries
      // Classify error type — needed for Slack alerting
      let suppressAlert = false
      // Extract captured console output from code-node errors so a failing
      // script's logs are still persisted (often the most useful debug signal).
      const errLogs = (err as { logs?: import('../types').StepLogEntry[] }).logs
      if (errLogs) stepLogs = errLogs
      // Same pattern for resolved input — executors that build the outbound
      // payload before fetch (Salesforce, Partner Bid, etc.) attach the
      // resolved values to thrown errors so failed steps don't show blank input.
      const errResolvedInput = extractResolvedInput(err)
      if (errResolvedInput) resolvedInput = errResolvedInput
      if (err instanceof PartnerApiError) {
        errorType = err.errorType
        suppressAlert = err.suppressAlert
      } else if (err instanceof Response) {
        errorType = classifyHttpError(err.status)
      } else {
        errorType = classifyTransportError(err)
      }

      errorMessage = err instanceof Error ? err.message : String(err)
      const onError = node.config.on_error ?? 'fail'
      const seqDurationMs = Date.now() - new Date(stepStartedAt).getTime()

      if (onError === 'skip') {
        stepStatus = 'skipped'
        log({ event: 'step_skipped', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMs, error_message: errorMessage, error_type: errorType })
      } else if (onError === 'fallback' && node.config.fallback_node) {
        stepStatus = 'failed_with_fallback'
        log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMs, error_message: errorMessage, error_type: errorType })
        const fallback = findNode(node.config.fallback_node as string, definition.nodes)
        if (fallback) {
          recordStepOutput(ctx, node.namespace, { output: null, status: stepStatus, error: errorMessage, error_type: errorType }, node.type)
          logStep(stepLogQueue, executionId, executionStartedAt, node, stepStatus, resolvedInput, output, errorMessage, errorType, retriesUsed, stepStartedAt, stepOrder, undefined, stepLogs)
          current = fallback
          stepOrder++
          continue
        }
        throw new Error(`Fallback node ${node.config.fallback_node} not found`)
      } else {
        stepStatus = 'failed'
        log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMs, error_message: errorMessage, error_type: errorType })
        recordStepOutput(ctx, node.namespace, { output: null, status: stepStatus, error: errorMessage, error_type: errorType }, node.type)
        logStep(stepLogQueue, executionId, executionStartedAt, node, stepStatus, resolvedInput, output, errorMessage, errorType, retriesUsed, stepStartedAt, stepOrder, undefined, stepLogs)
        throw new StepFailureError(errorMessage, node.namespace, errorType, suppressAlert)
      }
    }

    // Skip the normal completion logging if the earlyResponse branch above
    // already logged the step (continueExecution case). Without this guard,
    // the step shows up twice in the Steps list with identical durations.
    if (!loggedEarly) {
      const seqDurationMs = Date.now() - new Date(stepStartedAt).getTime()
      log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMs })
      recordStepOutput(ctx, node.namespace, { output, status: stepStatus }, node.type)
      logStep(stepLogQueue, executionId, executionStartedAt, node, stepStatus, resolvedInput, output, errorMessage, errorType, retriesUsed, stepStartedAt, stepOrder, undefined, stepLogs)
    }

    // Exit node — return immediately. Response nodes also terminate, unless
    // continue_after_response is set — in that case the earlyResponse branch
    // above already fired the HTTP response and we keep walking the graph
    // (mirrors the code-node continueExecution sentinel).
    if (node.type === 'exit' || (node.type === 'response' && !node.config.continue_after_response)) {
      if (node.type === 'response' && output !== null && typeof output === 'object' && 'body' in (output as object)) {
        const r = output as { status?: number; headers?: Record<string, string>; body?: unknown }
        return { body: r.body ?? null, status: r.status ?? 200, headers: r.headers }
      }
      return { body: output, status: 200 }
    }

    // Follow the appropriate outgoing edge.
    // Filter/branch nodes signal their chosen output via output._route which
    // maps to edge source_handle. Branches additionally carry a hidden backbone
    // edge to their paired branch_end (source_handle 'output'); for branch
    // routing only, we skip non-route edges so the backbone never short-circuits
    // an unwired handle.
    const edges = outgoingEdges(node.id, definition.edges)
    let nextEdge: import('../types').EdgeDefinition | undefined

    if ((node.type === 'filter' || node.type === 'branch' || node.type === 'latency_gate') &&
        output !== null && typeof output === 'object') {
      const route = (output as Record<string, unknown>)._route as string | undefined
      if (route) nextEdge = edges.find((e) => e.source_handle === route)
      // branch/filter: an unwired chosen handle terminates the chain. Without
      // this it falls through to evaluateEdge and follows whatever edge evaluates
      // true — for a branch the hidden backbone edge, for a filter the OTHER
      // handle (only `pass` wired would send an `exit` lead down `pass`).
      // Terminating is the safe behavior: an unwired output just stops.
      // (latency_gate is intentionally NOT here — its no-match routing is
      // governed by its own semantics.)
      if (!nextEdge && (node.type === 'branch' || node.type === 'filter')) {
        current = undefined
        stepOrder++
        continue
      }
    }

    if (!nextEdge) {
      nextEdge = edges.find((e) => evaluateEdge(e, ctx))
    }

    current = nextEdge ? findNode(nextEdge.target, definition.nodes) : undefined
    stepOrder++
  }

  return pendingResponse ?? { body: lastOutput, status: 200 }
}

// Decide how to attribute a walk that finished with a 5xx response to a failing
// step, so the failure alert blames the node that actually produced the 5xx.
//
// The subtlety is bid_group children: a partner bid that errors inside a race is
// logged as a `failed` step, but if the group itself COMPLETED (it tolerated the
// error and routed `no_winner`), that child was absorbed and didn't cause the
// 5xx. Naively picking "the last failed step" blamed those handled blips — e.g.
// a transient partner 502 with "should succeed on retry" — when the real cause
// was a downstream node (the no_winner fallback's own 5xx). So we skip failures
// belonging to a completed bid_group and, if nothing else failed, attribute to
// the terminal node that emitted the response.
//
// Returns null when no step failed (walk returned 5xx but nothing errored — the
// caller leaves the execution `completed`, preserving prior behavior).
export function attributeWalkFailure(
  stepLogQueue: readonly StepLogEntry[],
  walkStatus: number,
  lastCompletedNamespace: string | null | undefined
): { failedStep: string | undefined; failedErrorType: ErrorType; errorMessage: string } | null {
  const absorbedGroupIds = new Set(
    stepLogQueue
      .filter((e) => e.step_type === 'bid_group' && e.status !== 'failed')
      .map((e) => e.step_node_id)
      .filter((id): id is string => id != null)
  )
  const failedSteps = [...stepLogQueue].reverse().filter((e) => e.status === 'failed')
  if (failedSteps.length === 0) return null

  // Prefer the most recent failure the workflow did NOT already absorb.
  const cause = failedSteps.find(
    (e) => !(e.parallel_group_id != null && absorbedGroupIds.has(e.parallel_group_id))
  )
  if (cause) {
    return {
      failedStep: cause.step_namespace,
      failedErrorType: cause.error_type ?? 'permanent',
      errorMessage: cause.error_message ?? `Workflow returned HTTP ${walkStatus}`,
    }
  }
  // Every failure was absorbed by a completed bid_group; the 5xx came from the
  // terminal node's own response. Blame that node, not the handled blip.
  return {
    failedStep: lastCompletedNamespace ?? failedSteps[0].step_namespace,
    failedErrorType: 'permanent',
    errorMessage: `Workflow returned HTTP ${walkStatus}`,
  }
}

// Synchronously enqueue a step log entry. Writes are batched and flushed once
// at the end of execution (see flushStepLogs) instead of per-step, to avoid
// serializing graph walk on N Supabase inserts.
function logStep(
  queue: StepLogEntry[],
  executionId: string,
  executionStartedAt: string,
  node: NodeDefinition,
  status: StepStatus,
  input: unknown,
  output: unknown,
  errorMessage: string | undefined,
  errorType: ErrorType,
  retriesUsed: number,
  startedAt: string,
  stepOrder: number,
  parallelGroupId?: string,
  logs?: import('../types').StepLogEntry[]
): void {
  const completedAt = new Date().toISOString()
  const durationMs = Date.now() - new Date(startedAt).getTime()
  queue.push({
    execution_id: executionId,
    execution_started_at: executionStartedAt,
    step_namespace: node.namespace,
    step_node_id: node.id,
    step_type: node.type,
    step_subtype: deriveStepSubtype(node),
    status,
    input,
    output,
    logs: logs && logs.length > 0 ? logs : undefined,
    error_message: errorMessage,
    error_type: errorType,
    retries_used: retriesUsed,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    step_order: stepOrder,
    parallel_group_id: parallelGroupId,
  })
}

// Discriminator that powers the cross-workflow timeout-suggestion fallback.
// Salesforce: the op (create/update/query/etc.) is the only thing that meaningfully
// changes the duration distribution between two workflows.
function deriveStepSubtype(node: NodeDefinition): string | undefined {
  if (node.type === 'salesforce') {
    // Mirrors the Salesforce node executor's default — see apps/worker/src/engine/nodes/salesforce.ts.
    const op = node.config?.operation
    return typeof op === 'string' && op ? op : 'create'
  }
  return undefined
}

// Execute a single child node within a parallel group — simplified version of
// the main walkGraph step loop: retries + logging, but no on_error branching
// (parallel children always contribute their result, fulfilled or rejected).
export async function runParallelChild(
  child: NodeDefinition,
  ctx: ExecutionContext,
  env: Env,
  supabase: SupabaseClient,
  executionId: string,
  executionStartedAt: string,
  baseStepOrder: number,
  parallelGroupId: string,
  workflowVersionId = '',
  stepLogQueue: StepLogEntry[] = [],
  definition?: Pick<WorkflowDefinition, 'nodes' | 'edges'>,
  // Chain-walking only fires when a parallel_end exists for this parallel.
  // The walker follows edges until it reaches this node (or runs out).
  // Legacy parallels (no parallel_end) get single-node behavior.
  chainEndId?: string,
  // Tripped when the parent parallel stops waiting (timeout / first-winner /
  // specific-target). A late-completing child must not write a second step row
  // or overwrite ctx.steps after that (#63).
  abandonSignal?: AbortSignal
): Promise<ParallelChildResult> {
  // The slot's identifying namespace is always the FIRST node in the chain.
  // Bid Evaluation and other downstream consumers key off this namespace.
  const slotNamespace = child.namespace

  let current: NodeDefinition | undefined = child
  let chainIndex = 0
  let lastOutput: unknown = null

  while (current) {
    // parallel_end is the parent's responsibility — stop without executing.
    if (current.type === 'parallel_end') break

    const node = current
    const stepStartedAt = new Date().toISOString()
    log({ event: 'step_start', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type })

    const retryConfig = {
      retries: (node.config.retries as number) ?? 2,
      backoff: (node.config.retry_backoff as 'linear' | 'exponential') ?? 'exponential',
      timeout_ms: (node.config.timeout_ms as number) ?? 30000,
    }

    let output: unknown = null
    let stepStatus: StepStatus = 'completed'
    let errorMessage: string | undefined
    let errorType: ErrorType = null
    let stepLogs: import('../types').StepLogEntry[] | undefined
    let resolvedInput: ResolvedStepInput | null = null
    // Captures the real retry count from withRetry (mutated in place on both the
    // success and throw path) so this child's step log records it instead of 0.
    const retryStats = { retries: 0 }

    try {
      const result = await withRetry(
        (signal) => executeNode(node, ctx, env, supabase, signal),
        retryConfig,
        classifyStepError,
        retryStats
      )
      output = result.output
      stepLogs = result.logs
      resolvedInput = result.resolvedInput ?? null

      // Early-response and early-exit sentinels don't make sense inside a
      // parallel block — you can't respond or exit the workflow while sibling
      // children are still running.
      if (result.earlyResponse) {
        const r = result.earlyResponse
        const bodyStr = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
        const preview = bodyStr.length > 300 ? bodyStr.slice(0, 300) + '…' : bodyStr
        throw new Error(`Code returned a respond sentinel (status ${r.status}). Inside a parallel block, respond-and-exit is not meaningful — throw an error instead. Body: ${preview}`)
      }
      if (result.earlyExit) {
        throw new Error('Code returned an exit sentinel inside a parallel block. Early-exit is not supported for parallel children — throw an error instead.')
      }
    } catch (err) {
      stepStatus = 'failed'
      errorMessage = err instanceof Error ? err.message : String(err)
      errorType = err instanceof Response ? classifyHttpError(err.status) : classifyTransportError(err)
      const errLogs = (err as { logs?: import('../types').StepLogEntry[] }).logs
      if (errLogs) stepLogs = errLogs
      const errResolvedInput = extractResolvedInput(err)
      if (errResolvedInput) resolvedInput = errResolvedInput
    }

    const nodeDurationMs = Date.now() - new Date(stepStartedAt).getTime()
    if (stepStatus === 'completed') {
      log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: nodeDurationMs })
    } else {
      log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: nodeDurationMs, error_message: errorMessage, error_type: errorType })
    }

    // The parent already stopped waiting and (for an unsettled child) wrote a
    // synthesized timeout row. Recording now would append a SECOND conflicting
    // row and overwrite ctx.steps with this late output, so downstream reads of
    // steps.<child> become nondeterministic — bail without writing (#63). No
    // await between this check and the writes below, so it can't race the abort.
    if (abandonSignal?.aborted) {
      return { namespace: slotNamespace, status: 'timeout' }
    }
    recordStepOutput(ctx, node.namespace, { output, status: stepStatus, error: errorMessage, error_type: errorType })
    logStep(stepLogQueue, executionId, executionStartedAt, node, stepStatus, resolvedInput, output, errorMessage, errorType, retryStats.retries, stepStartedAt, baseStepOrder + chainIndex, parallelGroupId, stepLogs)

    if (stepStatus === 'failed') {
      // The slot's result is the FIRST node's namespace — but downstream chain
      // failures still surface as a slot rejection so executeParallelNode's
      // on_child_error policy applies.
      return { namespace: slotNamespace, status: 'rejected', error: errorMessage }
    }

    lastOutput = output

    // Walk to the next node in the chain. Stop at parallel_end, terminal
    // nodes, or when no edge matches. Without a definition or chain-end
    // anchor we can't walk safely, so the slot ends at this node (legacy
    // single-node behavior).
    if (!definition || !chainEndId) break
    const edges = outgoingEdges(node.id, definition.edges)
    let nextEdge: import('../types').EdgeDefinition | undefined

    if ((node.type === 'filter' || node.type === 'branch' || node.type === 'latency_gate') &&
        output !== null && typeof output === 'object') {
      const route = (output as Record<string, unknown>)._route as string | undefined
      if (route) nextEdge = edges.find((e) => e.source_handle === route)
    }
    if (!nextEdge) {
      nextEdge = edges.find((e) => evaluateEdge(e, ctx))
    }

    current = nextEdge ? findNode(nextEdge.target, definition.nodes) : undefined
    chainIndex++
  }

  return { namespace: slotNamespace, status: 'fulfilled', output: lastOutput }
}

// Cloudflare ExecutionContext type alias (avoid conflict with our ExecutionContext)
type ExecutionContext_CF = {
  waitUntil: (promise: Promise<unknown>) => void
}

// ── Code-node chain execution helpers ───────────────────────────────────────

import { codeBundleName, codeWorkerName } from '../lib/code-node-deployer'

interface ChainStepResult {
  namespace: string
  status: 'completed' | 'failed'
  output?: unknown
  error?: string
  durationMs: number
  sentinel?: { kind: 'response' | 'exit'; continueAfter: boolean }
  logs?: import('../types').StepLogEntry[]
}

/**
 * Walk forward from `start` (a code node) collecting adjacent code nodes that
 * can be run as a single chain. Chain ends when we hit:
 * - A non-code node (salesforce, filter, branch, parallel, etc.)
 * - A node with retries configured (retries handled per-step in main walker)
 * - A node with a circuit breaker service
 * - An edge with conditions (filter/branch handoff — needs main walker)
 * - A node with multiple incoming/outgoing edges (branching)
 * Returns [start, ...rest] — always includes `start`. Chain of 1 means no chain.
 */
// A code node is safe to BATCH into a chain dispatch only if it carries no custom
// retry / on_error / timeout config. Those take effect only on the single-node
// path (withRetry / on_error handling / withTimeout); a batched node bypasses all
// three. So a node that sets any of them must run individually to honor them (#62).
export function isChainableCodeNode(node: NodeDefinition): boolean {
  if (node.type !== 'code') return false
  const c = node.config ?? {}
  if ((c.retries as number | undefined) && (c.retries as number) > 0) return false
  if (c.on_error !== undefined && c.on_error !== 'fail') return false
  if (c.timeout_ms !== undefined) return false
  if (typeof c.service === 'string') return false
  return true
}

export function collectCodeChain(start: NodeDefinition, definition: { nodes: NodeDefinition[]; edges: import('../types').EdgeDefinition[] }): NodeDefinition[] {
  // If the START has custom retry/error/timeout config, don't batch it — return it
  // alone so the caller runs it on the single-node path that honors that config (#62).
  if (!isChainableCodeNode(start)) return [start]
  const chain: NodeDefinition[] = [start]
  let current = start
  // Safety cap — chains longer than 20 steps are unusual and we don't want to
  // send megabytes in a single subrequest.
  while (chain.length < 20) {
    const outs = definition.edges.filter((e) => e.source === current.id)
    if (outs.length !== 1) break
    const edge = outs[0]
    if (edge.condition) break
    const next = definition.nodes.find((n) => n.id === edge.target)
    if (!next || !isChainableCodeNode(next)) break
    const incoming = definition.edges.filter((e) => e.target === next.id)
    if (incoming.length !== 1) break
    chain.push(next)
    current = next
  }
  return chain
}

/**
 * Dispatch a chain of code nodes to the bundled worker's /execute-chain
 * endpoint. Returns per-step results including timing and sentinel detection.
 */
export async function executeCodeChain(
  chain: NodeDefinition[],
  ctx: ExecutionContext,
  env: Env
): Promise<{ results: ChainStepResult[] }> {
  // Withhold platform master secrets from the sandbox; partner creds + DB env
  // vars still flow (#108).
  const mergedEnv = { ...sandboxEnvBindings(env), ...ctx.env }

  const chainPayload = chain.map((n) => {
    const propsConfig = (n.config?.props ?? []) as Array<{ name: string; source: string }>
    const props: Record<string, unknown> = {}
    for (const p of propsConfig) {
      if (!p?.name || !p?.source) continue
      props[p.name] = resolveValue(p.source, ctx)
    }
    return { namespace: n.namespace, props }
  })

  // Scope the steps to the union of what the chain's scripts reference, so a
  // chained code node can't read step PII (SSNs, partner bids) it never touches
  // (#190). Any node using a dynamic access pattern → union is null → send all
  // (the safe fallback, matching the single-node path). The `payload` global is
  // still sent in full — payload field-scoping is tracked separately.
  const chainReferenced = unionReferencedSteps(chain.map((n) => (n.config?.script as string | undefined) ?? ''))
  const body = JSON.stringify({
    chain: chainPayload,
    payload: ctx.trigger.payload,
    steps: scopeSteps(ctx.steps, ctx.trigger.payload, chainReferenced),
    env: mergedEnv,
    execution: ctx.execution ?? { trace_id: ctx.trigger.trace_id },
  })

  // Bound the whole chain dispatch so a hung code node can't stall the walk
  // forever (#62). Chained nodes carry no custom timeout (isChainableCodeNode
  // excludes them), so each gets the default budget; the chain's budget is their
  // sum — the time it would take to run them one after another on the bundle.
  const chainTimeoutMs = chain.reduce((sum, n) => sum + ((n.config?.timeout_ms as number | undefined) ?? 30000), 0)
  const controller = new AbortController()
  const chainTimer = setTimeout(() => controller.abort(), chainTimeoutMs)

  const bundleBinding = env.DYNAMIC_WORKER_LOADER.get(codeBundleName(ctx.trigger.workflow_id))
  let bundleRes: Response | undefined
  let bindingError: unknown
  let timedOut = false
  try {
    bundleRes = await bundleBinding.fetch('https://worker/execute-chain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') timedOut = true
    else bindingError = err
  } finally {
    clearTimeout(chainTimer)
  }

  // A timeout fails the chain (the caller throws StepFailureError) — do NOT fall
  // back to per-node, which would re-run the chain and could repeat side effects.
  if (timedOut) {
    return { results: [{ namespace: chain[0].namespace, status: 'failed', error: `Code chain timed out after ${chainTimeoutMs}ms`, durationMs: chainTimeoutMs }] }
  }

  // Fallback: if the bundled worker is old (no /execute-chain) or missing,
  // run each step as an individual subrequest via the single-step path.
  const chainUnsupported =
    bindingError !== undefined ||
    bundleRes?.status === 404 ||
    bundleRes?.status === 503

  if (chainUnsupported || !bundleRes) {
    const results: ChainStepResult[] = []
    for (const node of chain) {
      const startMs = Date.now()
      try {
        const singleBody = JSON.stringify({
          payload: ctx.trigger.payload,
          // Scope to this node's referenced steps (#190), same as the bundled path.
          steps: scopeSteps(ctx.steps, ctx.trigger.payload, unionReferencedSteps([(node.config?.script as string | undefined) ?? ''])),
          env: mergedEnv,
          execution: ctx.execution ?? { trace_id: ctx.trigger.trace_id },
        })
        const perNodeBinding = env.DYNAMIC_WORKER_LOADER.get(codeWorkerName(ctx.trigger.workflow_id, node.namespace))
        const r = await perNodeBinding.fetch('https://worker/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: singleBody,
        })
        const text = await r.text()
        const output: unknown = text === '' || text === 'undefined' ? null : JSON.parse(text)
        const durationMs = Date.now() - startMs
        const sentinel = detectSentinel(output)
        recordStepOutput(ctx, node.namespace, { output, status: 'completed' })
        results.push({ namespace: node.namespace, status: 'completed', output, durationMs, sentinel: sentinel ?? undefined })
        if (sentinel) break
      } catch (err) {
        const durationMs = Date.now() - startMs
        results.push({ namespace: node.namespace, status: 'failed', error: err instanceof Error ? err.message : String(err), durationMs })
        break
      }
    }
    return { results }
  }

  if (!bundleRes.ok) {
    return {
      results: [{
        namespace: chain[0].namespace,
        status: 'failed',
        error: `Chain dispatch failed: HTTP ${bundleRes.status}`,
        durationMs: 0,
      }],
    }
  }

  const parsed = await parseJson<{ __bsv?: number; results: ChainStepResult[] }>(bundleRes)
  // Update ctx.steps for each successful result so downstream (non-chain) nodes
  // see them. The envelope flag (__bsv) is informational here — the chain
  // response shape is otherwise identical with or without log capture.
  for (const r of parsed.results) {
    if (r.status === 'completed') {
      recordStepOutput(ctx, r.namespace, { output: r.output ?? null, status: 'completed' })
    }
  }
  return { results: parsed.results }
}

function detectSentinel(output: unknown): { kind: 'response' | 'exit'; continueAfter: boolean } | null {
  if (output === null || typeof output !== 'object') return null
  const obj = output as Record<string, unknown>
  if ('response' in obj && obj.response !== null && typeof obj.response === 'object') {
    return { kind: 'response', continueAfter: obj.continueExecution === true }
  }
  if (obj.exit === true) return { kind: 'exit', continueAfter: false }
  return null
}
