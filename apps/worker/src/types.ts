// ============================================================
// Workflow definition types
// ============================================================

// The node type list lives in @bidspoke/node-types (#1411), one array both apps
// read, so this union and the web's NODE_TYPES cannot drift. Re-exported here so
// every existing import of NodeType from './types' keeps working.
export { NODE_TYPES, NODE_TRAITS, assertNever, isNodeType } from '@bidspoke/node-types'
export type { NodeType, NodeTraits } from '@bidspoke/node-types'
import type { NodeType } from '@bidspoke/node-types'

export interface WorkflowDefinition {
  id: string
  name: string
  trigger: TriggerConfig
  nodes: NodeDefinition[]
  edges: EdgeDefinition[]
}

// A known failure signal whose per-execution Slack page is muted; instead one
// aggregated page fires when matching failures cross a rate threshold (#248).
export interface MutedFailureSignal {
  /** Case-insensitive substring matched against the failure's error_message. */
  match: string
  /** Aggregated alert fires when matching failures reach this many in the window. */
  count: number
  /** Trailing window, in minutes, the count is measured over. */
  window_minutes: number
  /** Per-signal cooldown between aggregated alerts. Defaults to 30 min. */
  cooldown_minutes?: number
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
    /** Failure signals whose per-run page is muted in favor of a rate alert (#248). */
    muted_failure_signals?: MutedFailureSignal[]
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

// 'degraded' (served correctly, but a post-response continuation failed, #310)
// was missing here for as long as it has been written to the database. The
// measured vocabulary and the guard that keeps it honest live in
// src/archive/fixtures/execution-statuses.json and
// src/archive/__tests__/execution-status-vocabulary.test.ts (#930).
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'exited' | 'degraded'
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
  /**
   * How the engine waits out a step's retry backoff (#1063). Undefined in
   * production, which means the real timer.
   *
   * A test that drives the engine through a retry otherwise lives through the
   * real 1.5s of default backoff and can assert only that it survived it
   * (L524). Set this to a recorder and the delays themselves become assertable.
   * Nothing in the Worker sets it: buildContext does not, so a production run
   * cannot reach a path that skips its own backoff.
   */
  retrySleep?: (ms: number) => Promise<void>
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
   * Partner block sightings noted by readers during the current step (#1265), drained by
   * the walker after every step. A reader with no step result to ride on (the partner dedup
   * check, which answers a boolean and carries on) notes here.
   */
  blockSightings?: PartnerBlockSighting[]
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
  /**
   * True when this run came from the in-app Test Runner. Alerts must stay silent for
   * these: a test run against a live partner can genuinely trip a circuit breaker, and
   * paging ops for it is a false alarm (#547). The engine's own failure/duration/
   * dead-letter alerts already gate on the same flag via `options.isTest`; this carries
   * it to node executors, which only ever see the context.
   */
  isTest?: boolean
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
  /**
   * Partner responses recognised as a firewall block page while this step ran (#1265).
   * Node executors cannot reach the Cloudflare context, a Supabase client or the Worker
   * Env uniformly, so a sighting rides on the result (or on a thrown error, the way
   * `logs` and `resolvedInput` do) and the engine reports it from one place.
   */
  blockSightings?: PartnerBlockSighting[]
}

/**
 * One partner response that a firewall answered instead of the partner (#1265). `host` is
 * the host we called; `seenIn` names the step (or `code:<namespace>` for a code node fetch).
 */
export interface PartnerBlockSighting {
  host: string
  status: number
  vendor: 'cloudflare' | 'unknown'
  bodyRayId: string | null
  edgeRayId: string | null
  markers: string[]
  seenIn: string
  /** The partner's other hosts behind the same firewall, when known, so one incident reads as one story. */
  siblingHosts?: string[]
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
  // Wire contract of the original response. Optional for backward
  // compatibility with entries cached before these fields existed —
  // readers default to 200 / no headers.
  responseStatus?: number
  responseHeaders?: Record<string, string>
}
