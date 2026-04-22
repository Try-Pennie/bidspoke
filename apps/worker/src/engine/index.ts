import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTraceId, deriveIdempotencyKey } from '../lib/crypto'
import { checkIdempotency, setIdempotencyProcessing, setIdempotencyResult } from './idempotency'
import { loadWorkflowDefinition } from './definition-loader'
import { loadEnvVars } from '../lib/env-loader'
import { loadPartnerConstants } from '../lib/partner-constants-loader'
import { buildContext, recordStepOutput } from './context'
import { executeNode } from './nodes/index'
import { executeParallelNode } from './nodes/parallel'
import type { ParallelChildResult } from './nodes/parallel'
import { findEntryNode, outgoingEdges, findNode, evaluateEdge } from './graph'
import { classifyHttpError, classifyTransportError } from './error-classifier'
import { PartnerApiError } from './nodes/partner-bid'
import { withRetry } from './retry'
import { createExecutionRecord, updateExecutionRecord, flushStepLogs } from './step-logger'
import type { StepLogEntry } from './step-logger'
import { sendFailureAlert, sendDurationAlert } from '../lib/slack'
import { CircuitBreakerClient } from '../lib/circuit-breaker-client'
import { log } from '../lib/logger'
import type { Env } from '../index'
import type {
  ExecutionContext,
  NodeDefinition,
  StepStatus,
  ErrorType,
  WorkflowDefinition,
} from '../types'

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

// Thrown when a service circuit breaker is open — treated as transient
class CircuitOpenError extends Error {
  constructor(service: string, opensAt?: number) {
    const when = opensAt ? ` (retries after ${new Date(opensAt).toISOString()})` : ''
    super(`Service "${service}" circuit is open — request skipped${when}`)
  }
}

export interface ExecuteOptions {
  workflowId: string
  payload: unknown
  source: string
  idempotencyKeyHeader?: string
  resumeFromExecutionId?: string
  isTest?: boolean
  executionId?: string
  definitionOverride?: WorkflowDefinition
}

export interface ExecuteResult {
  response: unknown
  status: number
  traceId: string
  idempotentReplay?: boolean
}

export interface WalkGraphResult {
  body: unknown
  status: number
}

export async function executeWorkflow(
  options: ExecuteOptions,
  env: Env,
  supabase: SupabaseClient,
  executionCtx: ExecutionContext_CF
): Promise<ExecuteResult> {
  const { workflowId, payload, source } = options
  const traceId = generateTraceId()

  // Load workflow definition (KV-cached), allowing a caller-supplied override (e.g. test runs with unsaved changes)
  const loaded = await loadWorkflowDefinition(workflowId, env.WORKFLOW_CACHE, supabase)
  const { workflow_version_id, workflow_name, org_id, slack_channel } = loaded
  const definition = options.definitionOverride ?? loaded.definition

  // Resolve idempotency key (needs definition)
  const idempotencyConfig = definition.trigger.config.idempotency
  let idempotencyKey: string | null = null

  if (idempotencyConfig?.enabled) {
    idempotencyKey = options.idempotencyKeyHeader ?? null
    if (!idempotencyKey && idempotencyConfig.derive_from_fields?.length) {
      idempotencyKey = await deriveIdempotencyKey(payload, idempotencyConfig.derive_from_fields)
    }
  }

  const ttl = idempotencyConfig?.ttl_seconds ?? 300

  // Parallel: idempotency check + env var load (both independent once we have definition/org_id)
  const executionId = options.executionId ?? crypto.randomUUID()
  const startedAt = new Date().toISOString()

  const [idempotencyCached, envVars] = await Promise.all([
    idempotencyKey ? checkIdempotency(env.IDEMPOTENCY, workflowId, idempotencyKey) : Promise.resolve(null),
    loadEnvVars(org_id, env.WORKFLOW_CACHE, supabase),
    // Pre-warm partner constants KV so constants node finds a hot cache instead of
    // paying the Supabase roundtrip cost mid-execution. Swallow errors — the constants
    // node retries on its own access and surfaces any real failure there.
    loadPartnerConstants(org_id, env.WORKFLOW_CACHE, supabase).catch(() => undefined),
  ])

  if (idempotencyCached) {
    if (idempotencyCached.status === 'processing') {
      log({ event: 'idempotency_hit', trace_id: traceId, workflow_id: workflowId, status: 'processing' })
      return { response: { error: 'Duplicate request in progress' }, status: 409, traceId }
    }
    log({ event: 'idempotency_hit', trace_id: traceId, workflow_id: workflowId, status: 'replay' })
    return { response: idempotencyCached.response, status: 200, traceId, idempotentReplay: true }
  }

  // Fire the idempotency-processing KV write and the execution-record insert
  // in parallel WITH the walk — they're independent of step execution. We
  // await them before flushing step logs at the end (execution_steps has a
  // FK on workflow_executions.id, so the record must exist before the batch
  // insert). This removes ~50-100ms of Supabase insert latency from the
  // critical path before the first step runs.
  const idempotencyProcessingPromise = idempotencyKey
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
    parent_execution_id: options.resumeFromExecutionId,
  })

  log({ event: 'execution_start', trace_id: traceId, workflow_id: workflowId, workflow_version_id, execution_id: executionId })

  // Build execution context
  const ctx = buildContext(payload, source, workflowId, traceId, envVars, org_id)

  // If resuming, pre-populate completed steps
  if (options.resumeFromExecutionId) {
    await preloadResumeContext(ctx, options.resumeFromExecutionId, supabase)
  }

  // Walk the graph
  let response: unknown = null
  let executionStatus = 'completed'
  let errorMessage: string | undefined
  let failedStep: string | undefined
  let failedErrorType: ErrorType = null
  let failedSuppressAlert = false

  // Step logs are accumulated here and flushed in a single Supabase insert after
  // the walk completes. Avoids serializing graph execution on N per-step writes.
  const stepLogQueue: StepLogEntry[] = []

  let walkStatus = 200

  // Respond-early mechanics: when a code node returns continueExecution:true,
  // walkGraph signals the response is ready via onRespondEarly. We race that
  // signal against full walk completion. Whichever fires first unblocks the
  // caller. The remaining walk (for continueExecution flows) finishes in the
  // background via ctx.waitUntil, matching Pipedream's $.respond() semantics.
  let earlyResponseResolve: (r: WalkGraphResult) => void = () => {}
  const earlyResponsePromise = new Promise<WalkGraphResult>((res) => { earlyResponseResolve = res })

  const walkPromise = walkGraph(
    ctx, definition, executionId, startedAt, supabase, env, workflow_version_id, stepLogQueue,
    (r) => earlyResponseResolve(r)
  )

  // Swallow walk errors here — they're re-caught below after awaiting. Raw
  // walkPromise is referenced by both the race and the background continuation.
  const walkPromiseCaught = walkPromise.catch((err) => ({ __error: err }))

  // Race: whichever resolves first becomes the response to the caller.
  const raceResult = await Promise.race([
    earlyResponsePromise.then((r) => ({ kind: 'early' as const, body: r.body, status: r.status })),
    walkPromiseCaught.then((r) => {
      if (r && typeof r === 'object' && '__error' in r) {
        return { kind: 'error' as const, err: (r as { __error: unknown }).__error }
      }
      const walkRes = r as WalkGraphResult
      return { kind: 'complete' as const, body: walkRes.body, status: walkRes.status }
    }),
  ])

  let hasContinuation = false
  if (raceResult.kind === 'early') {
    response = raceResult.body
    walkStatus = raceResult.status
    hasContinuation = true
  } else if (raceResult.kind === 'complete') {
    response = raceResult.body
    walkStatus = raceResult.status
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

  // Flush accumulated step logs. Must await the execution-record insert
  // first — execution_steps has a FK to workflow_executions.id, so the
  // batch insert fails if the record isn't there yet. Test runs await
  // the flush so the UI's post-response fetch finds rows; production
  // uses waitUntil so the HTTP response returns without waiting.
  //
  // Also: if we returned early due to continueExecution, the remaining walk
  // is still running. Chain the flush AFTER the walk fully completes so
  // post-response steps get their logs written too.
  const flushPromise = walkPromiseCaught
    .then(() => executionRecordPromise)
    .then(() => flushStepLogs(supabase, stepLogQueue, env.PII_REDACTION_FIELDS ?? ''))
    .catch((e) => console.error('[step-logger] flush failed:', e))

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

  // Update execution record (fire-and-forget)
  executionCtx.waitUntil(
    updateExecutionRecord(supabase, executionId, startedAt, {
      status: executionStatus,
      completed_at: completedAt,
      duration_ms: durationMs,
      response_body: response,
      error_message: errorMessage,
    }).catch((e) => console.error('[execution] failed to update execution record:', e))
  )

  // Send Slack alert on failure (skip business rejections and test runs)
  const durationAlertMs = definition.trigger.config.duration_alert_ms
  if (!options.isTest && durationAlertMs && durationMs > durationAlertMs) {
    executionCtx.waitUntil(
      sendDurationAlert(supabase, org_id, slack_channel, {
        workflow_id: workflowId,
        workflow_name,
        execution_id: executionId,
        duration_ms: durationMs,
        threshold_ms: durationAlertMs,
        timestamp: completedAt,
      }, env.APP_URL).catch((e) => console.error('[slack] duration alert failed:', e))
    )
  }

  if (executionStatus === 'failed' && !options.isTest && failedErrorType !== null && !failedSuppressAlert) {
    executionCtx.waitUntil(
      sendFailureAlert(supabase, org_id, slack_channel, {
        workflow_id: workflowId,
        workflow_name,
        execution_id: executionId,
        step_namespace: failedStep,
        error_message: errorMessage ?? 'Unknown error',
        error_type: failedErrorType,
        timestamp: completedAt,
      }, env.APP_URL).catch((e) => console.error('[slack] alert failed:', e))
    )
  }

  // Cache idempotency result
  if (idempotencyKey) {
    executionCtx.waitUntil(
      setIdempotencyResult(env.IDEMPOTENCY, workflowId, idempotencyKey, response, ttl)
        .catch((e) => console.error('[idempotency] failed to cache result:', e))
    )
  }

  return {
    response,
    status: executionStatus === 'completed' ? walkStatus : 500,
    traceId,
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

  while (current) {
    const node = current

    // Resume: step was already completed in a prior execution — skip re-execution, reuse output
    const priorStep = ctx.steps[node.namespace]
    if (priorStep?.status === 'completed') {
      const priorOutput = priorStep.output
      lastOutput = priorOutput
      if (node.type === 'exit' || node.type === 'response') return { body: priorOutput, status: 200 }
      const resumeEdges = outgoingEdges(node.id, definition.edges)
      let resumeNext: NodeDefinition | undefined
      if ((node.type === 'filter' || node.type === 'branch' || node.type === 'bid_evaluation') && priorOutput !== null && typeof priorOutput === 'object') {
        const route = (priorOutput as Record<string, unknown>)._route as string | undefined
        if (route) resumeNext = findNode(resumeEdges.find((e) => e.source_handle === route)?.target ?? '', definition.nodes)
      }
      if (!resumeNext) {
        const nextEdge = resumeEdges.find((e) => evaluateEdge(e, ctx))
        resumeNext = nextEdge ? findNode(nextEdge.target, definition.nodes) : undefined
      }
      current = resumeNext
      stepOrder++
      continue
    }

    // ── Parallel node — fan out to children concurrently ───────────────────────
    if (node.type === 'parallel') {
      const stepStartedAt = new Date().toISOString()
      log({ event: 'step_start', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type })
      const childIds = (node.children ?? []) as string[]
      const childNodes = childIds
        .map((id) => findNode(id, definition.nodes))
        .filter((n): n is NodeDefinition => n !== undefined)

      // Step-order allocation for the whole parallel block, so the UI renders
      // the flow in the expected order:
      //   parallel_start  →  child_0, child_1, ...  →  parallel_end  →  next step
      // Previous allocation collided (children started at stepOrder + 0, same as
      // parallel_start; parallel_end shared stepOrder with child_1).
      const parallelStartOrder = stepOrder
      const childOrderBase = stepOrder + 1
      const parallelEndOrder = childOrderBase + childNodes.length

      // Look ahead: if a parallel_end join node exists, use its config for
      // wait_for/timeout so those settings live on the end node in the UI.
      const previewChildEdges = childNodes.flatMap((c) => outgoingEdges(c.id, definition.edges))
      const endNodePreview = previewChildEdges
        .map((e) => findNode(e.target, definition.nodes))
        .find((n) => n?.type === 'parallel_end')
      const execNode = endNodePreview ? { ...node, config: { ...node.config, ...endNodePreview.config } } : node

      let output: unknown = null
      let stepStatus: StepStatus = 'completed'
      let errorMessage: string | undefined
      const errorType: ErrorType = null

      try {
        const result = await executeParallelNode(
          execNode,
          childNodes,
          (child, childIndex) =>
            runParallelChild(child, ctx, env, supabase, executionId, executionStartedAt, childOrderBase + childIndex, node.id, workflowVersionId, stepLogQueue)
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
            const childIndex = childNodes.findIndex((c) => c.namespace === childResult.namespace)
            if (childIndex < 0) continue
            const child = childNodes[childIndex]
            const errMsg = `Parallel group timed out after ${timeoutMs}ms before this child completed`
            recordStepOutput(ctx, child.namespace, { output: null, status: 'failed', error: errMsg, error_type: 'transient' })
            logStep(stepLogQueue, executionId, executionStartedAt, child, 'failed', null, null, errMsg, 'transient', 0, stepStartedAt, childOrderBase + childIndex, node.id)
          }
        }
      } catch (err) {
        stepStatus = 'failed'
        errorMessage = err instanceof Error ? err.message : String(err)
      }

      const parallelDurationMs = Date.now() - new Date(stepStartedAt).getTime()
      if (stepStatus === 'completed') {
        log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: parallelDurationMs })
      } else {
        log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: parallelDurationMs, error_message: errorMessage, error_type: errorType })
      }

      recordStepOutput(ctx, node.namespace, { output, status: stepStatus, error: errorMessage, error_type: errorType })
      logStep(stepLogQueue, executionId, executionStartedAt, node, stepStatus, null, output, errorMessage, errorType, 0, stepStartedAt, parallelStartOrder)

      // Locate the parallel_end join node — any edge from a child pointing to a
      // parallel_end counts. Logged with the same status as the parallel start
      // so the pair renders as a single logical unit on the canvas (green/red/etc.
      // together) even when parallel failed and we throw below.
      const childIdSet = new Set(childIds)
      const allChildEdges = childNodes.flatMap((c) => outgoingEdges(c.id, definition.edges))
      const endNodeId = allChildEdges.map((e) => e.target).find((tid) => {
        const n = findNode(tid, definition.nodes)
        return n?.type === 'parallel_end'
      })
      const endNode = endNodeId ? findNode(endNodeId, definition.nodes) : undefined
      if (endNode) {
        recordStepOutput(ctx, endNode.namespace, { output, status: stepStatus, error: errorMessage, error_type: errorType })
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
        const lastChild = childNodes.length > 0 ? childNodes[childNodes.length - 1] : null
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

    // ── Sequential step execution ───────────────────────────────────────────────
    const stepStartedAt = new Date().toISOString()
    log({ event: 'step_start', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type })
    let stepStatus: StepStatus = 'running'
    let output: unknown = null
    let errorMessage: string | undefined
    let errorType: ErrorType = null
    let retriesUsed = 0

    const retryConfig = {
      retries: (node.config.retries as number) ?? 0,
      backoff: (node.config.retry_backoff as 'linear' | 'exponential') ?? 'linear',
      timeout_ms: (node.config.timeout_ms as number) ?? 30000,
    }

    // Circuit breaker — applies to nodes with config.service set (Webhook nodes, PRD Section 2.5.2)
    const serviceName = typeof node.config.service === 'string' ? node.config.service : null
    const cbClient = serviceName ? new CircuitBreakerClient(env, serviceName) : null

    // Tracks whether the earlyResponse branch already logged the step so the
    // outer completion path doesn't double-log it.
    let loggedEarly = false

    try {
      // Check circuit before attempting the call
      if (cbClient) {
        const cbCheck = await cbClient.check()
        if (!cbCheck.allowed) {
          log({ event: 'circuit_open', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, partner_id: serviceName ?? undefined })
          throw new CircuitOpenError(serviceName!, cbCheck.opens_at)
        }
      }

      const result = await withRetry(
        () => executeNode(node, ctx, env, supabase),
        retryConfig,
        (err) => {
          if (err instanceof Response) return classifyHttpError(err.status)
          return classifyTransportError(err)
        }
      )
      output = result.output
      stepStatus = 'completed'
      lastOutput = output

      // Record success — closes half-open circuit if probing
      if (cbClient) cbClient.recordSuccess().catch(() => {})

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
        const sentinelFailed = respStatus !== undefined && respStatus >= 400
        const earlyStepStatus: StepStatus = sentinelFailed ? 'failed' : 'completed'
        const earlyErrorMessage = sentinelFailed
          ? `Code returned error response: HTTP ${respStatus}${
              result.earlyResponse?.body
                ? ` — ${(typeof result.earlyResponse.body === 'string'
                    ? result.earlyResponse.body
                    : JSON.stringify(result.earlyResponse.body)
                  ).slice(0, 300)}`
                : ''
            }`
          : undefined
        const earlyErrorType: ErrorType = sentinelFailed ? classifyHttpError(respStatus!) : null

        if (sentinelFailed) {
          log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMsEarly, error_message: earlyErrorMessage, error_type: earlyErrorType })
        } else {
          log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMsEarly })
        }
        recordStepOutput(ctx, node.namespace, { output, status: earlyStepStatus, error: earlyErrorMessage, error_type: earlyErrorType })
        logStep(stepLogQueue, executionId, executionStartedAt, node, earlyStepStatus, null, output, earlyErrorMessage, earlyErrorType, retriesUsed, stepStartedAt, stepOrder)
        loggedEarly = true
        if (result.continueAfterResponse && result.earlyResponse) {
          pendingResponse = { body: result.earlyResponse.body, status: result.earlyResponse.status }
          // Signal to the outer handler that the response is ready now; the
          // remaining walk continues here but the caller doesn't have to wait
          // for it (outer pushes the continuation into ctx.waitUntil).
          onRespondEarly?.(pendingResponse)
          // fall through — continue walking the graph
        } else {
          if (result.earlyResponse) {
            return { body: result.earlyResponse.body, status: result.earlyResponse.status }
          }
          return { body: output, status: 200 }
        }
      }

    } catch (err) {
      // Classify error type — needed for CB recording and Slack alerting
      let suppressAlert = false
      if (err instanceof PartnerApiError) {
        errorType = err.errorType
        suppressAlert = err.suppressAlert
      } else if (err instanceof CircuitOpenError) {
        errorType = 'transient'
      } else if (err instanceof Response) {
        errorType = classifyHttpError(err.status)
      } else {
        errorType = classifyTransportError(err)
      }

      // Only transient errors count toward the circuit breaker threshold (PRD Section 2.5.2)
      // CircuitOpenError itself is not recorded — no request was attempted
      if (cbClient && errorType === 'transient' && !(err instanceof CircuitOpenError)) {
        cbClient.recordError().catch(() => {})
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
          recordStepOutput(ctx, node.namespace, { output: null, status: stepStatus, error: errorMessage, error_type: errorType })
          logStep(stepLogQueue, executionId, executionStartedAt, node, stepStatus, null, output, errorMessage, errorType, retriesUsed, stepStartedAt, stepOrder)
          current = fallback
          stepOrder++
          continue
        }
        throw new Error(`Fallback node ${node.config.fallback_node} not found`)
      } else {
        stepStatus = 'failed'
        log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMs, error_message: errorMessage, error_type: errorType })
        recordStepOutput(ctx, node.namespace, { output: null, status: stepStatus, error: errorMessage, error_type: errorType })
        logStep(stepLogQueue, executionId, executionStartedAt, node, stepStatus, null, output, errorMessage, errorType, retriesUsed, stepStartedAt, stepOrder)
        throw new StepFailureError(errorMessage, node.namespace, errorType, suppressAlert)
      }
    }

    // Skip the normal completion logging if the earlyResponse branch above
    // already logged the step (continueExecution case). Without this guard,
    // the step shows up twice in the Steps list with identical durations.
    if (!loggedEarly) {
      const seqDurationMs = Date.now() - new Date(stepStartedAt).getTime()
      log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMs })
      recordStepOutput(ctx, node.namespace, { output, status: stepStatus })
      logStep(stepLogQueue, executionId, executionStartedAt, node, stepStatus, null, output, errorMessage, errorType, retriesUsed, stepStartedAt, stepOrder)
    }

    // Exit node — return immediately
    if (node.type === 'exit' || node.type === 'response') {
      return { body: output, status: 200 }
    }

    // Follow the appropriate outgoing edge.
    // Filter/branch nodes signal their chosen output via output._route which
    // maps to edge source_handle. Fall through to condition evaluation otherwise.
    const edges = outgoingEdges(node.id, definition.edges)
    let nextEdge: import('../types').EdgeDefinition | undefined

    if ((node.type === 'filter' || node.type === 'branch' || node.type === 'bid_evaluation') &&
        output !== null && typeof output === 'object') {
      const route = (output as Record<string, unknown>)._route as string | undefined
      if (route) nextEdge = edges.find((e) => e.source_handle === route)
    }

    if (!nextEdge) {
      nextEdge = edges.find((e) => evaluateEdge(e, ctx))
    }

    current = nextEdge ? findNode(nextEdge.target, definition.nodes) : undefined
    stepOrder++
  }

  return pendingResponse ?? { body: lastOutput, status: 200 }
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
  parallelGroupId?: string
): void {
  const completedAt = new Date().toISOString()
  const durationMs = Date.now() - new Date(startedAt).getTime()
  queue.push({
    execution_id: executionId,
    execution_started_at: executionStartedAt,
    step_namespace: node.namespace,
    step_type: node.type,
    status,
    input,
    output,
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

// Execute a single child node within a parallel group — simplified version of
// the main walkGraph step loop: retries + logging, but no on_error branching
// (parallel children always contribute their result, fulfilled or rejected).
async function runParallelChild(
  child: NodeDefinition,
  ctx: ExecutionContext,
  env: Env,
  supabase: SupabaseClient,
  executionId: string,
  executionStartedAt: string,
  stepOrder: number,
  parallelGroupId: string,
  workflowVersionId = '',
  stepLogQueue: StepLogEntry[] = []
): Promise<ParallelChildResult> {
  const stepStartedAt = new Date().toISOString()
  log({ event: 'step_start', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: child.namespace, step_type: child.type })

  const retryConfig = {
    retries: (child.config.retries as number) ?? 0,
    backoff: (child.config.retry_backoff as 'linear' | 'exponential') ?? 'linear',
    timeout_ms: (child.config.timeout_ms as number) ?? 30000,
  }

  let output: unknown = null
  let stepStatus: StepStatus = 'completed'
  let errorMessage: string | undefined
  let errorType: ErrorType = null

  try {
    const result = await withRetry(
      () => executeNode(child, ctx, env, supabase),
      retryConfig,
      (err) => {
        if (err instanceof Response) return classifyHttpError(err.status)
        return classifyTransportError(err)
      }
    )
    output = result.output

    // Early-response and early-exit sentinels don't make sense inside a
    // parallel block — you can't respond or exit the workflow while sibling
    // children are still running. Treat them as child failures so the
    // parallel's on_child_error policy handles them consistently, and so
    // the step shows the correct failed/red state in the UI instead of
    // silently looking successful with an error shape in its output.
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
  }

  const childDurationMs = Date.now() - new Date(stepStartedAt).getTime()
  if (stepStatus === 'completed') {
    log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: child.namespace, step_type: child.type, duration_ms: childDurationMs })
  } else {
    log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: child.namespace, step_type: child.type, duration_ms: childDurationMs, error_message: errorMessage, error_type: errorType })
  }

  recordStepOutput(ctx, child.namespace, { output, status: stepStatus, error: errorMessage, error_type: errorType })
  logStep(stepLogQueue, executionId, executionStartedAt, child, stepStatus, null, output, errorMessage, errorType, 0, stepStartedAt, stepOrder, parallelGroupId)

  return stepStatus === 'completed'
    ? { namespace: child.namespace, status: 'fulfilled', output }
    : { namespace: child.namespace, status: 'rejected', error: errorMessage }
}

async function preloadResumeContext(
  ctx: ExecutionContext,
  parentExecutionId: string,
  supabase: SupabaseClient
): Promise<void> {
  const { data: steps } = await supabase
    .from('execution_steps')
    .select('step_namespace, output, status')
    .eq('execution_id', parentExecutionId)
    .eq('status', 'completed')

  for (const step of (steps ?? [])) {
    ctx.steps[step.step_namespace] = {
      output: step.output,
      status: 'completed',
    }
  }
}

// Cloudflare ExecutionContext type alias (avoid conflict with our ExecutionContext)
type ExecutionContext_CF = {
  waitUntil: (promise: Promise<unknown>) => void
}
