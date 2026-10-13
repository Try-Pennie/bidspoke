import { uuidv7 } from '@bidspoke/uuidv7'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from '../lib/format-error'
import { checkResponseContract, reportResponseContract } from './response-contracts'
import { resolveFailedStepType } from '../lib/upstream-outage'
import { parseJson } from '../lib/json'
import { generateTraceId, deriveIdempotencyKey } from '../lib/crypto'
import { checkIdempotency, setIdempotencyProcessing, setIdempotencyResult, clearIdempotency } from './idempotency'
import { loadWorkflowDefinition } from './definition-loader'
import { loadEnvVars } from '../lib/env-loader'
import { buildSandboxEnv } from '../lib/sandbox-env'
import { loadPartnerConstants } from '../lib/partner-constants-loader'
import { buildContext, recordStepOutput, resolveValue } from './context'
import { executeNode, createNodeExecutor, type ExecuteNode } from './nodes/index'
import { executeParallelNode } from './nodes/parallel'
import type { ParallelChildResult, ParallelFailureCause } from './nodes/parallel'
import { executeBidGroupNode } from './nodes/bid-group'
import type { BidGroupAttempt, BidGroupOutput } from './nodes/bid-group'
import { executePartnerBidNode } from './nodes/partner-bid'
import { executeBuyerSelectNode, productionDeps as buyerSelectProductionDeps } from './nodes/buyer-select'
import { executeBuyerClickSendNode, productionDeps as buyerClickSendProductionDeps } from './nodes/buyer-click-send'
import { executeBuyerClickCheckNode, productionDeps as buyerClickCheckProductionDeps } from './nodes/buyer-click-check'
import { buildCodeStepInput, unionReferencedSteps, scopeSteps, codeDispatchTarget, bundleUnreachableMessage, bundleMissingForGood, type CodeDispatchTarget } from './nodes/code'
import { findEntryNode, outgoingEdges, findNode, evaluateEdge } from './graph'
import { classifyHttpError, classifyStepError, formatCodeErrorMessage, isDeterministicCodeError } from './error-classifier'
import { PartnerApiError } from './nodes/partner-bid'
import { withRetry } from './retry'
import { createExecutionRecord, updateExecutionRecord, flushStepLogs } from './step-logger'
import { fieldPresenceColumns, fieldPresenceForCapture, shouldLogCapture } from './field-presence'
import { detectDroppedEmail } from './dropped-fields'
import type { StepLogEntry } from './step-logger'
import { estimateStepBasedCost } from './cost-rates'
import {
  insertSighting,
  extractSightingFields,
  extractPersonFields,
  finalizeSighting,
  recordBidAttempt,
  computeSightingFinalize,
  buildSightingFinalizeProjection,
  extractExternalDebt,
  type SightingInsert,
} from './lead-sightings'
import { deriveCodeNodeBidAttempts } from './bid-log'
import { recordOutcomeDeadLetter, recordUnconfirmedOutcome, type OutcomeAlertDeps } from './durability'
import { captureFailedWriteback } from './writeback-deadletter'
import { CONTINUATION_UNFINISHED_LABEL } from './dead-letter-labels'
import { putAnswerJournal, type AnswerJournal } from './unconfirmed-writes'
import { redactPii, parsePiiFields } from './pii-redactor'
import { isNoRowMatchedError, NO_ROW_MATCHED_CODE, type DbError } from '../lib/db-retry'
import {
  PostResponseBudget,
  CONTINUATION_RESERVE_MS,
  DEAD_LETTER_RESERVE_MS,
  FINALIZE_RESERVE_MS,
  CONTINUATION_WINDOW_MS,
  realClock,
  withReserve,
  withinBudget,
  type RetryClock,
  type RetryTiming,
} from '../lib/post-response-budget'
import { resolveContinuationStatus } from './finalize-status'
import { listSteps, stepName } from './running-step'
import { formatSsn } from './persons-crypto'
import { extractAchieveEvaluations, insertAchieveEvaluations } from './achieve-log'
import { fireExecutionAlert } from '../lib/execution-alerts'
import { drainBlockSightings, noteCarriedBlockSightings } from './block-sightings'
import { noteSandboxBlocks } from './nodes/code'
import { readBlockRecords, type SandboxBlockRecord } from './code-response'
import { reportPartnerBlock, resolveSlackForBlockAlert, type PartnerBlockDeps } from '../lib/partner-block-alert'
import { makeAlertClaims } from '../lib/alert-claim'
import { getSlackConnection } from '../lib/slack'
import { readLastGoodSlackConnections } from '../lib/volume-cliff'
import { matchesMutedSignal } from '../lib/failure-rate'
import { classifyOutageCause } from '../lib/upstream-outage'
import { enforceSourceAssignment, SourceNotAuthorizedError, SourceAuthUnavailableError } from './source-assignment'
import { log } from '../lib/logger'
import { assertDefinitionRunsInLane, assertWorkflowServedInLane, laneRefusalFor, WorkflowLaneError, LaneRefusedNodeError } from './lane'
import { runRealityOfOptions, shadowRunRefusal, stampRunReality } from './run-reality'
import type { WorkflowLane } from '@bidspoke/node-types'
import type { Env } from '../index'
import type {
  ExecutionContext,
  NodeDefinition,
  StepStatus,
  ErrorType,
  WorkflowDefinition,
  ResolvedStepInput, PartnerBlockSighting } from '../types'

// Pull resolvedInput off a thrown error if the executor attached one. Mirrors
// the existing `(err as { logs?: ... }).logs` pattern used a few lines below
// for captured console output. Lets failed nodes still surface their input.
function extractResolvedInput(err: unknown): ResolvedStepInput | null {
  const tagged = err as { resolvedInput?: ResolvedStepInput } | undefined
  return tagged?.resolvedInput ?? null
}

// Carries step context through the throw so the alert can report which step failed.
// `resolvedInput` is the request the failed step sent, as its executor attached it
// (#1992): a post-answer Salesforce write that fails is replayed from it (#1993,
// #471), and nothing else the run keeps can rebuild the exact patch. Same field
// name as the executors' own errors, so `extractResolvedInput` reads either.
class StepFailureError extends Error {
  constructor(
    message: string,
    public readonly stepNamespace: string,
    public readonly errorType: ErrorType,
    public readonly suppressAlert: boolean = false,
    public readonly resolvedInput: ResolvedStepInput | null = null,
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

/**
 * What a run executes under (#1707, plan 0.C): the lane this Worker serves, the
 * client config is read through, and the client the run is written through.
 */
export interface EngineRuntime {
  lane: WorkflowLane
  config: SupabaseClient
  run: SupabaseClient
  /**
   * The clock the run's post-response retry ladders wait on (#1850). Absent in
   * production, which uses real time; a test passes one it drives.
   */
  clock?: RetryClock
  /**
   * Receives each step record as the engine queues it (#1305). The outage drill
   * reads a run's decisions from it, because in a database outage the step rows
   * are never written. Production never sets it.
   */
  observeStep?: (entry: StepLogEntry) => void
}

/** The bidding Worker's runtime: one client for config and run alike. */
export function moneyRuntime(supabase: SupabaseClient): EngineRuntime {
  return { lane: 'money', config: supabase, run: supabase }
}

export { WorkflowLaneError, LaneRefusedNodeError }
export { ShadowRunRefusedError } from './run-reality'

/**
 * The node executor a walk runs under (#1725). The money lane's is
 * `executeNode`, built once as createNodeExecutor('money'); any other lane gets
 * a registry filtered to its own node types, which holds no money executor.
 * The one place the engine names the money executor: every step the walk runs
 * goes through what this returns, so the walk cannot reach money code by
 * calling it directly.
 */
export function nodeExecutorForLane(lane: WorkflowLane): ExecuteNode {
  return lane === 'money' ? executeNode : createNodeExecutor(lane)
}

/**
 * A run's walk still running at its cut-off after the answer (#1860). Its outcome
 * is unknown, not failed: it may still finish, but nothing confirmed it. It names
 * the step or steps the walk was on (#1882), so the reason and the alert point at
 * what was slow rather than at a guess.
 */
class ContinuationUnfinishedError extends Error {
  constructor(seconds: number, readonly stillRunning: readonly string[]) {
    const running = stillRunning.length > 0 ? ` Still running then: ${listSteps(stillRunning)}.` : ''
    super(`The run's work after the answer did not finish within ${seconds} s of the answer.${running} It may still finish, but nothing confirmed it.`)
    this.name = 'ContinuationUnfinishedError'
  }
}

export async function executeWorkflow(
  options: ExecuteOptions,
  env: Env,
  runtime: EngineRuntime,
  executionCtx: ExecutionContext_CF
): Promise<ExecuteResult> {
  const { workflowId, payload, source } = options
  const traceId = generateTraceId()
  // Config is read through one client and the run written through the other
  // (#1707). The money Worker passes its one client as both; node executors
  // take the config client, and every money node also writes its own rows
  // through it, which is the same client in the money lane and never runs in
  // the ops lane.
  const { config: configDb, run: runDb } = runtime
  // One deadline for every write this run makes after its response (#1850).
  // Cloudflare cancels waitUntil work 30 seconds after the response, shared by
  // every waitUntil of the request, so the ladders below share this budget
  // rather than each carrying a span of its own. It starts when the response
  // goes out (`postResponse.arm()` below); nothing before that is bounded here.
  //   writeTiming: a write whose loss is dead-lettered stops retrying, and
  //     stops waiting, DEAD_LETTER_RESERVE_MS before the deadline, so the dead
  //     letter still fits.
  //   beforeFinalizeTiming: the create and the step flush stop retrying earlier,
  //     because finalize can rebuild a missing execution row by itself. The step
  //     log re-flush after a rebuild uses it too (#688), so that re-flush, now
  //     awaited before the demotion update, leaves that update room to confirm.
  const retryClock = runtime.clock ?? realClock
  const postResponse = new PostResponseBudget(retryClock)
  const writeTiming: RetryTiming = { clock: retryClock, budget: postResponse, reserveMs: DEAD_LETTER_RESERVE_MS }
  const beforeFinalizeTiming = withReserve(writeTiming, FINALIZE_RESERVE_MS)
  const continuationTiming = withReserve(writeTiming, CONTINUATION_RESERVE_MS)
  // What kind of run this is, decided once (#1708).
  const reality = runRealityOfOptions(options, env)

  // Load workflow definition (KV-cached), allowing a caller-supplied override (e.g. test runs with unsaved changes).
  // Test runs bypass the is_active filter so authors can iterate before flipping a workflow live.
  const loaded = await loadWorkflowDefinition(workflowId, env.WORKFLOW_CACHE, configDb, {
    allowInactive: reality.isTest,
  })
  const { workflow_version_id, workflow_name, org_id, slack_channel } = loaded
  const definition = options.definitionOverride ?? loaded.definition
  // Before anything is recorded or run: a workflow stored under another lane is
  // not this Worker's to run, and a definition (a test run's unsaved override
  // included) may carry only node types its lane can run.
  assertWorkflowServedInLane(workflowId, loaded.lane, runtime.lane)
  assertDefinitionRunsInLane(definition, runtime.lane)
  // A shadow run must send nothing, so one carrying code nodes with no compare
  // bundle deployed for its scripts to run in is refused here (#1780, #1708).
  const shadowRefusal = shadowRunRefusal(definition, reality, options.codeBundleName)
  if (shadowRefusal) throw shadowRefusal

  if (options.enforceSourceAssignment) {
    await enforceSourceAssignment(configDb, org_id, source, workflowId)
  }

  // Resolve idempotency key (needs definition)
  const idempotencyConfig = definition.trigger.config.idempotency
  let resolvedIdempotencyKey: string | null = null

  if (idempotencyConfig?.enabled) {
    resolvedIdempotencyKey = options.idempotencyKeyHeader ?? null
    if (!resolvedIdempotencyKey && idempotencyConfig.derive_from_fields?.length) {
      resolvedIdempotencyKey = await deriveIdempotencyKey(payload, idempotencyConfig.derive_from_fields)
      if (resolvedIdempotencyKey === null) {
        // Every configured derive field was absent/empty. Rather than hash a
        // constant key (which would let unrelated malformed leads share a cache
        // entry), we skip idempotency for this run and flag it — a persistent
        // stream of these means the derive_from_fields config no longer matches
        // the incoming payload shape.
        log({
          event: 'idempotency_derive_empty',
          trace_id: traceId,
          workflow_id: workflowId,
          fields: idempotencyConfig.derive_from_fields,
        })
      }
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
  const useIdempotency = idempotencyKey !== null && !reality.isTest

  // Parallel: idempotency check + env var load (both independent once we have definition/org_id)
  // UUIDv7, so the execution archive can derive the UTC day from the id in the URL
  // and prune a point lookup to one day of micro-partitions (#869). Time ordered
  // is the whole point: a random id prunes nothing and would need paid Search
  // Optimization on a table that grows forever. `lead_sightings.id` deliberately
  // stays random; only the execution id changes.
  const executionId = options.executionId ?? uuidv7()
  const startedAt = new Date().toISOString()

  const [idempotencyCached, envVars] = await Promise.all([
    useIdempotency && !isRecoveryRun
      ? checkIdempotency(env.IDEMPOTENCY, workflowId, source, idempotencyKey)
      : Promise.resolve(null),
    // The org values with this workflow's own laid over them (#1681). Live,
    // test, resume, replay and shadow runs all come through here.
    loadEnvVars(org_id, env.WORKFLOW_CACHE, configDb, secretKeys(env), { workflowId }),
    // Pre-warm partner constants KV so constants node finds a hot cache instead of
    // paying the Supabase roundtrip cost mid-execution. Swallow errors — the constants
    // node retries on its own access and surfaces any real failure there.
    loadPartnerConstants(org_id, env.WORKFLOW_CACHE, configDb).catch(() => undefined),
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
    ? setIdempotencyProcessing(env.IDEMPOTENCY, workflowId, source, idempotencyKey, ttl)
    : Promise.resolve()
  const executionRecordPromise = createExecutionRecord(runDb, {
    id: executionId,
    workflow_id: workflowId,
    workflow_version_id,
    source,
    trigger_payload: payload,
    trace_id: traceId,
    started_at: startedAt,
    is_test: reality.isTest,
    parent_execution_id: options.parentExecutionId ?? options.resumeFromExecutionId,
    resumed_from_execution_id: options.resumeFromExecutionId,
  }, undefined, beforeFinalizeTiming)
  // Whether the row above is known to exist, read by the finalize dead letter
  // (#1850): a finalize lost on a row that exists leaves it at 'running' for the
  // strand drain, and one lost on a row that was never created leaves nothing.
  let executionRowConfirmed = false
  executionRecordPromise.then(() => { executionRowConfirmed = true }, () => {})

  log({ event: 'execution_start', trace_id: traceId, workflow_id: workflowId, workflow_version_id, execution_id: executionId })

  // Lead sighting trigger boundary: insert the in_flight sighting before the walk
  // starts. Snowflake mirror is populated nightly. Writes run in waitUntil;
  // failures don't block the workflow.
  //
  // EVERY workflow records. A test run is the only exclusion (#882). The
  // per-workflow opt-out was removed because it was false on Main Flow, the live
  // flow carrying the Equifax credit report, so ~3,600 leads a day produced no
  // sighting, nothing in Snowflake, and an execution that truncates at 7 days:
  // no durable record anywhere. audit_log has recorded that field since the
  // feature shipped and holds no change to it, so it was set outside the
  // application and who, when and why are unrecoverable.
  //
  // The workflows capture-sightings column still exists but nothing reads it
  // (expand now, contract later, ADR 0007), so a stale false in a production row
  // cannot suppress a sighting. A guard enforces that nothing reads it again.
  const sightingId = reality.isTest ? undefined : crypto.randomUUID()
  // Tier-2 outcome-write alert deps (#309): route the engine's lead_sightings /
  // lead_sighting_bids writes through writeOutcome so a loss after retries
  // dead-letters instead of vanishing into a log line.
  // The run rides along so a write that times out is recorded against it (#1880).
  const outcomeDeps: OutcomeAlertDeps = {
    kv: env.IDEMPOTENCY,
    orgId: org_id,
    appUrl: env.APP_URL,
    timing: writeTiming,
    run: { workflow_id: workflowId, workflow_name, execution_id: executionId },
    // One alert per (org, label, cause) per window, decided atomically (#1881).
    claims: env.ALERT_CLAIM ? makeAlertClaims(env.ALERT_CLAIM) : undefined,
  }

  // Awaited by the finalize block below: finalize UPDATEs the row this promise
  // INSERTs, and both run in waitUntil after the response is sent. Left
  // unawaited, finalize beat the insert on ~18% of live leads and its UPDATE
  // matched a row that did not exist yet.
  let sightingWritePromise: Promise<void> = Promise.resolve()
  // Held so the finalize can rebuild the row from the same fields if the insert
  // failed in the schema-cache / purge-lock window (#686). Null for a test run or
  // when capture is off, where no sighting is written.
  let sightingInsert: SightingInsert | null = null

  if (sightingId) {
    const sightingPayloadFields = extractSightingFields(payload)
    const personFields = extractPersonFields(payload)
    const startedAtDate = new Date(startedAt)
    const insert: SightingInsert = {
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
      // Always null since #765 removed the persons write. lead_sightings.ssn
      // above is the value the Snowflake export and repeat-lead grouping read;
      // person_id was only ever a pointer into a table nothing read back.
      person_id: null,
    }
    // Held for the finalize's reconstruction path (#686).
    sightingInsert = insert
    sightingWritePromise = insertSighting(runDb, insert, outcomeDeps)
      .then(() => {})
      .catch((e) => console.error('[lead-sightings] trigger boundary write failed:', e))
    executionCtx.waitUntil(sightingWritePromise)
  }

  // Build execution context
  const ctx = buildContext(payload, source, workflowId, traceId, envVars, org_id, executionId, env.APP_URL, sightingId)
  if (options.codeBundleName) ctx.codeBundleName = options.codeBundleName
  // Node executors only ever see the context, so the test flag and shadow mode ride
  // along on it. The circuit-breaker trip alert needs it to stay silent on Test
  // Runner runs (#547).
  stampRunReality(ctx, options)
  // The lead_sighting_bids rows nodes write are usually still retrying after
  // the response when the database is down, so they take the same budget.
  ctx.retryTiming = writeTiming
  // A node that must never repeat a send refuses a recovery run (#1542): resume re-runs
  // every node from the entry, so it would post a click a second time.
  if (options.resumeFromExecutionId) ctx.recovery = 'resume'
  else if (options.parentExecutionId) ctx.recovery = 'replay'

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
  if (runtime.observeStep) {
    // Every step is queued through push (logStep), so this sees each one as it is
    // recorded, whether or not it is ever flushed.
    const observe = runtime.observeStep
    const push = stepLogQueue.push.bind(stepLogQueue)
    // Not enumerable, so the queue still reads as a plain array of steps to
    // anything that walks its keys.
    Object.defineProperty(stepLogQueue, 'push', {
      value: (...entries: StepLogEntry[]) => {
        for (const entry of entries) observe(entry)
        return push(...entries)
      },
      enumerable: false,
    })
  }

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

  // Partner block sightings (#1265) are reported in the background from here, the one
  // place the Cloudflare context, the Supabase client and the Worker Env are all in hand.
  // Test runs and local dev log the event and post nothing, like every engine alert (#547).
  const blockDeps: PartnerBlockDeps = {
    kv: env.IDEMPOTENCY,
    claims: env.ALERT_CLAIM ? makeAlertClaims(env.ALERT_CLAIM) : undefined,
    resolveSlack: async () => {
      const conn = await resolveSlackForBlockAlert(
        org_id,
        () => getSlackConnection(configDb, org_id),
        () => readLastGoodSlackConnections(env.IDEMPOTENCY, secretKeys(env)),
      )
      return conn ? [conn] : []
    },
    silent: reality.silentAlerts,
    appUrl: env.APP_URL,
  }
  const onBlockSighting = (sighting: PartnerBlockSighting): void => {
    executionCtx.waitUntil(
      reportPartnerBlock(blockDeps, { orgId: org_id, workflowId, workflowName: workflow_name, traceId: ctx.trigger.trace_id }, sighting)
        .catch((e: unknown) => console.error(`[partner-block] report failed trace=${ctx.trigger.trace_id}: ${formatErr(e)}`)),
    )
  }

  const walkPromise = walkGraph(
    ctx, definition, executionId, startedAt, configDb, env, runtime.lane, workflow_version_id, stepLogQueue,
    (r) => earlyResponseResolve(r),
    onBlockSighting
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
    errorMessage = formatErr(err)
    if (err instanceof StepFailureError) {
      failedStep = err.stepNamespace
      failedErrorType = err.errorType
      failedSuppressAlert = err.suppressAlert
    } else {
      // #485: anything that escapes the walk WITHOUT being a StepFailureError is
      // a defect in the graph or the engine, not a lead we chose to reject: an
      // unknown condition operator, a missing fallback node, a stray TypeError.
      // The alert gate reads a null type as a clean business rejection and stays
      // silent, so leaving it null let a bad workflow edit fail every lead with
      // no page. Classify it 'permanent' (retrying won't help) so the gate opens.
      // Only StepFailureError may carry null, because that IS the rejection path.
      failedErrorType = 'permanent'
    }
    response = { error: errorMessage, trace_id: traceId }
  }

  // Response contract check (#933). Placed here, after every branch above has
  // assigned `response`, because this is the ONE point all three converge: the
  // early response, the completed walk, and the engine-error body. A check per
  // branch would have nowhere its own completeness could be seen, and the branch
  // added next year would simply not have one (L94).
  //
  // It reports and never blocks. A rejection missing a field is still a usable
  // rejection; refusing to send it turns that into a 500 and breaks the
  // integration, which is worse for the partner than the defect.
  //
  // Note this deliberately judges the error body above too. That shape is
  // { error, trace_id }, and trace_id is OUR identifier, so a partner receiving
  // one cannot tie it to the lead it sent. It reports as an unrecognised family,
  // which is the honest verdict rather than a pass.
  reportResponseContract(checkResponseContract(workflowId, response), {
    workflowId,
    executionId,
    traceId,
  })

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
  //
  // #1850: the wait for the create and the flush stops at the write cut-off, so
  // a database that never answers cannot hold finalize, and the dead letter
  // behind it, past Cloudflare's limit. The walk itself is not raced here.
  //
  // #1860: and the wait for the walk itself stops too. A run that answered early
  // keeps walking after the response; a walk still out at its cut-off is reported
  // to finalize as unfinished (it may still finish, nothing confirmed it), so the
  // flush and finalize behind it still run inside the budget. A test run waits
  // for its whole walk, as before.
  const walkSettled: Promise<unknown> = reality.isTest
    ? walkPromiseCaught
    : withinBudget(walkPromiseCaught, continuationTiming).then((o) =>
        o.settled
          ? o.value
          : { __error: new ContinuationUnfinishedError(CONTINUATION_WINDOW_MS / 1000, [...(ctx.runningSteps ?? [])]) },
      )
  // #1881: a flush that RETURNED an error and one that only timed out are kept
  // apart. The first is a lost trace and the run fails as before; the second
  // says nothing about whether the rows landed, so the run is degraded and the
  // rows are read back by the minute sweep.
  const flushPromise: Promise<{ error: string | null; unconfirmed: string | null }> = walkSettled
    .then(() =>
      withinBudget(
        executionRecordPromise.then(() =>
          flushStepLogs(runDb, stepLogQueue, env.PII_REDACTION_FIELDS ?? '', { workflowId, isTest: reality.isTest }, beforeFinalizeTiming),
        ),
        // Stops at finalize's reserve, not the dead letter's: a create or flush
        // that never answers must leave finalize its time (#1860 review).
        beforeFinalizeTiming,
      ),
    )
    .then((flushed) =>
      flushed.settled
        ? { error: flushed.value, unconfirmed: null }
        : {
            error: null,
            unconfirmed:
              'the execution record and step rows did not answer within the post-response budget; they may still land, but nothing confirmed them',
          },
    )
    .catch((e) => {
      console.error('[step-logger] flush failed:', e)
      return { error: formatErr(e), unconfirmed: null }
    })

  if (reality.isTest) {
    // Test mode: wait for everything so the UI sees a complete step list.
    await walkPromiseCaught
    await flushPromise
  } else {
    executionCtx.waitUntil(flushPromise)
    if (hasContinuation) executionCtx.waitUntil(walkPromiseCaught)
    // Also keep idempotencyProcessing alive past the response so it can complete
    executionCtx.waitUntil(idempotencyProcessingPromise.catch(() => {}))
  }

  // The response goes out when this function returns, with nothing awaited
  // between here and there: Cloudflare's waitUntil clock starts now (#1850).
  postResponse.arm()

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
  //
  // #1883: the finalize goes out at the answer (once the walk has settled, which
  // for a run without work after its answer is at once), BESIDE the step write,
  // not behind it. Behind it, it went out only when the step write gave up, 15 s
  // after the answer, and on 2026-10-08 five runs' finalizes queued that late never
  // ran. Only the flush's own demotion (step logs failed, or unconfirmed) waits for
  // the flush, as a small second update.
  executionCtx.waitUntil(
    walkSettled
      .then(async (walkResult) => {
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

        // Status means "was the lead served correctly", not "did every
        // post-response side-effect succeed". A served-correctly run whose
        // post-response continuation (the Salesforce writeback after the Offer
        // Response) later threw is 'degraded' — visible, but NOT a hard 'failed'
        // that per-run pages; the failure dead-letters instead (#310). The
        // genuine backstops — step-log persistence failure (data loss) and
        // never-advanced — mean the lead was NOT served correctly and stay
        // 'failed'. The HTTP response already sent is unaffected; response_status
        // below still records what the caller received.
        // The flush is not known yet: it is weighed after the first update.
        let finalStatus = resolveContinuationStatus(executionStatus, {
          hasContinuationError: continuationError != null,
          hasFlushError: false,
          hasFlushUnconfirmed: false,
          neverAdvanced: finalNodeNamespace == null,
        })
        let finalErrorMessage = errorMessage
        if (finalStatus === 'degraded' && continuationError) {
          if (continuationError instanceof StepFailureError) {
            failedStep = continuationError.stepNamespace
            failedErrorType = continuationError.errorType
            failedSuppressAlert = continuationError.suppressAlert
          } else {
            failedErrorType = failedErrorType ?? 'permanent'
          }
          finalErrorMessage = formatErr(continuationError)
          // Tier-3 (external SF writeback) dead-letter: the node's own withRetry
          // already provided at-least-once, so this only surfaces exhaustion via
          // the rate-aggregated alert — no per-run page. Gated like the failure
          // alert: skip business rejections (errorType null), suppressed,
          // muted, and shared-upstream-outage signals.
          if (
            failedErrorType !== null &&
            !failedSuppressAlert &&
            !reality.isTest &&
            !matchesMutedSignal(finalErrorMessage, mutedFailureSignals) &&
            !classifyOutageCause(finalErrorMessage)
          ) {
            // A walk still out at its cut-off is not a failed write: its outcome is
            // unknown, so it is counted under its own label (#1860).
            const label = continuationError instanceof ContinuationUnfinishedError ? CONTINUATION_UNFINISHED_LABEL : 'sf_writeback'
            executionCtx.waitUntil(
              recordOutcomeDeadLetter(label, continuationError, { ...outcomeDeps, supabase: runDb }, {
                workflow_id: workflowId, workflow_name, execution_id: executionId, at: new Date().toISOString(),
                ...(continuationError instanceof ContinuationUnfinishedError && continuationError.stillRunning.length > 0
                  ? { still_running: [...continuationError.stillRunning] }
                  : {}),
              }).catch((e) =>
                console.error(`[durability] ${label} dead-letter failed:`, e),
              ),
            )
          }
          // Keep a failed post-answer Salesforce write for replay (#1993), outside
          // every alert gate above: a classified Salesforce outage, which the alert
          // stays quiet for, is exactly when these writes fail. A test run stores
          // nothing; anything not a Salesforce write is left alone by the capture.
          if (continuationError instanceof StepFailureError) {
            const failedNodeType = definition.nodes.find((n) => n.namespace === continuationError.stepNamespace)?.type
            if (failedNodeType === 'salesforce') {
              // Started inside the promise, so nothing about the key ring can throw
              // into the finalize: every failure lands in the capture's own handling.
              executionCtx.waitUntil(
                Promise.resolve().then(() => captureFailedWriteback(
                  {
                    orgId: org_id,
                    workflowId,
                    workflowName: workflow_name,
                    executionId,
                    stepNamespace: continuationError.stepNamespace,
                    nodeType: failedNodeType,
                    errorType: continuationError.errorType,
                    error: continuationError,
                    resolvedInput: continuationError.resolvedInput,
                    isTest: reality.isTest,
                  },
                  { ...outcomeDeps, supabase: runDb, encryptionKeys: secretKeys(env) },
                )).catch((e) => console.error('[durability] failed writeback capture threw:', formatErr(e))),
              )
            }
          }
        } else if (finalStatus === 'failed' && executionStatus === 'completed' && finalNodeNamespace == null) {
          failedErrorType = failedErrorType ?? 'permanent'
          finalErrorMessage = 'Execution did not advance past the trigger — no step completed.'
        }

        const passedThroughSuccessNode = successNamespaces.some(
          (ns) => ctx.steps[ns]?.status === 'completed'
        )
        let outcome: 'successful' | 'completed' | 'failed' =
          finalStatus === 'failed'
            ? 'failed'
            : passedThroughSuccessNode ? 'successful' : 'completed'
        const cost = estimateStepBasedCost(stepLogQueue)
        const finalNodeId = finalNodeNamespace
          ? definition.nodes.find((n) => n.namespace === finalNodeNamespace)?.id ?? null
          : null
        // #353 Phase 1: project the rich sighting-finalize fields (winner/bid/
        // enrichment/reject_reason/outcome + per-attempt bid rows) onto the
        // execution record — the write that empirically survives isolate eviction
        // for strands — so the strand drain can later recover them with full
        // fidelity instead of a reduced finalize. The gate (capture on, non-test)
        // mirrors the live finalize below and lives in the shared helper.
        //
        // LOAD-BEARING INVARIANT (#377): winning leads do not strand, so the
        // strand drain's winner-flip path has never run in production and is
        // validated only synthetically (#366). That holds only because the
        // winning Engine path does post-response work. After the Offer Response
        // is sent, the walk continues to the Salesforce prospect writeback
        // (patch_prospect), and that continuation is what keeps the isolate alive
        // long enough for the finalize below to land (0 of 5,450 winners stranded
        // in a 48h sample). If the Engine flow is ever reordered so the writeback
        // runs BEFORE the response, or is removed, winners would begin stranding
        // onto the untested in production winner flip path. The invariant is
        // guarded against the in repo definition snapshot in
        // engine/__tests__/winner-no-strand-invariant.test.ts and recorded in
        // docs/adr/0002-observability-vs-outcome-write-tiers.md.
        const sightingFinalize = buildSightingFinalizeProjection(
          ctx.steps,
          definition.nodes,
          {
            lastCompletedNamespace: finalNodeNamespace,
            walkStatus,
            executionStatus,
            successNamespaces,
            // Carried onto the durable projection so a stranded lead recovers its
            // debt rather than coming back with every other field intact and this
            // one silently null (#1212).
            externalDebt: extractExternalDebt(ctx, definition.nodes),
          },
          { sightingId, isTest: reality.isTest },
        )
        // Field-presence capture (#419, #420): one boolean per watched field,
        // computed from in-memory ctx.steps (raw, before PII redaction in
        // flushStepLogs); only booleans persist, so no value leaves the worker.
        const fieldPresence = fieldPresenceForCapture(env.FIELD_PRESENCE_CAPTURE, ctx.steps, definition)
        // #744: the Salesforce node blanks a rejected email and retries, so the
        // run SUCCEEDS and there is no failed execution to hang a rate off. This
        // per-execution boolean is what makes the drop countable per source after
        // the step logs are purged. Written only when true, so the column stays
        // null for the overwhelming majority of runs.
        const emailDropped = detectDroppedEmail(ctx.steps, definition.nodes)
        // Heartbeat log sampled to ~1% (#434): the column is written every run
        // below, but logging every run is ~500K lines/month for a dark feature.
        if (fieldPresence && shouldLogCapture(executionId)) {
          console.log('[field-presence] captured', {
            workflowId,
            executionId,
            watched: Object.keys(fieldPresence).length,
            present: Object.values(fieldPresence).filter(Boolean).length,
          })
        }
        // #629: set when finalize had to reconstruct a missing base row. The
        // step-log flush for this run was chained on the createExecutionRecord
        // insert, which failed, so it never ran and left no trace. Once the
        // parent row exists again we re-flush the queue below.
        let reconstructed = false
        const responseStatus = executionStatus === 'completed' ? walkStatus : 500
        // #1883: the answer, journaled in KV beside the update, so a run whose
        // update never lands still says what the caller was told. Redacted with
        // the step rows' field list. Rewritten below if the flush demotes the run.
        // Each write is chained on the one before, so a demotion's journal can
        // never be overwritten by a slower first write of the same key.
        let journalWritten: Promise<void> = Promise.resolve()
        // Never throws: an answer the journal cannot hold (one JSON cannot
        // serialise) must not stop the finalize behind it.
        const journalAnswer = (status: string, runOutcome: string, message: string | undefined) => {
          try {
            writeJournal(status, runOutcome, message)
          } catch (e) {
            console.error('[answer-journal] could not build the journal:', formatErr(e))
          }
        }
        const writeJournal = (status: string, runOutcome: string, message: string | undefined) => {
          if (reality.isTest) return
          const journal: AnswerJournal = {
            execution_id: executionId,
            started_at: startedAt,
            status,
            outcome: runOutcome,
            final_node_namespace: finalNodeNamespace,
            final_node_id: finalNodeId,
            completed_at: completedAt,
            duration_ms: durationMs,
            response_status: responseStatus,
            response_body: journalBody(response, env.PII_REDACTION_FIELDS ?? ''),
            error_message: message ?? null,
            failed_step_type: resolveFailedStepType(definition.nodes, failedStep) ?? null,
            ...(sightingFinalize ? { sighting_finalize: sightingFinalize } : {}),
            cost_usd: cost,
            ...fieldPresenceColumns(fieldPresence),
            ...(emailDropped ? { email_dropped: true } : {}),
            written_at: new Date().toISOString(),
          }
          // KV takes about one write a second to a key, so a demotion written
          // right after the first write can be refused: it is tried once more
          // a second later, on the run's own clock.
          journalWritten = journalWritten
            .then(() => putAnswerJournal(env.IDEMPOTENCY, journal))
            .catch(() => retryClock.sleep(1_100).then(() => putAnswerJournal(env.IDEMPOTENCY, journal)))
            .catch((e) => console.error('[answer-journal] write failed:', formatErr(e)))
          executionCtx.waitUntil(journalWritten)
        }
        journalAnswer(finalStatus, outcome, finalErrorMessage)
        // #1850: the finalize ladder stops at the write cut-off and the wait for
        // it stops there too, so the dead letter below is written before
        // Cloudflare cancels this work. An update still unanswered then is not
        // cancelled and may land; it is recorded as unconfirmed (#1880).
        const finalized = await withinBudget(updateExecutionRecord(runDb, executionId, startedAt, {
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
          response_status: responseStatus,
          error_message: finalErrorMessage,
          // Node type of the failed step, so the upstream-outage aggregation can
          // attribute a generic timeout/abort to the right service (#332).
          failed_step_type: resolveFailedStepType(definition.nodes, failedStep),
          cost_usd: cost,
          ...(sightingFinalize ? { sighting_finalize: sightingFinalize } : {}),
          ...fieldPresenceColumns(fieldPresence),
          ...(emailDropped ? { email_dropped: true } : {}),
        }, {
          // #584: hand finalize the create fields so a missing base row (a
          // permanent createExecutionRecord insert failure) is reconstructed from
          // them plus the final-state update above, rather than lost. Mirrors the
          // createExecutionRecord call earlier in this function.
          workflow_id: workflowId,
          workflow_version_id,
          source,
          trigger_payload: payload,
          trace_id: traceId,
          is_test: reality.isTest,
          parent_execution_id: options.parentExecutionId ?? options.resumeFromExecutionId,
          resumed_from_execution_id: options.resumeFromExecutionId,
        }, () => { reconstructed = true }, writeTiming), writeTiming)
        // A finalize that only timed out is not a lost record: it is read back
        // by the minute sweep, which dead-letters it only if the row never
        // reached a terminal status (#1880). On 2026-10-08 every one of the
        // finalizes a 90 second stall timed out had landed.
        const finalizeUnconfirmed = !finalized.settled
        const finalizeError = finalized.settled ? finalized.value : null
        if (finalizeUnconfirmed) {
          // Logged for every run, a test run included, which records no entry.
          console.warn('[execution] finalize did not answer within the post-response budget; it may still land', {
            executionId,
            isTest: reality.isTest,
          })
        }
        if (finalizeUnconfirmed && !reality.isTest) {
          executionCtx.waitUntil(
            recordUnconfirmedOutcome(
              'execution_finalize',
              { kind: 'execution_finalized', execution_id: executionId, started_at: startedAt },
              {
                message: `workflow_executions (id=${executionId}): the finalize did not answer within the post-response budget; it may still land, but nothing confirmed it`,
              },
              { ...outcomeDeps, supabase: runDb },
            ),
          )
        }

        // The finalize UPDATE is the only durable record that this lead was
        // served. If it matched zero rows the execution row is gone entirely
        // (its insert failed permanently); if it exhausted the retry ladder the
        // row is stranded at 'running'. Both are invisible to the dashboards, so
        // dead-letter them through the same rate-aggregated alert the SF
        // writeback uses rather than accepting the loss silently (#487).
        if (finalizeError && !reality.isTest) {
          executionCtx.waitUntil(
            recordOutcomeDeadLetter('execution_finalize', finalizeLossOf(finalizeError, executionRowConfirmed, executionId), { ...outcomeDeps, supabase: runDb }).catch((e) =>
              console.error('[durability] execution_finalize dead-letter failed:', e),
            ),
          )
        }

        // The step write, weighed now (#1883). It ran beside the update above; only
        // its demotion waited for it. A flush that returned an error fails the run,
        // as before; one that only timed out degrades it (#1881, part of #688).
        const flushed = await flushPromise
        const flushError = flushed.error
        const flushUnconfirmed = flushed.unconfirmed

        // #629/#688: when the base row was missing and reconstructed, the original
        // flush never ran (it was chained on the failed create), so flushPromise's
        // error is the create rejection, not a step result. Re-flush the queue to
        // recover the trace and AWAIT it: it is the authoritative step-persist
        // signal and decides the final status below (#688). Done AFTER awaiting
        // flushPromise, which has already bounded the wait on the create, so:
        //  - flush settled: the create has settled too, so the createFailed check
        //    returns at once (no unbounded wait), and the re-flush runs ONLY when
        //    the create genuinely failed, never when it landed late (which would
        //    write the rows twice, since the original flush already wrote them).
        //  - flush unconfirmed: the create did not answer in budget, so the re-flush
        //    is skipped (it could double-write if the create then lands); the steps
        //    are unconfirmed and read back by the minute sweep.
        // It is bounded by beforeFinalizeTiming so it leaves the demotion update
        // room; a re-flush that cannot answer is unconfirmed, not a loss. An empty
        // queue re-flushes nothing but is still not judged by the create rejection,
        // because reconstructedCreateFailed below ignores flushError.
        let reflushRan = false
        let reflushError: string | null = null
        let reflushUnconfirmed = false
        let createFailedAtFlush = false
        if (reconstructed && !flushUnconfirmed) {
          createFailedAtFlush = await executionRecordPromise.then(() => false, () => true)
          if (createFailedAtFlush && stepLogQueue.length > 0) {
            reflushRan = true
            try {
              const reflushed = await withinBudget(
                flushStepLogs(runDb, stepLogQueue, env.PII_REDACTION_FIELDS ?? '', {
                  workflowId,
                  isTest: reality.isTest,
                }, beforeFinalizeTiming),
                beforeFinalizeTiming,
              )
              if (reflushed.settled) reflushError = reflushed.value
              else reflushUnconfirmed = true
            } catch (e) {
              // A throw (not a returned error) is still a lost trace: record it as
              // the re-flush error so the run is failed, the same as the original
              // flush's own .catch does.
              reflushError = formatErr(e)
            }
            if (reflushError) {
              console.error('[step-logger] step-log recovery re-flush reported errors', {
                executionId,
                error: reflushError,
              })
            }
          }
        }

        // The step-persist signal. When the create failed (the reconstruction
        // path), flushPromise's error is the create rejection, not a step result,
        // so the re-flush is authoritative: its error, its timeout (unconfirmed),
        // or clean. When the create landed (late or on the ordinary path, so the
        // original flush actually ran), or the flush was unconfirmed, the original
        // flush stands (#688).
        const reconstructedCreateFailed = reconstructed && createFailedAtFlush
        const stepPersistError = reconstructedCreateFailed ? reflushError : flushError
        const stepPersistUnconfirmed = reconstructedCreateFailed
          ? (reflushUnconfirmed
              ? 'the reconstructed run\'s step logs did not answer within the post-response budget; they may still land'
              : null)
          : flushUnconfirmed
        // The step rows that timed out are read back by the minute sweep, for the
        // slowdown summary (#1881). Tier 1, so a failed entry is only logged.
        // Gated on the unified unconfirmed signal so a re-flush that timed out is
        // registered too, not only the original flush (#688).
        if (stepPersistUnconfirmed && !reality.isTest && stepLogQueue.length > 0) {
          const runStart = Date.parse(startedAt)
          executionCtx.waitUntil(
            recordUnconfirmedOutcome(
              'execution_steps',
              {
                kind: 'steps_present',
                execution_id: executionId,
                execution_started_at: startedAt,
                started_from: new Date(runStart).toISOString(),
                started_to: new Date(runStart + 60 * 60 * 1000).toISOString(),
                expected: stepLogQueue.length,
              },
              { message: `execution_steps (execution ${executionId}): ${stepPersistUnconfirmed}` },
              { ...outcomeDeps, supabase: runDb },
              { deadLetterOnFailure: false },
            ),
          )
        }
        const statusAfterFlush = resolveContinuationStatus(executionStatus, {
          hasContinuationError: continuationError != null,
          hasFlushError: stepPersistError != null,
          hasFlushUnconfirmed: stepPersistUnconfirmed != null,
          neverAdvanced: finalNodeNamespace == null,
          wasReconstructed: reconstructed,
        })
        let demotedMessage: string | null = null
        if (statusAfterFlush === 'failed' && finalStatus !== 'failed' && executionStatus === 'completed' && stepPersistError) {
          failedErrorType = failedErrorType ?? 'permanent'
          demotedMessage = reflushRan
            ? `Step logs could not be persisted after the execution record was reconstructed: ${stepPersistError}`
            : `Step logs failed to persist: ${stepPersistError}`
        } else if (statusAfterFlush === 'degraded' && finalStatus === 'completed') {
          if (reconstructed) {
            // The base row was missing and was reconstructed at finalize (#688).
            // The primary write path failed, so this is degraded rather than a
            // clean completed, but the lead was served, so it is not a hard failure
            // and does not page per run. The step-logs clause claims a recovery
            // only when the re-flush actually ran and succeeded; an empty queue or a
            // create that landed late makes no such claim, and an unconfirmed flush
            // says so.
            const recovered = reflushRan && stepPersistError == null && stepPersistUnconfirmed == null
            const stepsNote = recovered
              ? ' and its step logs were recovered'
              : stepPersistUnconfirmed != null
                ? ', though its step records were not confirmed saved'
                : ''
            demotedMessage = `The execution record was reconstructed after its initial write failed; the lead was served correctly${stepsNote}.`
          } else if (stepPersistUnconfirmed) {
            // Served, and its step records only went unconfirmed (#1881, part of
            // #688). Not a step failure, so no failed step, no error type and no per
            // run page: the slowdown summary reports it once the rows are read back.
            demotedMessage = `Step records were not confirmed saved: ${stepPersistUnconfirmed}`
          }
        }
        if (demotedMessage !== null) {
          finalStatus = statusAfterFlush
          finalErrorMessage = demotedMessage
          if (finalStatus === 'failed') outcome = 'failed'
          journalAnswer(finalStatus, outcome, finalErrorMessage)
          // Sent only once the first update confirmed: an update still out could
          // otherwise land after this one and undo it. Unconfirmed, the journal
          // and the read back carry the run instead.
          if (finalized.settled && !finalizeError) {
            const demoted = await withinBudget(updateExecutionRecord(runDb, executionId, startedAt, {
              status: finalStatus,
              outcome,
              completed_at: completedAt,
              duration_ms: durationMs,
              error_message: finalErrorMessage,
              failed_step_type: resolveFailedStepType(definition.nodes, failedStep),
            }, undefined, undefined, writeTiming), writeTiming)
            if (!demoted.settled || demoted.value) {
              console.error('[execution] the step write demotion did not confirm', {
                executionId,
                status: finalStatus,
                error: demoted.settled ? demoted.value?.message : 'no answer within the post-response budget',
              })
            }
          }
        }

        // Mirror the immediate alert gate: skip business rejections
        // (errorType === null) and explicitly suppressed failures so a
        // post-response business-rejection records as failed but doesn't page.
        // No-op for the flush-error/never-advanced promotions above (those set
        // a non-null 'permanent' type and never suppress).
        if (
          finalStatus === 'failed' &&
          executionStatus === 'completed' &&
          !reality.isTest &&
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
              supabase: configDb,
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
  if (sightingId && !reality.isTest) {
    const startedAtDate = new Date(startedAt)
    executionCtx.waitUntil(
      // The bounded wait, so an unfinished walk cannot hold the sighting (#1860).
      walkSettled
        .then(async () => {
          // The row finalize is about to UPDATE is INSERTed by this promise.
          // It already carries its own .catch, so a failed insert resolves here
          // and finalize still runs (and now honestly reports the missing row).
          await sightingWritePromise
          const completedAtDate = new Date(completedAt)
          // Rich finalize fields (winner/bid/enrichment/reject_reason/outcome),
          // computed by the shared pure fn so this live finalize and the durable
          // projection onto workflow_executions (block 1, #353) stay identical.
          const sf = computeSightingFinalize(ctx.steps, definition.nodes, {
            lastCompletedNamespace: ctx.lastCompletedNamespace ?? null,
            walkStatus,
            executionStatus,
            successNamespaces,
            externalDebt: extractExternalDebt(ctx, definition.nodes),
            // A refused ambiguous quote is null in the column exactly like a run
            // that quoted nothing, so the only thing that tells them apart is this
            // line naming every producer that claimed the money field (#1162).
            onAmbiguousQuote: (producers) => log({
              event: 'quoted_rate_ambiguous',
              trace_id: traceId,
              workflow_id: ctx.trigger.workflow_id,
              execution_id: executionId,
              producers,
              error_message: `Quoted rate refused: ${producers.length} code nodes quoted a rate (${producers.map((p) => p.namespace).join(', ')})`,
            }),
          })

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
          }, definition.nodes)) {
            ctx.pendingBidWrites ??= []
            ctx.pendingBidWrites.push(recordBidAttempt(runDb, bid, outcomeDeps))
          }

          // Wait for every bid-attempt insert to commit before finalize's
          // winner UPDATE runs (#88). The UPDATE matches lead_sighting_bids on
          // execution_id + partner_slug; if it ran before an insert committed it
          // would match zero rows and leave the winner is_winner=false forever.
          // These inserts are otherwise unawaited (registered here, not in the
          // walk), so this await is also what keeps them alive past teardown.
          // #1850: bounded at the write cut-off, so a bid row that never
          // answers cannot keep the sighting finalize (and its dead letter)
          // waiting past Cloudflare's limit.
          await withinBudget(Promise.allSettled(ctx.pendingBidWrites ?? []), writeTiming)

          await finalizeSighting(runDb, {
            sighting_id: sightingId,
            execution_id: executionId,
            execution_started_at_utc: startedAtDate,
            execution_finished_at_et: completedAtDate,
            execution_ended_at_utc: completedAtDate,
            duration_ms: durationMs,
            // ...sf now carries external_debt (#1212), so it is not repeated here:
            // one derivation reaches both the live finalize and the projection.
            ...sf,
            // #686: the insert fields, so finalize rebuilds the base row if the
            // trigger-boundary insert was lost to the same window.
          }, outcomeDeps, sightingInsert ?? undefined)
        })
        .catch((e) => console.error('[lead-sightings] finalize failed:', e))
    )
  }

  // Achieve evaluation log: after the walk completes, scan step outputs for
  // the achieve_fdr marker and persist request/offers to achieve_evaluations.
  // Test runs are recorded with is_test=true so sandbox validation is visible.
  executionCtx.waitUntil(
    // The bounded wait, so an unfinished walk cannot hold this write (#1860).
    walkSettled
      .then(async () => {
        const payloadSubmissionId = (payload as { Submission__c?: unknown } | null)?.Submission__c
        const achieveRows = extractAchieveEvaluations(stepLogQueue, {
          trace_id: traceId,
          execution_id: executionId,
          workflow_id: workflowId,
          submission_id: typeof payloadSubmissionId === 'string' ? payloadSubmissionId : null,
          is_test: reality.isTest,
        })
        await insertAchieveEvaluations(runDb, achieveRows)
      })
      .catch((e) => console.error('[achieve-log] write failed:', e))
  )

  // Slow executions are no longer alerted per-run (too noisy — one transiently
  // slow lead = one page). The duration threshold (trigger.config.duration_alert_ms)
  // is still the per-run "slow" definition, but alerting is now aggregated: the
  // minute cron (lib/slow-execution-rate.ts) fires only when slow runs SPIKE
  // across a 5-minute window. See runSlowExecutionCheck.

  if (executionStatus === 'failed' && !reality.isTest && failedErrorType !== null && !failedSuppressAlert && !matchesMutedSignal(errorMessage, mutedFailureSignals) && !classifyOutageCause(errorMessage)) {
    executionCtx.waitUntil(
      fireExecutionAlert({
        alertType: 'failure',
        supabase: configDb,
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
          .then(() => setIdempotencyResult(env.IDEMPOTENCY, workflowId, source, idempotencyKey, response, ttl, walkStatus, walkHeaders))
          .catch((e) => console.error('[idempotency] failed to cache result:', e))
      )
    } else if (!isRecoveryRun) {
      executionCtx.waitUntil(
        idempotencyProcessingPromise
          .catch(() => {})
          .then(() => clearIdempotency(env.IDEMPOTENCY, workflowId, source, idempotencyKey))
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

/**
 * The answer as the journal keeps it (#1883): redacted with the step rows' field
 * list, and left out when it is too large to be worth a KV value, which no real
 * answer is (they are a few hundred bytes).
 */
const JOURNAL_BODY_MAX_BYTES = 64 * 1024
function journalBody(response: unknown, piiFieldsRaw: string): unknown {
  const redacted = redactPii(response, parsePiiFields(piiFieldsRaw))
  // In bytes, which is what KV counts, not the UTF-16 characters `length` would.
  const size = new TextEncoder().encode(JSON.stringify(redacted ?? null) ?? '').length
  return size > JOURNAL_BODY_MAX_BYTES ? { omitted: `the answer was ${size} bytes, over the journal's ${JOURNAL_BODY_MAX_BYTES}` } : redacted
}

/**
 * The error the execution_finalize dead letter carries (#1850). Its alert reads
 * a finalize failure that is not a missing row as a row left at 'running',
 * which the strand drain recovers. That holds only if the row was created: when
 * the create never confirmed either (a database down for the whole window),
 * there is no row for any drain to find, so the loss is reported as a missing
 * row, which the alert words as a served lead with no audit record.
 */
function finalizeLossOf(error: DbError, rowConfirmed: boolean, executionId: string): DbError {
  if (rowConfirmed || isNoRowMatchedError(error)) return error
  return {
    code: NO_ROW_MATCHED_CODE,
    message: `workflow_executions (id=${executionId}): the execution record was never confirmed created, and finalize could not create it either: ${error.message}`,
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
  // The lane this walk runs in (#1725). Required, so no caller can fall into
  // the money lane by leaving it out.
  lane: WorkflowLane,
  workflowVersionId = '',
  stepLogQueue: StepLogEntry[] = [],
  onRespondEarly?: (response: WalkGraphResult) => void,
  // Partner block sightings (#1265) ride on a step's result or thrown error and are handed
  // here, the one place both are in hand, so reporting never runs inside a node. The
  // callback is the caller's background reporter; its own failure must not touch the walk.
  onBlockSighting?: (sighting: PartnerBlockSighting) => void
): Promise<WalkGraphResult> {
  const forwardBlockSightings = (carrier: unknown): void => {
    // Two carriers: the step's result or thrown error, and the context collector a reader
    // notes into when it has neither (the dedup check). Drained every time so a sighting is
    // reported once, against the step that saw it.
    const noted = drainBlockSightings(ctx)
    if (!onBlockSighting) return
    const carried = carrier && typeof carrier === 'object' ? (carrier as { blockSightings?: unknown }).blockSightings : undefined
    const sightings = [...(Array.isArray(carried) ? (carried as PartnerBlockSighting[]) : []), ...noted]
    for (const sighting of sightings) {
      try {
        onBlockSighting(sighting)
      } catch (e) {
        console.error(`[partner-block] sighting callback failed trace=${ctx.trigger.trace_id}: ${formatErr(e)}`)
      }
    }
  }
  const runNode = nodeExecutorForLane(lane)
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
    // What the walk is on, for a cut-off that has to say what it gave up on (#1882).
    ctx.runningSteps = [stepName(node)]

    if (++walkSteps > MAX_WALK_STEPS) {
      throw new StepFailureError(
        `Workflow exceeded the maximum step count (${MAX_WALK_STEPS}); aborting to prevent a runaway loop. Check the graph for a cycle (an edge path that returns to an earlier node).`,
        node.namespace,
        'permanent',
      )
    }

    // A node this walk's lane cannot run is refused here, by name, before any
    // branch below can reach it (#1725). Here rather than in the executor alone,
    // because the money walker branches (bid_group, buyer_select, buyer_click_*)
    // call their own executors by type and never pass through the registry, and
    // because a refusal must not be skipped or routed to a fallback by on_error
    // the way an executor's error is. The entry check in executeWorkflow refuses
    // such a definition before anything is recorded; this holds the line for
    // any other way into the walk.
    const laneRefusal = laneRefusalFor(node.type, lane)
    if (laneRefusal) {
      const refusedAt = new Date().toISOString()
      log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: 0, error_message: laneRefusal.message, error_type: 'permanent' })
      recordStepOutput(ctx, node.namespace, { output: null, status: 'failed', error: laneRefusal.message, error_type: 'permanent' }, { nodeType: node.type, chainStep: true })
      logStep(stepLogQueue, executionId, executionStartedAt, node, 'failed', null, null, laneRefusal.message, 'permanent', 0, refusedAt, stepOrder)
      throw new StepFailureError(laneRefusal.message, node.namespace, 'permanent')
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
      let parallelSuppressAlert = false

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
            runParallelChild(child, ctx, env, supabase, lane, executionId, executionStartedAt, childOrderBase + childIndex, node.id, workflowVersionId, stepLogQueue, definition, chainEndId, abandonSignal),
          slotHandleIds
        )
        output = result.output
        lastOutput = output
        forwardBlockSightings(result)

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
        errorMessage = formatErr(err)
        forwardBlockSightings(err)
        // A parallel failure the children didn't reach a verdict on (a timeout, a
        // structural error, a mix of outcomes) is operational, never a clean
        // business rejection, so give it a real type and let the failure alert
        // fire. A null type reads as a business rejection and stays silent (#64).
        //
        // When the rejected children DID agree (#486), inherit their verdict
        // instead: a partner declining a lead is a business rejection whether the
        // node sits in a parallel block or in the main line, and a failure the
        // partner config says not to page on stays unpaged either way.
        const cause = (err as { parallelFailureCause?: ParallelFailureCause }).parallelFailureCause
        if (cause) {
          errorType = cause.errorType
          parallelSuppressAlert = cause.suppressAlert
        } else {
          errorType = classifyStepError(err) ?? 'transient'
        }
      }

      const parallelDurationMs = Date.now() - new Date(stepStartedAt).getTime()
      if (stepStatus === 'completed') {
        log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: parallelDurationMs })
      } else {
        log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: parallelDurationMs, error_message: errorMessage, error_type: errorType })
      }

      recordStepOutput(ctx, node.namespace, { output, status: stepStatus, error: errorMessage, error_type: errorType }, { chainStep: true })
      logStep(stepLogQueue, executionId, executionStartedAt, node, stepStatus, null, output, errorMessage, errorType, 0, stepStartedAt, parallelStartOrder)

      // Locate the parallel_end join node. Reuse the same detection logic
      // used to enable chain walking — children's edges, then the parallel
      // start's skeleton edge, then BFS through the chain.
      const childIdSet = new Set(resolvedChildren.map((c) => c.id))
      const endNode = endNodePreview
      if (endNode) {
        recordStepOutput(ctx, endNode.namespace, { output, status: stepStatus, error: errorMessage, error_type: errorType }, { nodeType: endNode.type, chainStep: true })
        logStep(stepLogQueue, executionId, executionStartedAt, endNode, stepStatus, null, output, errorMessage, errorType, 0, stepStartedAt, parallelEndOrder)
      }

      if (stepStatus === 'failed') {
        throw new StepFailureError(errorMessage!, node.namespace, errorType, parallelSuppressAlert)
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

      // Each attempt is named by its partner's slug (bid_race.tripoint), which later
      // steps, the step rows and the sightings read. The slugs come from the partner
      // constants loader, whose stored copy is served when the database cannot be
      // read, so an outage names attempts as a healthy day does (#1849, found by the
      // outage drill, #1305). With no copy either, attempts fall back to `partner-N`
      // and still bid, and that is logged.
      const tieredPartnerIds = tiers.flatMap((t) => t.partner_ids ?? [])
      const allIds = Array.from(new Set([...partnerIds, ...tieredPartnerIds, ...(fallbackId ? [fallbackId] : [])]))
      const slugByPartnerId = new Map<string, string>()
      if (allIds.length > 0) {
        try {
          const { slugsById = {} } = await loadPartnerConstants(ctx.trigger.org_id, env.WORKFLOW_CACHE, supabase)
          for (const id of allIds) if (slugsById[id]) slugByPartnerId.set(id, slugsById[id])
        } catch (err) {
          console.error(`[bid-group] partner slugs could not be loaded; using partner-N fallback: ${formatErr(err)}`)
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
          forwardBlockSightings(result)
        } catch (err) {
          attemptStatus = 'failed'
          attemptError = formatErr(err)
          attemptErrorType = classifyStepError(err)
          attemptResolvedInput = extractResolvedInput(err)
          forwardBlockSightings(err)
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

      // Resolve the BidGroup's `outbound_fields` map the same way (#1518). These are
      // merged onto every partner attempt's REQUEST body by the API resolver, which
      // is how a step-computed figure (the verified debt) reaches a partner whose
      // request is otherwise the trigger payload passed through. A template that
      // resolves to nothing is sent as null and named here, so a typo in a step
      // path shows on the step row instead of reading as "the lead had no debt".
      const outboundConfig = node.config.outbound_fields as Record<string, unknown> | undefined
      let resolvedOutbound: Record<string, unknown> | undefined
      let unresolvedOutbound: string[] | undefined
      if (outboundConfig && typeof outboundConfig === 'object' && Object.keys(outboundConfig).length > 0) {
        resolvedOutbound = {}
        const unresolved: string[] = []
        for (const [k, v] of Object.entries(outboundConfig)) {
          const resolved = resolveValue(v, ctx)
          if (resolved === undefined) unresolved.push(k)
          resolvedOutbound[k] = resolved === undefined ? null : resolved
        }
        if (unresolved.length > 0) {
          unresolvedOutbound = unresolved
          console.warn(JSON.stringify({
            event: 'bid_group_outbound_field_unresolved',
            trace_id: ctx.trigger.trace_id,
            workflow_id: ctx.trigger.workflow_id,
            step_namespace: node.namespace,
            fields: unresolved,
          }))
        }
        ctx.bidGroupOutboundFields = resolvedOutbound
      }

      let groupOutput: BidGroupOutput | null = null
      let groupStatus: StepStatus = 'completed'
      let groupErrorMessage: string | undefined
      let groupErrorType: ErrorType = null
      try {
        groupOutput = await executeBidGroupNode(node, ctx, env, supabase, runAttempt, (id) => slugByPartnerId.get(id))
      } catch (err) {
        groupStatus = 'failed'
        groupErrorMessage = formatErr(err)
        // A bid_group execution error is operational, not a business rejection
        // (a no-winner routes via _route, it doesn't throw) — give it a real type
        // so the failure alert fires (#64).
        groupErrorType = classifyStepError(err) ?? 'transient'
      } finally {
        // Clear bidGroupContext so subsequent steps (or nested groups, if ever)
        // don't see stale values. Idempotent — safe even when context wasn't set.
        ctx.bidGroupContext = undefined
        ctx.bidGroupOutboundFields = undefined
      }

      const groupDurationMs = Date.now() - new Date(groupStartedAt).getTime()
      if (groupStatus === 'completed' && groupOutput) {
        log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: groupDurationMs })
      } else {
        log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: groupDurationMs, error_message: groupErrorMessage })
      }

      recordStepOutput(ctx, node.namespace, { output: groupOutput, status: groupStatus, error: groupErrorMessage, error_type: groupErrorType }, { chainStep: true })
      const groupResolvedInput: ResolvedStepInput = {
        template: {
          mode: config.mode,
          partner_ids: partnerIds,
          tiers,
          fallback_partner_id: fallbackId,
          min_bid_threshold: config.min_bid_threshold,
          timeout_ms: config.timeout_ms,
          context: node.config.context,
          outbound_fields: node.config.outbound_fields,
          no_winner_behavior: config.no_winner_behavior,
        },
        resolved: {
          mode: config.mode,
          partner_slugs: partnerIds.map((id) => slugByPartnerId.get(id) ?? id),
          fallback_partner_slug: fallbackId ? (slugByPartnerId.get(fallbackId) ?? fallbackId) : null,
          tiered_partner_slugs: tiers.map((t) => (t.partner_ids ?? []).map((id) => slugByPartnerId.get(id) ?? id)),
          context: resolvedContext,
          outbound_fields: resolvedOutbound,
          unresolved_outbound_fields: unresolvedOutbound,
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

    // ── Buyer Select node (#1411): sell a sell off lead to the best eligible buyer ──
    // First class like bid_group: the executor returns the parent output plus one
    // attempt per buyer it actually contacted, and the walker writes one parent
    // row and one `partner_bid` child row per attempt, every row under the node's
    // REAL id (step_node_id is a uuid column) and linked by parallel_group_id.
    // The node never goes through executeNode's retry loop: a retried sale is a
    // duplicate send, so it runs exactly once whatever the definition says.
    if (node.type === 'buyer_select') {
      const selectStartedAt = new Date().toISOString()
      const selectStartMs = Date.now()
      log({ event: 'step_start', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type })

      const selectStartOrder = stepOrder
      const attemptOrderBase = stepOrder + 1
      const selectResult = await executeBuyerSelectNode(node, ctx, env, buyerSelectProductionDeps(ctx, env, supabase))

      selectResult.attempts.forEach((attempt, attemptIndex) => {
        recordStepOutput(ctx, attempt.namespace, { output: attempt.output, status: attempt.status, error: attempt.error ?? undefined, error_type: attempt.error_type })
        const childNode: NodeDefinition = { id: node.id, namespace: attempt.namespace, type: 'partner_bid', config: {} }
        const attemptInput: ResolvedStepInput = { template: { partner_slug: attempt.partner_slug }, resolved: attempt.input }
        logStep(stepLogQueue, executionId, executionStartedAt, childNode, attempt.status, attemptInput, attempt.output, attempt.error ?? undefined, attempt.error_type, 0, attempt.started_at.toISOString(), attemptOrderBase + attemptIndex, node.id)
        log({ event: attempt.status === 'completed' ? 'step_complete' : 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: attempt.namespace, step_type: 'partner_bid', duration_ms: attempt.completed_at.getTime() - attempt.started_at.getTime(), error_message: attempt.error ?? undefined, error_type: attempt.error_type })
      })

      // The handle is checked BEFORE the parent row is written, so an unwired
      // handle is a failed row with its own name in every mode, never a
      // completed row that then went nowhere.
      const selectOutput = selectResult.output
      const selectEdges = outgoingEdges(node.id, definition.edges)
      const selectEdge = selectEdges.find((e) => e.source_handle === selectOutput._route)
      let selectFailure = selectResult.failure
      if (!selectFailure && !selectEdge) {
        selectFailure = {
          message: `buyer_select buyer_select_handle_unwired: the node routed ${selectOutput._route} and that handle is not wired`,
          errorType: 'permanent',
          reason: 'buyer_select_handle_unwired',
        }
      }
      const selectStatus: StepStatus = selectFailure ? 'failed' : 'completed'
      const selectErrorType: ErrorType = selectFailure?.errorType ?? null

      recordStepOutput(ctx, node.namespace, { output: selectOutput, status: selectStatus, error: selectFailure?.message, error_type: selectErrorType }, { chainStep: true })
      const selectConfig = node.config as Record<string, unknown>
      const selectResolvedInput: ResolvedStepInput = {
        template: {
          population: selectConfig.population,
          mode: selectConfig.mode,
          live_percent_env: selectConfig.live_percent_env,
          lead_key: selectConfig.lead_key,
          sell_off_when: selectConfig.sell_off_when,
          bid_when_positive: selectConfig.bid_when_positive,
        },
        resolved: {
          population: selectOutput.population,
          mode_effective: selectOutput.mode_effective,
          lead_key: selectOutput.lead_key,
          live_percent_in_force: selectOutput.live_percent_in_force,
        },
      }
      logStep(stepLogQueue, executionId, executionStartedAt, node, selectStatus, selectResolvedInput, selectOutput, selectFailure?.message, selectErrorType, 0, selectStartedAt, selectStartOrder)
      lastOutput = selectOutput

      const selectDurationMs = Date.now() - selectStartMs
      if (selectFailure) {
        log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: selectDurationMs, error_message: selectFailure.message, error_type: selectErrorType })
        throw new StepFailureError(selectFailure.message, node.namespace, selectErrorType)
      }
      log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: selectDurationMs })

      current = selectEdge ? findNode(selectEdge.target, definition.nodes) : undefined
      stepOrder = attemptOrderBase + selectResult.attempts.length
      continue
    }

    // ── Buyer Click Send node (#1542): claim, post and count one click ──
    // Walker only like buyer_select: it runs exactly once, never through
    // executeNode's retry loop, because a retried send is a duplicate. One step
    // row under the node's id; the route is checked before the row is written,
    // so an unwired handle is a failed row with its own name.
    if (node.type === 'buyer_click_send') {
      const clickStartedAt = new Date().toISOString()
      const clickStartMs = Date.now()
      log({ event: 'step_start', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type })

      const clickResult = await executeBuyerClickSendNode(node, ctx, buyerClickSendProductionDeps(ctx, env, supabase))
      const clickOutput = clickResult.output
      const clickEdge = outgoingEdges(node.id, definition.edges).find((e) => e.source_handle === clickOutput._route)
      let clickFailure = clickResult.failure
      if (!clickFailure && !clickEdge) {
        clickFailure = {
          message: `buyer_click_send buyer_click_send_handle_unwired: the node routed ${clickOutput._route} and that handle is not wired`,
          errorType: 'permanent',
          reason: 'buyer_click_send_handle_unwired',
        }
      }
      const clickStatus: StepStatus = clickFailure ? 'failed' : 'completed'
      const clickErrorType: ErrorType = clickFailure?.errorType ?? null
      recordStepOutput(ctx, node.namespace, { output: clickOutput, status: clickStatus, error: clickFailure?.message, error_type: clickErrorType }, { chainStep: true })
      const clickConfig = node.config as Record<string, unknown>
      const clickInput: ResolvedStepInput = {
        // Never the body: it carries the prospect's identity (L222).
        // The route is the buyer profile's (#1671), picked by the state template.
        template: { partner_id: clickConfig.partner_id, prospect_id: clickConfig.prospect_id, state: clickConfig.state },
        resolved: { partner_id: clickOutput.partner_id, partner_slug: clickOutput.partner_slug, prospect_id: clickOutput.prospect_id, mode_effective: clickOutput.mode_effective },
      }
      logStep(stepLogQueue, executionId, executionStartedAt, node, clickStatus, clickInput, clickOutput, clickFailure?.message, clickErrorType, 0, clickStartedAt, stepOrder)
      lastOutput = clickOutput

      const clickDurationMs = Date.now() - clickStartMs
      if (clickFailure) {
        log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: clickDurationMs, error_message: clickFailure.message, error_type: clickErrorType })
        throw new StepFailureError(clickFailure.message, node.namespace, clickErrorType)
      }
      log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: clickDurationMs })

      current = clickEdge ? findNode(clickEdge.target, definition.nodes) : undefined
      stepOrder++
      continue
    }

    // ── Buyer Click Check node (#1543): may a click sold buyer be offered this lead ──
    // Walker only like buyer_click_send: it runs exactly once under its own CLICK_CHECK_BUDGET_MS
    // budget, never through executeNode's retry loop, so a slow read cannot be
    // retried past the response Engine is waiting for. One step row under the
    // node's id; the route is checked before the row is written, so an unwired
    // handle is a failed row with its own name.
    if (node.type === 'buyer_click_check') {
      const checkStartedAt = new Date().toISOString()
      const checkStartMs = Date.now()
      log({ event: 'step_start', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type })

      const checkResult = await executeBuyerClickCheckNode(node, ctx, buyerClickCheckProductionDeps(ctx, env, supabase))
      const checkOutput = checkResult.output
      const checkEdge = outgoingEdges(node.id, definition.edges).find((e) => e.source_handle === checkOutput._route)
      let checkFailure = checkResult.failure
      if (!checkFailure && !checkEdge) {
        checkFailure = {
          message: `buyer_click_check buyer_click_check_handle_unwired: the node routed ${checkOutput._route} and that handle is not wired`,
          errorType: 'permanent',
          reason: 'buyer_click_check_handle_unwired',
        }
      }
      const checkStatus: StepStatus = checkFailure ? 'failed' : 'completed'
      const checkErrorType: ErrorType = checkFailure?.errorType ?? null
      recordStepOutput(ctx, node.namespace, { output: checkOutput, status: checkStatus, error: checkFailure?.message, error_type: checkErrorType }, { chainStep: true })
      const checkConfig = node.config as Record<string, unknown>
      const checkInput: ResolvedStepInput = {
        template: { partner_id: checkConfig.partner_id, population: checkConfig.population, state: checkConfig.state, debt: checkConfig.debt, loan_amount: checkConfig.loan_amount },
        resolved: { partner_id: checkOutput.partner_id, partner_slug: checkOutput.partner_slug, population: checkOutput.population },
      }
      logStep(stepLogQueue, executionId, executionStartedAt, node, checkStatus, checkInput, checkOutput, checkFailure?.message, checkErrorType, 0, checkStartedAt, stepOrder)
      lastOutput = checkOutput

      const checkDurationMs = Date.now() - checkStartMs
      if (checkFailure) {
        log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: checkDurationMs, error_message: checkFailure.message, error_type: checkErrorType })
        throw new StepFailureError(checkFailure.message, node.namespace, checkErrorType)
      }
      log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: checkDurationMs })

      current = checkEdge ? findNode(checkEdge.target, definition.nodes) : undefined
      stepOrder++
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
        // The chain runs as one call, so every node in it is running at once.
        ctx.runningSteps = chain.map(stepName)
        const chainResult = await executeCodeChain(chain, ctx, env)
        // Log + record each result. Any sentinel or failure in the chain stops
        // further chain processing (bundled worker also stops at the first
        // sentinel/failure).
        let terminated = false
        for (let i = 0; i < chainResult.results.length; i++) {
          const r = chainResult.results[i]
          const chainNode = chain[i]
          const stepStartedAtIso = new Date(Date.now() - r.durationMs).toISOString()
          // A deterministic programming error (TypeError, etc.) reported by the
          // sandbox is permanent — never transient — so it isn't mislabeled in
          // alerts/logs (#458). The chain path isn't retried (chainable nodes
          // carry retries=0), but classification still drives alerting.
          const chainErrorType: import('../types').ErrorType = r.status === 'failed'
            ? (r.permanent || isDeterministicCodeError(r.errorName, r.error ?? '') ? 'permanent' : 'transient')
            : null
          if (r.status === 'completed') {
            log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: chainNode.namespace, step_type: chainNode.type, duration_ms: r.durationMs })
          } else {
            log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: chainNode.namespace, step_type: chainNode.type, duration_ms: r.durationMs, error_message: r.error, error_type: chainErrorType })
          }
          recordStepOutput(ctx, chainNode.namespace, { output: r.output ?? null, status: r.status, error: r.error, error_type: chainErrorType }, { chainStep: true })
          // Chained code steps don't get the standard ResolvedStepInput from the
          // executor (the bundled worker batches them). Reconstruct the same
          // template/resolved shape from the chain node's props config — the
          // resolved values were already computed inside executeCodeChain's
          // chainPayload build, but aren't returned per-step, so re-resolve here.
          // resolveValue is cheap (string templating against ctx); fine on the
          // hot path for a chain of ~3-5 nodes.
          const chainResolvedInput = buildCodeStepInput(chainNode, ctx)
          logStep(stepLogQueue, executionId, executionStartedAt, chainNode, r.status, chainResolvedInput, r.output ?? null, r.error, chainErrorType, 0, stepStartedAtIso, stepOrder, undefined, r.logs)
          // The bundle's raw records for this step become sightings through the one detector
          // (#1265); the chain response came straight from JSON, so the records are re-read.
          noteSandboxBlocks(ctx, chainNode.namespace, ctx.codeBundleName ?? codeBundleName(ctx.trigger.workflow_id), readBlockRecords(r.blocks))
          forwardBlockSightings(undefined)
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
            throw new StepFailureError(r.error ?? 'Code node failed', chainNode.namespace, chainErrorType ?? 'transient')
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
        (signal) => runNode(node, ctx, env, supabase, signal, lastOutput),
        retryConfig,
        classifyStepError,
        retryStats,
        ctx.retrySleep
      )
      retriesUsed = retryStats.retries
      output = result.output
      stepStatus = 'completed'
      lastOutput = output
      stepLogs = result.logs
      resolvedInput = result.resolvedInput ?? null
      forwardBlockSightings(result)

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
        recordStepOutput(ctx, node.namespace, { output, status: earlyStepStatus, error: earlyErrorMessage, error_type: earlyErrorType }, { nodeType: node.type, chainStep: true })
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
      forwardBlockSightings(err)
      // Same pattern for resolved input — executors that build the outbound
      // payload before fetch (Salesforce, Partner Bid, etc.) attach the
      // resolved values to thrown errors so failed steps don't show blank input.
      const errResolvedInput = extractResolvedInput(err)
      if (errResolvedInput) resolvedInput = errResolvedInput
      // Identical to the parallel child's catch by construction (#486). These two
      // hand-rolled the same three-way classification separately, and the copy in
      // the child drifted: it lost the PartnerApiError branch, so the same partner
      // failure was typed differently depending on where the node sat. One shared
      // helper, one behavior.
      errorType = classifyStepError(err)
      suppressAlert = err instanceof PartnerApiError ? err.suppressAlert : false

      errorMessage = formatErr(err)
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
          recordStepOutput(ctx, node.namespace, { output: null, status: stepStatus, error: errorMessage, error_type: errorType }, { nodeType: node.type, chainStep: true })
          logStep(stepLogQueue, executionId, executionStartedAt, node, stepStatus, resolvedInput, output, errorMessage, errorType, retriesUsed, stepStartedAt, stepOrder, undefined, stepLogs)
          current = fallback
          stepOrder++
          continue
        }
        throw new Error(`Fallback node ${node.config.fallback_node} not found`)
      } else {
        stepStatus = 'failed'
        log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMs, error_message: errorMessage, error_type: errorType })
        recordStepOutput(ctx, node.namespace, { output: null, status: stepStatus, error: errorMessage, error_type: errorType }, { nodeType: node.type, chainStep: true })
        logStep(stepLogQueue, executionId, executionStartedAt, node, stepStatus, resolvedInput, output, errorMessage, errorType, retriesUsed, stepStartedAt, stepOrder, undefined, stepLogs)
        throw new StepFailureError(errorMessage, node.namespace, errorType, suppressAlert, resolvedInput)
      }
    }

    // Skip the normal completion logging if the earlyResponse branch above
    // already logged the step (continueExecution case). Without this guard,
    // the step shows up twice in the Steps list with identical durations.
    if (!loggedEarly) {
      const seqDurationMs = Date.now() - new Date(stepStartedAt).getTime()
      log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMs })
      recordStepOutput(ctx, node.namespace, { output, status: stepStatus }, { nodeType: node.type, chainStep: true })
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
  // The lane of the walk this child belongs to (#1725), required like walkGraph's.
  lane: WorkflowLane,
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

  // Every node of the slot, the walker only types included, goes through this
  // lane's executor (#1725), which refuses a type its lane cannot run by name and
  // as permanent, so the refusal is a rejected slot that is never retried. A
  // child has no on_error handling and no walker branches, so the executor is
  // the whole of the lane check here; the main walk needs its own gate as well.
  const runNode = nodeExecutorForLane(lane)
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
    let suppressAlert = false
    let stepLogs: import('../types').StepLogEntry[] | undefined
    let resolvedInput: ResolvedStepInput | null = null
    // Captures the real retry count from withRetry (mutated in place on both the
    // success and throw path) so this child's step log records it instead of 0.
    const retryStats = { retries: 0 }

    try {
      const result = await withRetry(
        (signal) => runNode(node, ctx, env, supabase, signal, lastOutput),
        retryConfig,
        classifyStepError,
        retryStats,
        ctx.retrySleep
      )
      output = result.output
      stepLogs = result.logs
      resolvedInput = result.resolvedInput ?? null
      // A child's result never reaches the walker's step handling, so anything it carries
      // is noted on the context for the parallel step itself to drain (#1265).
      noteCarriedBlockSightings(ctx, result)

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
      errorMessage = formatErr(err)
      // The block swallows this error, so its sightings would be lost with it (#1265).
      noteCarriedBlockSightings(ctx, err)
      // #486: classifyStepError honors a PartnerApiError's own errorType. The
      // hand-rolled Response-or-transport ternary this replaces never checked for
      // one, so a partner's authoritative verdict (from its
      // response_classification config) was overwritten with 'transient', while
      // the identical failure outside a parallel block classified correctly. The
      // retry ladder above already used this helper; only the recorded type
      // disagreed.
      errorType = classifyStepError(err)
      suppressAlert = err instanceof PartnerApiError ? err.suppressAlert : false
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
      return { namespace: slotNamespace, status: 'rejected', error: errorMessage, errorType, suppressAlert }
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

import { codeBundleName, codeWorkerName, isWorkerNotFoundError } from '../lib/code-node-deployer'
import { parseCodeSandboxResponse } from './code-response'
import { secretKeys } from '../lib/secret-crypto'

interface ChainStepResult {
  namespace: string
  status: 'completed' | 'failed'
  output?: unknown
  error?: string
  // Constructor name of the thrown error (#458) — lets the chain path classify a
  // deterministic programming error as permanent rather than transient.
  errorName?: string
  /** A failure the same on every attempt: a shadow chain the compare namespace refused (#1708). */
  permanent?: true
  durationMs: number
  sentinel?: { kind: 'response' | 'exit'; continueAfter: boolean }
  logs?: import('../types').StepLogEntry[]
  /** Non-2xx responses the step's script fetched, from the sandbox capture (#1265). Absent
   *  on a bundle built before the capture existed and on the legacy per-node path. */
  blocks?: SandboxBlockRecord[]
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
  // vars (decrypted by env-loader) still flow (#108).
  const mergedEnv = buildSandboxEnv(env, ctx.env)

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

  // The one switch for where a run's code goes (#1708): a shadow run's chain runs
  // only on its compare bundle, and never falls back to the money namespace.
  let target: CodeDispatchTarget
  try {
    target = codeDispatchTarget(env, ctx, { chain: true })
  } catch (err) {
    clearTimeout(chainTimer)
    const permanent = (err as { permanent?: unknown }).permanent === true ? { permanent: true as const } : {}
    return { results: [{ namespace: chain[0].namespace, status: 'failed', error: formatErr(err), durationMs: 0, ...permanent }] }
  }
  const bundleBinding = target.binding.get(target.bundleName)
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

  // A transient binding throw (not a genuine "Worker not found") must fail the
  // chain rather than fall back to per-node — the fallback re-runs the whole
  // chain and could repeat side effects, and would run stale orphaned code on a
  // live lead (#475). Same guarantee as the single-node path in code.ts.
  if (bindingError !== undefined && !isWorkerNotFoundError(bindingError)) {
    const message = formatErr(bindingError)
    return { results: [{ namespace: chain[0].namespace, status: 'failed', error: `Chain dispatch failed: ${message}`, durationMs: 0 }] }
  }

  // Fallback: if the bundled worker is old (no /execute-chain) or missing (a
  // "Worker not found" throw or 503/404), run each step as an individual
  // subrequest via the single-step path.
  const chainUnsupported =
    bindingError !== undefined ||   // guaranteed a "Worker not found" throw at this point
    bundleRes?.status === 404 ||
    bundleRes?.status === 503

  // With no legacy fallback (a shadow run's compare bundle), the chain fails. Only
  // a bundle gone for good (404 or "Worker not found") is permanent; a 503 is the
  // platform briefly unable to serve, so it is left transient (#1798).
  if ((chainUnsupported || !bundleRes) && !target.legacyFallback) {
    const permanent = bundleMissingForGood(bundleRes?.status) ? { permanent: true as const } : {}
    return { results: [{ namespace: chain[0].namespace, status: 'failed', error: bundleUnreachableMessage(target, chain[0].namespace, bundleRes?.status), durationMs: 0, ...permanent }] }
  }

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
        const durationMs = Date.now() - startMs
        // Same parser as the single-node path. A script error arrives as a
        // non-2xx carrying the {__bsv:1, error, name} envelope, and used to be
        // JSON-parsed straight into a `completed` step whose output was the
        // error itself (#460). It must fail the chain here instead.
        const parsedRes = parseCodeSandboxResponse(r.ok, text)
        if (!parsedRes.ok) {
          results.push({
            namespace: node.namespace,
            status: 'failed',
            error: parsedRes.error,
            errorName: parsedRes.errorName,
            durationMs,
            logs: parsedRes.logs,
            blocks: parsedRes.blocks,
          })
          break
        }
        const output = parsedRes.output
        const sentinel = detectSentinel(output)
        recordStepOutput(ctx, node.namespace, { output, status: 'completed' })
        results.push({ namespace: node.namespace, status: 'completed', output, durationMs, sentinel: sentinel ?? undefined, logs: parsedRes.logs, blocks: parsedRes.blocks })
        if (sentinel) break
      } catch (err) {
        const durationMs = Date.now() - startMs
        results.push({ namespace: node.namespace, status: 'failed', error: formatErr(err), durationMs })
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
