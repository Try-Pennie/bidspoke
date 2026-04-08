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
      const branches = config.branches as unknown[] | undefined
      if (!branches?.length) return 'No branches defined'
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
    case 'partner_bid': {
      if (!config.partner_id) return 'No partner selected'
      return null
    }
    case 'bid_evaluation': {
      if (!config.parallel_source) return 'No bids source step selected'
      return null
    }
    case 'code': {
      if (!config.script) return 'No script written'
      return null
    }
    // response, exit, parallel, trigger — always valid
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
