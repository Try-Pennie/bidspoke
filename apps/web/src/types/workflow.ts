/**
 * Every node type a saved definition may contain, as a runtime list, so the
 * canvas registry and the colour map can be checked at test time to cover all of
 * them: a type with no card renders as a broken node and can take the canvas
 * down (see nodes/registry.tsx).
 *
 * The list itself lives in @bidspoke/node-types (#1411), one array the worker
 * reads too, so the two apps cannot drift. Re-exported here so every existing
 * import from '@/types/workflow' keeps working.
 *
 * `partner_bid` is retired but still listed: Bid Group replaced it and it is
 * hidden from the palette, yet the engine still executes the type and the format
 * still permits it, so it must still draw.
 */
export { NODE_TYPES, NODE_TRAITS, assertNever, isNodeType } from '@bidspoke/node-types'
export type { NodeType, NodeTraits } from '@bidspoke/node-types'
import type { NodeType } from '@bidspoke/node-types'
import type { ConditionOperator } from '@bidspoke/workflow-definition'

export interface EdgeCondition {
  field: string
  // The one operator list both apps read (#2588): packages/workflow-definition.
  operator: ConditionOperator
  value?: unknown
}

export interface ConditionGroup {
  conditions: EdgeCondition[]
  logic: 'AND' | 'OR'
}

export interface ParallelChildSlot {
  id: string // stable handle id, e.g. 'child-0' — referenced by edges, never changes
  label: string // user-editable display name shown on the canvas and in logs
}

export interface NodeDef {
  id: string
  namespace: string
  label?: string
  // Free-form per-step annotation. Surfaced as a small icon on the canvas.
  note?: string
  type: NodeType
  position?: { x: number; y: number }
  config: Record<string, unknown>
  variables?: Record<string, string>
  /**
   * @deprecated Old parallel node child-id array. Definitions created on or after
   * 2026-04-30 store slot metadata at `config.children` as `ParallelChildSlot[]`
   * and resolve actual child node ids from edges. Loader migrates old shape on load.
   */
  children?: string[]
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
  // Render-only: hidden backbone edges (branch/parallel start → paired _end).
  // Persisted so they stay hidden across save → reload; the engine ignores it.
  hidden?: boolean
}

// A known failure signal whose per-run Slack page is muted; one aggregated page
// fires instead when matching failures cross a rate threshold (#248). Mirrors the
// worker's MutedFailureSignal.
export interface MutedFailureSignal {
  match: string
  count: number
  window_minutes: number
  cooldown_minutes?: number
}

export interface TriggerDef {
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
    /**
     * Node namespaces that count as "successful" when the walk ends on one
     * of them. Empty or missing = no runs are marked Successful; everything
     * non-failed goes to Completed.
     */
    success_node_namespaces?: string[]
    /** Failure signals whose per-run page is muted in favor of a rate alert (#248). */
    muted_failure_signals?: MutedFailureSignal[]
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
  folder_id?: string | null
  created_at: string
  updated_at: string
  updated_by_email?: string | null
  updated_by_name?: string | null
}

export interface Folder {
  id: string
  organization_id: string
  parent_id: string | null
  name: string
  created_at: string
  updated_at: string
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
  folder_id?: string | null
  updated_at: string
  updated_by_email?: string | null
}

export interface EnvVarFolder {
  id: string
  organization_id: string
  parent_id: string | null
  name: string
  created_at: string
  updated_at: string
}

/**
 * Resolved step input shape written by the engine — see worker
 * src/types.ts::ResolvedStepInput. Legacy rows may still hold a bare value or
 * null; UI renders both cases.
 */
export interface ResolvedStepInput {
  template: unknown
  resolved: unknown
}

// Execution step data injected into node.data during replay mode
export interface ExecutionStep {
  // Step row id; needed by the canvas to lazy-fetch input/output detail.
  step_id?: string
  status: 'completed' | 'failed' | 'skipped' | 'running' | 'failed_with_fallback'
  /**
   * Resolved input — new rows: `{ template, resolved }` shape; legacy rows:
   * partner_bid attempts ({ partner_id }) or null. The Results panel handles
   * all three by feature-detecting the {template, resolved} shape.
   */
  input: ResolvedStepInput | unknown
  output: unknown
  logs?: Array<{ level: string; message: string; ts: string }> | null
  error_message: string | null
  error_type: string | null
  duration_ms: number
  retries_used: number
  /**
   * The exit a routing node chose (`output._route`), carried in the execution
   * summary so the canvas can light the path taken without the full output
   * (#1503). Absent for nodes that do not route.
   */
  route?: string | null
  // false until the canvas lazy-loads input/output/logs for this step.
  detail_loaded?: boolean
}

// What we store in React Flow node.data
export interface CanvasNodeData {
  namespace: string
  label?: string
  // Free-form per-step annotation. Surfaced as a small icon on the canvas.
  note?: string
  config: Record<string, unknown>
  variables: Record<string, string>
  // undefined = normal edit mode; null = replay mode but step not reached; object = step ran
  executionStep?: ExecutionStep | null
  // true = node is attached and missing required config; shown as amber ring in edit mode
  hasError?: boolean
  // Why the node is flagged, e.g. 'No script written'. Surfaced as the
  // ConfigWarningBadge tooltip so the reason is readable without opening the
  // node (#563). Set alongside hasError from the validation pass.
  errorMessage?: string
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
