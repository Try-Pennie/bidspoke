import type { Node, Edge } from '@xyflow/react'
import type { CanvasNodeData, NodeDef, EdgeDef } from '@/types/workflow'

export interface ValidationError {
  nodeId: string
  namespace: string
  label?: string
  message: string
}

function validateNodeConfig(type: string, config: Record<string, unknown>): string | null {
  switch (type) {
    case 'filter': {
      const condition = config.condition as { field?: string } | undefined
      if (!condition?.field?.trim()) return 'No condition field set'
      return null
    }
    case 'branch': {
      const branches = config.branches as
        | Array<{ condition?: { groups?: Array<{ conditions?: Array<{ field?: string }> }> } }>
        | undefined
      if (!branches?.length) return 'No branches defined'
      // An arm with no field-bearing condition matches every lead in the engine
      // (empty AND group), so a fresh/cleared arm is unconfigured, not valid (#93).
      const hasEmptyArm = branches.some((b) => {
        const conditions = (b.condition?.groups ?? []).flatMap((g) => g.conditions ?? [])
        return !conditions.some((c) => c.field?.trim())
      })
      if (hasEmptyArm) return 'A branch arm has no conditions set'
      return null
    }
    case 'webhook': {
      // Webhook node — canvas type is 'webhook'
      const url = config.url as string | undefined
      if (!url?.trim()) return 'No URL configured'
      return null
    }
    case 'transform': {
      const mappings = config.mappings as Array<{ source?: string; target?: string }> | undefined
      if (!mappings?.length) return 'No field mappings defined'
      if (mappings.some((m) => !m.source?.trim() || !m.target?.trim())) return 'Some mappings are incomplete'
      return null
    }
    case 'parallel': {
      const slots = config.children as Array<{ id: string; label: string }> | string[] | undefined
      if (!slots?.length) return 'No slots defined'
      return null
    }
    case 'partner_bid': {
      if (!config.partner_id) return 'No partner selected'
      return null
    }
    case 'code': {
      if (!config.script) return 'No script written'
      return null
    }
    case 'latency_gate': {
      const correlationKey = config.correlation_key as string | undefined
      if (!correlationKey?.trim()) return 'No correlation key set'
      const operation = (config.operation as string | undefined) ?? 'mark'
      if (operation === 'check' && !config.partner_id && config.threshold_ms === undefined) {
        return 'No threshold partner or override set'
      }
      return null
    }
    case 'achieve_offers':
      // Nothing to configure: Achieve drives product selection on their side, and every
      // other field has a working default.
      return null
    // response, exit, trigger — always valid
    default:
      return null
  }
}

/** Returns a Map of nodeId → ValidationError for all attached, unconfigured nodes. */
export function validateWorkflow(nodes: Node[], edges: Edge[]): Map<string, ValidationError> {
  const errors = new Map<string, ValidationError>()
  for (const node of nodes) {
    if (node.type === 'trigger') continue
    const attached = edges.some((e) => e.source === node.id || e.target === node.id)
    if (!attached) continue
    const data = node.data as unknown as CanvasNodeData
    const message = validateNodeConfig(node.type ?? '', data.config ?? {})
    if (message) {
      errors.set(node.id, {
        nodeId: node.id,
        namespace: data.namespace,
        label: data.label,
        message,
      })
    }
  }
  return errors
}

// Detect a directed cycle in the graph (#334). Returns the looping node
// namespaces (back-edge target repeated at both ends, e.g.
// ['enrich','score','enrich']) or null when acyclic. Mirrors the worker's
// detectCycle so a cyclic workflow is flagged in the editor at save time with a
// clean message, before the authoritative server-side reject. All edges are
// directed source→target; the `trigger` pseudo-source never sits on a cycle.
export function findWorkflowCycle(nodes: Node[], edges: Edge[]): string[] | null {
  const labelById = new Map(nodes.map((n) => [n.id, (n.data as unknown as CanvasNodeData)?.namespace ?? n.id]))
  const label = (id: string) => labelById.get(id) ?? id

  const adjacency = new Map<string, string[]>()
  for (const e of edges) {
    const list = adjacency.get(e.source)
    if (list) list.push(e.target)
    else adjacency.set(e.source, [e.target])
  }

  const state = new Map<string, 'gray' | 'black'>()
  const pathStack: string[] = []
  let cycle: string[] | null = null

  const visit = (u: string): boolean => {
    state.set(u, 'gray')
    pathStack.push(u)
    for (const v of adjacency.get(u) ?? []) {
      const vs = state.get(v)
      if (vs === 'gray') {
        const start = pathStack.indexOf(v)
        cycle = [...pathStack.slice(start).map(label), label(v)]
        return true
      }
      if (vs === undefined && visit(v)) return true
    }
    pathStack.pop()
    state.set(u, 'black')
    return false
  }

  for (const n of nodes) {
    if (state.get(n.id) === undefined && visit(n.id)) return cycle
  }
  return null
}

/** Same logic but works on the raw definition types (no React Flow dependency). */
export function validateWorkflowDef(nodes: NodeDef[], edges: EdgeDef[]): ValidationError[] {
  const errors: ValidationError[] = []
  for (const node of nodes) {
    const attached = edges.some((e) => e.source === node.id || e.target === node.id)
    if (!attached) continue
    const message = validateNodeConfig(node.type, node.config ?? {})
    if (message) {
      errors.push({
        nodeId: node.id,
        namespace: node.namespace,
        label: node.label,
        message,
      })
    }
  }
  return errors
}
