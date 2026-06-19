// ============================================================
// Workflow definition types
// ============================================================

export type NodeType =
  | 'code'
  | 'filter'
  | 'branch'
  | 'branch_end'
  | 'parallel'
  | 'parallel_end'
  | 'partner_bid'
  | 'bid_group'
  | 'webhook'
  | 'transform'
  | 'response'
  | 'exit'
  | 'constants'
  | 'salesforce'
  | 'data_store'
  | 'latency_gate'
  | 'achieve_offers'

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
    auth_method: 'api_key' | 'none'
    idempotency?: {
      enabled: boolean
      derive_from_fields?: string[]
      ttl_seconds?: number
    }
    duration_alert_ms?: number
    success_node_namespaces?: string[]
  }
}

export type ExecutionOutcome = 'successful' | 'completed' | 'failed'

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
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains' | 'is_true' | 'is_false' | 'exists' | 'not_exists' | 'is_null' | 'is_not_null' | 'in_array' | 'not_in_array'
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
    execution_id?: string
    sighting_id?: string
  }
  steps: Record<string, StepOutput>  // keyed by node namespace
  env: Record<string, string>
  /** Derived per-run metadata exposed to templates as {{execution.*}}. Populated by buildContext. */
  execution?: {
    workflow_id: string
    trace_id: string
    execution_id?: string
    /** Deeplink to this run in the Bidspoke UI. Undefined if APP_URL or execution_id is missing. */
    bidspoke_link?: string
  }
  /** Namespace of the most recent step that completed successfully. Drives outcome classification. */
  lastCompletedNamespace?: string
  /** Dispatch-namespace bundle name code nodes route to. Set for test runs to an
   *  ephemeral content-hashed bundle so unsaved edits run immediately; unset for
   *  prod runs (code.ts falls back to the stable codeBundleName). */
  codeBundleName?: string
  /**
   * Per-BidGroup context map. Set by walkGraph before evaluating partner attempts
   * and cleared after the group resolves. Exposed to partner formulas as
   * `context.<key>` so partners can stay workflow-agnostic (the BidGroup author
   * binds these to specific step outputs at the workflow level).
   */
  bidGroupContext?: Record<string, unknown>
  /**
   * Bid-attempt insert promises (lead_sighting_bids) registered by partner-bid
   * nodes. finalizeSighting awaits these before its winner UPDATE so the UPDATE
   * doesn't race the inserts and match zero rows (#88). Populated lazily.
   */
  pendingBidWrites?: Promise<void>[]
  /**
   * Shadow execution mode. 'dry_run' runs the workflow logic but every outbound
   * node returns a stub instead of firing (no Salesforce/Equifax/partner/HTTP/KV
   * side effects). 'stand_in' is the same, except Partner Bid resolves a
   * deterministic bid without the outbound submission so winner selection and
   * routing can be rehearsed too (#232). Unset / 'off' = normal execution. See
   * engine/shadow.ts and docs/engine-cutover-scope.md section 3.3.
   */
  shadow_mode?: 'off' | 'dry_run' | 'stand_in'
}

export interface StepOutput {
  output: unknown
  status: StepStatus
  error?: string
  error_type?: ErrorType
}

export interface StepLogEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  message: string
  ts: string
}

// Captured per-step input for the UI's Results panel. `template` is the
// pre-template config the author wrote (e.g. `{ BirthDate__c: "{{trigger.payload.dob}}" }`);
// `resolved` is what those templates produced at execute time. Showing both
// lets users tell at a glance whether bad output came from a malformed source
// value or wrong template logic without panel-hopping.
export interface ResolvedStepInput {
  template: unknown
  resolved: unknown
}

export interface StepExecutionResult {
  output: unknown
  error?: string
  error_type?: ErrorType
  earlyResponse?: { status: number; body: unknown; headers?: Record<string, string> }
  earlyExit?: true
  continueAfterResponse?: true  // respond but keep walking (mirrors Pipedream $.respond() without $.flow.exit())
  expected?: true  // expected error: keep step status `completed` and skip Slack even if earlyResponse is 4xx/5xx
  logs?: StepLogEntry[]
  resolvedInput?: ResolvedStepInput
}

export interface LoadedWorkflow {
  definition: WorkflowDefinition
  workflow_version_id: string
  workflow_name: string
  org_id: string
  slack_channel: string | null
  capture_sightings: boolean
}

export interface IdempotencyState {
  status: 'processing' | 'complete'
  response?: unknown
  // Wire contract of the original response. Optional for backward
  // compatibility with entries cached before these fields existed —
  // readers default to 200 / no headers.
  responseStatus?: number
  responseHeaders?: Record<string, string>
}
