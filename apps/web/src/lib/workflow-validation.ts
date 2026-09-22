import type { Node, Edge } from '@xyflow/react'
import type { CanvasNodeData, NodeDef, EdgeDef } from '@/types/workflow'
import { assertNever, isNodeType } from '@/types/workflow'
import { normalizeHandle } from './auto-connect'
import { filterHasCondition } from './filter-condition'

export interface ValidationError {
  nodeId: string
  namespace: string
  label?: string
  message: string
}

function validateNodeConfig(type: string, config: Record<string, unknown>): string | null {
  // The trigger is a canvas node, not a saved node type, and always valid. A
  // spelling this build does not know is the engine's to refuse, not the form's.
  if (!isNodeType(type)) return null
  // Exhaustive over NodeType (#1411): a type added to @bidspoke/node-types with
  // no case here is a type error at assertNever, so save time validation can
  // no longer silently wave a new node type through.
  switch (type) {
    case 'filter': {
      // Both shapes the engine evaluates count as configured. Checking only
      // config.condition flagged a live rule-builder filter as unconfigured,
      // which also blocked saving the workflow (#645).
      if (!filterHasCondition(config)) return 'No condition field set'
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
    case 'response':
    case 'exit':
    case 'branch_end':
    case 'parallel_end':
    case 'constants':
    case 'salesforce':
    case 'data_store':
      // Always valid at save time: the terminal and structural nodes have no
      // required config, and the others have working defaults.
      return null
    case 'bid_group':
      // Not asserted at save time today: a group with no partners saves, and the
      // engine reports no_winner at run time. Kept as it shipped (behaviour
      // neutral, #1411); listed so the omission is a decision on the record.
      return null
    default:
      return assertNever(type, 'node type')
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

// Two outgoing edges on the SAME handle is always corrupt (#567). The engine
// routes by source_handle and follows the first matching edge it finds, so the
// other target is silently skipped at run time while the canvas still draws
// both. A legacy null handle counts as the default 'output' handle, which is
// how the fork arises: a stale handle-less edge survives and a fresh 'output'
// edge gets appended beside it.
//
// Legitimate fan-out (branch arms, parallel child slots, filter pass/exit, a
// branch's hidden backbone edge) always uses DISTINCT handles, so it never trips
// this.
export function findDuplicateOutEdges(nodes: Node[], edges: Edge[]): Map<string, ValidationError> {
  // source + handle → the distinct targets it points at. Two edges on one handle
  // that share a target are mere redundancy (dedupeEdges normalizes those away);
  // only DIFFERENT targets constitute a fork where one silently never runs.
  const targetsByOutput = new Map<string, Set<string>>()
  const offenders = new Set<string>()

  for (const e of edges) {
    const key = `${e.source} ${normalizeHandle(e.sourceHandle)}`
    const targets = targetsByOutput.get(key) ?? new Set<string>()
    targets.add(e.target)
    targetsByOutput.set(key, targets)
    if (targets.size > 1) offenders.add(e.source)
  }

  const errors = new Map<string, ValidationError>()
  for (const id of offenders) {
    const node = nodes.find((n) => n.id === id)
    if (!node) continue
    const data = node.data as unknown as CanvasNodeData
    errors.set(id, {
      nodeId: id,
      namespace: data?.namespace ?? id,
      label: data?.label,
      message: 'Has two outgoing edges on one output. Only one will run. Delete the stale edge.',
    })
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
