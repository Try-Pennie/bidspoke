export type NodeType =
  | 'filter'
  | 'branch'
  | 'code'
  | 'response'
  | 'exit'
  | 'parallel'
  | 'partner_bid'
  | 'integration'
  | 'transform'
  | 'bid_evaluation'

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
  type: NodeType
  position?: { x: number; y: number }
  config: Record<string, unknown>
  variables?: Record<string, string>
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
  }
}

export interface WorkflowDef {
  nodes: NodeDef[]
  edges: EdgeDef[]
  trigger: TriggerDef
}

export interface Workflow {
  id: string
  name: string
  description?: string | null
  is_active: boolean
  definition: WorkflowDef
  created_at: string
  updated_at: string
  updated_by_email?: string | null
}

export interface WorkflowSummary {
  id: string
  name: string
  description?: string | null
  is_active: boolean
  created_at: string
  updated_at: string
  updated_by_email?: string | null
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

// What we store in React Flow node.data
export interface CanvasNodeData {
  namespace: string
  config: Record<string, unknown>
  variables: Record<string, string>
}
