import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTraceId, deriveIdempotencyKey } from '../lib/crypto'
import { checkIdempotency, setIdempotencyProcessing, setIdempotencyResult } from './idempotency'
import { loadWorkflowDefinition } from './definition-loader'
import { buildContext, recordStepOutput } from './context'
import { executeNode } from './nodes/index'
import { findEntryNode, outgoingEdges, findNode, evaluateEdge } from './graph'
import { classifyHttpError, classifyTransportError } from './error-classifier'
import { withRetry } from './retry'
import { writeStepLog, createExecutionRecord, updateExecutionRecord } from './step-logger'
import { sendFailureAlert } from '../lib/slack'
import { CircuitBreakerClient } from '../lib/circuit-breaker-client'
import type { Env } from '../index'
import type {
  ExecutionContext,
  NodeDefinition,
  StepStatus,
  ErrorType,
} from '../types'

// Carries step context through the throw so the alert can report which step failed
class StepFailureError extends Error {
  constructor(
    message: string,
    public readonly stepNamespace: string,
    public readonly errorType: ErrorType
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
}

export interface ExecuteResult {
  response: unknown
  status: number
  traceId: string
  idempotentReplay?: boolean
}

export async function executeWorkflow(
  options: ExecuteOptions,
  env: Env,
  supabase: SupabaseClient,
  executionCtx: ExecutionContext_CF
): Promise<ExecuteResult> {
  const { workflowId, payload, source } = options
  const traceId = generateTraceId()

  // Load workflow definition (KV-cached)
  const { definition, workflow_version_id, workflow_name, org_id, slack_channel } =
    await loadWorkflowDefinition(workflowId, env.WORKFLOW_CACHE, supabase)

  // Resolve idempotency key
  const idempotencyConfig = definition.trigger.config.idempotency
  let idempotencyKey: string | null = null

  if (idempotencyConfig?.enabled) {
    idempotencyKey = options.idempotencyKeyHeader ?? null
    if (!idempotencyKey && idempotencyConfig.derive_from_fields?.length) {
      idempotencyKey = await deriveIdempotencyKey(payload, idempotencyConfig.derive_from_fields)
    }
  }

  const ttl = idempotencyConfig?.ttl_seconds ?? 300

  // Idempotency check
  if (idempotencyKey) {
    const cached = await checkIdempotency(env.IDEMPOTENCY, workflowId, idempotencyKey)
    if (cached) {
      if (cached.status === 'processing') {
        return { response: { error: 'Duplicate request in progress' }, status: 409, traceId }
      }
      return { response: cached.response, status: 200, traceId, idempotentReplay: true }
    }
    await setIdempotencyProcessing(env.IDEMPOTENCY, workflowId, idempotencyKey, ttl)
  }

  // Load env vars for this org (global scope only for now)
  const { data: envRows } = await supabase
    .from('environment_variables')
    .select('key, value')
    .eq('scope', 'global')
    .is('is_secret', false)
  const envVars: Record<string, string> = {}
  for (const row of (envRows ?? [])) {
    if (row.value) envVars[row.key] = row.value
  }

  const executionId = crypto.randomUUID()
  const startedAt = new Date().toISOString()

  // Create execution record
  executionCtx.waitUntil(
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
    })
  )

  // Build execution context
  const ctx = buildContext(payload, source, workflowId, traceId, envVars)

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

  try {
    response = await walkGraph(ctx, definition, executionId, startedAt, supabase, env)
  } catch (err) {
    executionStatus = 'failed'
    errorMessage = err instanceof Error ? err.message : String(err)
    if (err instanceof StepFailureError) {
      failedStep = err.stepNamespace
      failedErrorType = err.errorType
    }
    response = { error: errorMessage, trace_id: traceId }
  }

  const completedAt = new Date().toISOString()
  const durationMs = Date.now() - new Date(startedAt).getTime()

  // Update execution record (fire-and-forget)
  executionCtx.waitUntil(
    updateExecutionRecord(supabase, executionId, startedAt, {
      status: executionStatus,
      completed_at: completedAt,
      duration_ms: durationMs,
      response_body: response,
      error_message: errorMessage,
    })
  )

  // Send Slack alert on failure (skip business rejections and test runs)
  if (executionStatus === 'failed' && !options.isTest && failedErrorType !== null) {
    executionCtx.waitUntil(
      sendFailureAlert(supabase, org_id, slack_channel, {
        workflow_id: workflowId,
        workflow_name,
        execution_id: executionId,
        trace_id: traceId,
        step_namespace: failedStep,
        error_message: errorMessage ?? 'Unknown error',
        error_type: failedErrorType,
        timestamp: completedAt,
      }).catch((e) => console.error('[slack] alert failed:', e))
    )
  }

  // Cache idempotency result
  if (idempotencyKey) {
    executionCtx.waitUntil(
      setIdempotencyResult(env.IDEMPOTENCY, workflowId, idempotencyKey, response, ttl)
    )
  }

  return {
    response,
    status: executionStatus === 'completed' ? 200 : 500,
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
  env: Env
): Promise<unknown> {
  let current: NodeDefinition | undefined = findEntryNode(definition.nodes, definition.edges)
  let stepOrder = 0
  let lastOutput: unknown = null

  while (current) {
    const node = current
    const stepStartedAt = new Date().toISOString()
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

    // Circuit breaker — applies to nodes with config.service set (Integration nodes, PRD Section 2.5.2)
    const serviceName = typeof node.config.service === 'string' ? node.config.service : null
    const cbClient = serviceName ? new CircuitBreakerClient(env, serviceName) : null

    try {
      // Check circuit before attempting the call
      if (cbClient) {
        const cbCheck = await cbClient.check()
        if (!cbCheck.allowed) {
          throw new CircuitOpenError(serviceName!, cbCheck.opens_at)
        }
      }

      const result = await withRetry(
        () => executeNode(node, ctx, env),
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

    } catch (err) {
      // Classify error type — needed for CB recording and Slack alerting
      if (err instanceof CircuitOpenError) {
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

      if (onError === 'skip') {
        stepStatus = 'skipped'
      } else if (onError === 'fallback' && node.config.fallback_node) {
        stepStatus = 'failed_with_fallback'
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
        recordStepOutput(ctx, node.namespace, { output: null, status: stepStatus, error: errorMessage, error_type: errorType })
        await logStep(supabase, env, executionId, executionStartedAt, node, stepStatus, null, output, errorMessage, errorType, retriesUsed, stepStartedAt, stepOrder)
        throw new StepFailureError(errorMessage, node.namespace, errorType)
      }
    }

    recordStepOutput(ctx, node.namespace, { output, status: stepStatus })
    await logStep(supabase, env, executionId, executionStartedAt, node, stepStatus, null, output, errorMessage, errorType, retriesUsed, stepStartedAt, stepOrder)

    // Exit node — return immediately
    if (node.type === 'exit' || node.type === 'response') {
      return output
    }

    // Follow the appropriate outgoing edge.
    // Filter/branch nodes signal their chosen output via output._route which
    // maps to edge source_handle. Fall through to condition evaluation otherwise.
    const edges = outgoingEdges(node.id, definition.edges)
    let nextEdge: import('../types').EdgeDefinition | undefined

    if ((node.type === 'filter' || node.type === 'branch') &&
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

  return lastOutput
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
  stepOrder: number
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
  }, env.PII_REDACTION_FIELDS ?? '')
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
