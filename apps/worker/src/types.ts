// ============================================================
// Workflow definition types
// ============================================================

export type NodeType =
  | 'code'
  | 'filter'
  | 'branch'
  | 'parallel'
  | 'parallel_end'
  | 'partner_bid'
  | 'webhook'
  | 'transform'
  | 'bid_evaluation'
  | 'response'
  | 'exit'
  | 'constants'

export interface WorkflowDefinition {
  id: string
  name: string
  trigger: TriggerConfig
  nodes: NodeDefinition[]
  edges: EdgeDefinition[]
}

export interface TriggerConfig {
  type: 'http_webhook'
  config: {
    method: string
    custom_response?: boolean
    auth_method: 'api_key'
    idempotency?: {
      enabled: boolean
      derive_from_fields?: string[]
      ttl_seconds?: number
    }
    duration_alert_ms?: number
  }
}

export interface NodeDefinition {
  id: string
  namespace: string
  label?: string
  type: NodeType
  position?: { x: number; y: number }
  config: NodeConfig
  variables?: Record<string, string>
  parent?: string   // parent parallel node id
  children?: string[] // child node ids (parallel only)
}

export interface NodeConfig {
  timeout_ms?: number
  retries?: number
  retry_backoff?: 'linear' | 'exponential'
  on_error?: 'fail' | 'skip' | 'fallback'
  fallback_node?: string
  [key: string]: unknown
}

export interface EdgeCondition {
  field: string
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains' | 'exists' | 'not_exists'
  value?: unknown
}

export interface ConditionGroup {
  conditions: EdgeCondition[]
  logic: 'AND' | 'OR'
}

export interface EdgeDefinition {
  id: string
  source: string
  source_handle?: string  // 'pass' | 'exit' for filter; branch label for branch
  target: string
  condition?: {
    groups: ConditionGroup[]
    logic: 'AND' | 'OR'
  }
}

// ============================================================
// Execution types
// ============================================================

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'exited'
export type StepStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'failed_with_fallback'
export type ErrorType = 'transient' | 'permanent' | null

export interface ExecutionContext {
  trigger: {
    payload: unknown
    source: string
    workflow_id: string
    trace_id: string
    org_id: string
  }
  steps: Record<string, StepOutput>  // keyed by node namespace
  env: Record<string, string>
}

export interface StepOutput {
  output: unknown
  status: StepStatus
  error?: string
  error_type?: ErrorType
}

export interface StepExecutionResult {
  output: unknown
  error?: string
  error_type?: ErrorType
  earlyResponse?: { status: number; body: unknown; headers?: Record<string, string> }
  earlyExit?: true
}

export interface LoadedWorkflow {
  definition: WorkflowDefinition
  workflow_version_id: string
  workflow_name: string
  org_id: string
  slack_channel: string | null
}

export interface IdempotencyState {
  status: 'processing' | 'complete'
  response?: unknown
}
