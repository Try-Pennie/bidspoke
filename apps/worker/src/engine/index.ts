import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTraceId, deriveIdempotencyKey } from '../lib/crypto'
import { checkIdempotency, setIdempotencyProcessing, setIdempotencyResult } from './idempotency'
import { loadWorkflowDefinition } from './definition-loader'
import { loadEnvVars } from '../lib/env-loader'
import { buildContext, recordStepOutput } from './context'
import { executeNode } from './nodes/index'
import { executeParallelNode } from './nodes/parallel'
import type { ParallelChildResult } from './nodes/parallel'
import { findEntryNode, outgoingEdges, findNode, evaluateEdge } from './graph'
import { classifyHttpError, classifyTransportError } from './error-classifier'
import { PartnerApiError } from './nodes/partner-bid'
import { withRetry } from './retry'
import { writeStepLog, createExecutionRecord, updateExecutionRecord } from './step-logger'
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
  ])

  if (idempotencyCached) {
    if (idempotencyCached.status === 'processing') {
      log({ event: 'idempotency_hit', trace_id: traceId, workflow_id: workflowId, status: 'processing' })
      return { response: { error: 'Duplicate request in progress' }, status: 409, traceId }
    }
    log({ event: 'idempotency_hit', trace_id: traceId, workflow_id: workflowId, status: 'replay' })
    return { response: idempotencyCached.response, status: 200, traceId, idempotentReplay: true }
  }

  // Parallel: mark idempotency in-progress + create execution record (both independent)
  await Promise.all([
    idempotencyKey ? setIdempotencyProcessing(env.IDEMPOTENCY, workflowId, idempotencyKey, ttl) : Promise.resolve(),
    createExecutionRecord(supabase, {
      id: executionId,
      workflow_id: workflowId,
      workflow_version_id,
      source,
      trigger_payload: payload,
      trace_id: traceId,
      started_at: startedAt,
      is_test: options.isTest ?? false,
      parent_execution_id: options.resumeFromExecutionId,
    }),
  ])

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

  let walkStatus = 200
  try {
    const walkResult = await walkGraph(ctx, definition, executionId, startedAt, supabase, env, workflow_version_id)
    response = walkResult.body
    walkStatus = walkResult.status
  } catch (err) {
    executionStatus = 'failed'
    errorMessage = err instanceof Error ? err.message : String(err)
    if (err instanceof StepFailureError) {
      failedStep = err.stepNamespace
      failedErrorType = err.errorType
      failedSuppressAlert = err.suppressAlert
    }
    response = { error: errorMessage, trace_id: traceId }
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

// Walk the graph from entry node to completion, executing each step
// Exported for unit testing only — not part of the public API
export async function walkGraph(
  ctx: ExecutionContext,
  definition: { nodes: NodeDefinition[]; edges: import('../types').EdgeDefinition[] },
  executionId: string,
  executionStartedAt: string,
  supabase: SupabaseClient,
  env: Env,
  workflowVersionId = ''
): Promise<WalkGraphResult> {
  let current: NodeDefinition | undefined = findEntryNode(definition.nodes, definition.edges)
  let stepOrder = 0
  let lastOutput: unknown = null

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

      let output: unknown = null
      let stepStatus: StepStatus = 'completed'
      let errorMessage: string | undefined
      const errorType: ErrorType = null

      try {
        const result = await executeParallelNode(
          node,
          childNodes,
          (child, childIndex) =>
            runParallelChild(child, ctx, env, supabase, executionId, executionStartedAt, stepOrder + childIndex, node.id, workflowVersionId)
        )
        output = result.output
        lastOutput = output
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
      await logStep(supabase, env, executionId, executionStartedAt, node, stepStatus, null, output, errorMessage, errorType, 0, stepStartedAt, stepOrder)

      if (stepStatus === 'failed') {
        throw new StepFailureError(errorMessage!, node.namespace, errorType)
      }

      const edges = outgoingEdges(node.id, definition.edges)
      const nextEdge = edges.find((e) => evaluateEdge(e, ctx))
      current = nextEdge ? findNode(nextEdge.target, definition.nodes) : undefined
      stepOrder++
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

      // Early exit from a code node (translated $.respond() / $.flow.exit() Pipedream patterns)
      if (result.earlyResponse ?? result.earlyExit) {
        const seqDurationMsEarly = Date.now() - new Date(stepStartedAt).getTime()
        log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMsEarly })
        recordStepOutput(ctx, node.namespace, { output, status: 'completed' })
        await logStep(supabase, env, executionId, executionStartedAt, node, 'completed', null, output, undefined, null, retriesUsed, stepStartedAt, stepOrder)
        if (result.earlyResponse) {
          return { body: result.earlyResponse.body, status: result.earlyResponse.status }
        }
        return { body: output, status: 200 }
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
          await logStep(supabase, env, executionId, executionStartedAt, node, stepStatus, null, output, errorMessage, errorType, retriesUsed, stepStartedAt, stepOrder)
          current = fallback
          stepOrder++
          continue
        }
        throw new Error(`Fallback node ${node.config.fallback_node} not found`)
      } else {
        stepStatus = 'failed'
        log({ event: 'step_error', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMs, error_message: errorMessage, error_type: errorType })
        recordStepOutput(ctx, node.namespace, { output: null, status: stepStatus, error: errorMessage, error_type: errorType })
        await logStep(supabase, env, executionId, executionStartedAt, node, stepStatus, null, output, errorMessage, errorType, retriesUsed, stepStartedAt, stepOrder)
        throw new StepFailureError(errorMessage, node.namespace, errorType, suppressAlert)
      }
    }

    const seqDurationMs = Date.now() - new Date(stepStartedAt).getTime()
    log({ event: 'step_complete', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, workflow_version_id: workflowVersionId, step_namespace: node.namespace, step_type: node.type, duration_ms: seqDurationMs })
    recordStepOutput(ctx, node.namespace, { output, status: stepStatus })
    await logStep(supabase, env, executionId, executionStartedAt, node, stepStatus, null, output, errorMessage, errorType, retriesUsed, stepStartedAt, stepOrder)

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

  return { body: lastOutput, status: 200 }
}

async function logStep(
  supabase: SupabaseClient,
  env: Env,
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
): Promise<void> {
  const completedAt = new Date().toISOString()
  const durationMs = Date.now() - new Date(startedAt).getTime()
  await writeStepLog(supabase, {
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
  }, env.PII_REDACTION_FIELDS ?? '')
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
  workflowVersionId = ''
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
  await logStep(supabase, env, executionId, executionStartedAt, child, stepStatus, null, output, errorMessage, errorType, 0, stepStartedAt, stepOrder, parallelGroupId)

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
