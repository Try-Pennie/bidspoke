export type NodeType =
  | 'filter'
  | 'branch'
  | 'code'
  | 'response'
  | 'exit'
  | 'parallel'
  | 'parallel_end'
  | 'partner_bid'
  | 'webhook'
  | 'transform'
  | 'bid_evaluation'
  | 'constants'
  | 'salesforce'

export interface EdgeCondition {
  field: string
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains' | 'exists' | 'not_exists'
  value?: unknown
}

export interface ConditionGroup {
  conditions: EdgeCondition[]
  logic: 'AND' | 'OR'
}

export interface NodeDef {
  id: string
  namespace: string
  label?: string
  type: NodeType
  position?: { x: number; y: number }
  config: Record<string, unknown>
  variables?: Record<string, string>
  children?: string[] // parallel node child IDs
}

export interface EdgeDef {
  id: string
  source: string
  source_handle?: string
  target: string
  condition?: {
    groups: ConditionGroup[]
    logic: 'AND' | 'OR'
  }
}

export interface TriggerDef {
  type: 'http_webhook'
  config: {
    method: string
    auth_method: 'api_key'
    custom_response?: boolean
    idempotency?: {
      enabled: boolean
      derive_from_fields?: string[]
      ttl_seconds?: number
    }
    duration_alert_ms?: number
    /**
     * Node namespaces that count as "successful" when the walk ends on one
     * of them. Empty or missing = no runs are marked Successful; everything
     * non-failed goes to Completed.
     */
    success_node_namespaces?: string[]
  }
}

export type ExecutionOutcome = 'successful' | 'completed' | 'failed'

export interface WorkflowDef {
  nodes: NodeDef[]
  edges: EdgeDef[]
  trigger: TriggerDef
}

export interface SavedTestPayload {
  name: string
  payload: unknown
}

export interface Workflow {
  id: string
  name: string
  description?: string | null
  is_active: boolean
  definition: WorkflowDef
  slack_channel?: string | null
  test_payloads: SavedTestPayload[]
  created_at: string
  updated_at: string
  updated_by_email?: string | null
  updated_by_name?: string | null
}

export interface WorkflowSummary {
  id: string
  name: string
  description?: string | null
  is_active: boolean
  created_at: string
  updated_at: string
  updated_by_email?: string | null
  updated_by_name?: string | null
}

export interface WorkflowVersion {
  id: string
  version_number: number
  message?: string | null
  created_at: string
  created_by: string
}

export interface EnvVar {
  id: string
  key: string
  value: string | null
  is_secret: boolean
  scope: string
  workflow_id?: string | null
  updated_at: string
  updated_by_email?: string | null
}

// Execution step data injected into node.data during replay mode
export interface ExecutionStep {
  status: 'completed' | 'failed' | 'skipped' | 'running' | 'failed_with_fallback'
  input: unknown
  output: unknown
  error_message: string | null
  error_type: string | null
  duration_ms: number
  retries_used: number
}

// What we store in React Flow node.data
export interface CanvasNodeData {
  namespace: string
  label?: string
  config: Record<string, unknown>
  variables: Record<string, string>
  // undefined = normal edit mode; null = replay mode but step not reached; object = step ran
  executionStep?: ExecutionStep | null
  // true = node is attached and missing required config; shown as amber ring in edit mode
  hasError?: boolean
  // false = not reachable from the trigger via edges; dimmed on the canvas.
  // undefined/true = part of the live flow. Canvas-only bookkeeping.
  isReachable?: boolean
  // Set when the user drags a disconnected node to a specific spot. While
  // true, layoutWorkflow preserves the node's current position instead of
  // running dagre on it. Cleared automatically when the node becomes
  // reachable from the trigger again.
  manualPosition?: boolean
  // true when this node's namespace is in the trigger's success_node_namespaces.
  // Drives the trophy-style badge on the canvas. Canvas-only bookkeeping.
  isSuccessNode?: boolean
  // For parallel start/end pairs: the React Flow ID of the other half of the pair.
  // Not serialized to the workflow definition — canvas-only bookkeeping.
  _pairId?: string
}
