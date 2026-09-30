import type { Node, Edge } from '@xyflow/react'
import type { CanvasNodeData, NodeDef, EdgeDef } from '@/types/workflow'
import { NODE_TRAITS, assertNever, isNodeType } from '@/types/workflow'
import { normalizeHandle } from './auto-connect'
import { filterHasCondition } from './filter-condition'
import { alertOverPercentOf, partnerIdOf, POPULATIONS } from '@bidspoke/buyer-profile'

export interface ValidationError {
  nodeId: string
  namespace: string
  label?: string
  message: string
}

/** A template field is set when it is a string with something other than spaces in it. */
const templateSet = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''

/**
 * The click nodes' buyer (#1543): blank is unconfigured, and anything else the
 * executor's own rule refuses (a slug, a padded fragment) is refused here too,
 * because the node would fail on every run with it.
 */
function clickPartnerProblem(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return 'No partner selected'
  if (!partnerIdOf(value).ok) return 'The partner is not a partner id; pick the buyer again'
  return null
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
    case 'buyer_select': {
      // The fields the node cannot decide without (#1411). This is what blocks
      // saving an unconfigured live workflow. Mode is checked as a member of the
      // vocabulary, not as presence, so an unknown mode is unconfigured (L72).
      const mode = config.mode
      if (mode !== 'decide_only' && mode !== 'live') return 'No mode set (decide only or live)'
      if (!(config.population as string | undefined)?.trim()) return 'No population selected'
      if (!(config.lead_key as string | undefined)?.trim()) return 'No lead key template set'
      if (!(config.sell_off_when as string | undefined)?.trim()) return 'No sell off condition set'
      const payload = config.sale_payload as { base?: unknown } | undefined
      if (typeof payload?.base !== 'string' || !payload.base.trim()) return 'No sale payload base set'
      return null
    }
    case 'buyer_click_send': {
      // Everything the node needs before it may claim a click (#1542). Where the
      // click goes and which reply counts as sold are the buyer profile's click
      // delivery (#1671), checked when the profile is saved, so nothing here reads
      // a request_url or success_pattern a node saved before then still holds.
      const partnerProblem = clickPartnerProblem(config.partner_id)
      if (partnerProblem) return partnerProblem
      if (!(config.prospect_id as string | undefined)?.trim()) return 'No prospect id template set'
      if (!(config.request_body as string | undefined)?.trim()) return 'No request body template set'
      // No cap on the node (#1543, L83): the over cap notice reads the buyer profile's.
      // The executor's own rule (#1553): a value it refuses fails every run, so it is refused here first.
      if (!alertOverPercentOf(config.alert_over_percent).ok) return 'The notify percent must be a whole number from 1 to 1000'
      return null
    }
    case 'buyer_click_check': {
      // Everything the node needs to decide (#1543). A missing lead template would
      // make every lead missing_lead_field, so it is refused rather than saved.
      const partnerProblem = clickPartnerProblem(config.partner_id)
      if (partnerProblem) return partnerProblem
      if (!templateSet(config.state)) return 'No state template set'
      if (!templateSet(config.debt)) return 'No debt template set'
      if (!templateSet(config.loan_amount)) return 'No loan amount template set'
      if (config.population === undefined || config.population === null || config.population === '') return 'No population selected'
      // A stored value outside the vocabulary is named as such, never as nothing chosen (#1557).
      if (!(POPULATIONS as readonly unknown[]).includes(config.population)) return `${String(config.population)} is not a population Bidspoke knows`
      return null
    }
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

/**
 * The outgoing handles a buyer_select node can route to, given its config
 * (#1411). sold, no_sale and not_applicable always; deferred whenever the node
 * can defer, which is decide only mode and any live share variable.
 */
export function buyerSelectRequiredHandles(config: Record<string, unknown>): string[] {
  // Every exit in the node's own list (#1582), so a new outcome is required
  // until someone decides otherwise; only deferred depends on the config.
  const livePercentEnv = config.live_percent_env
  const canDefer = config.mode === 'decide_only' || (typeof livePercentEnv === 'string' && livePercentEnv.trim() !== '')
  return (NODE_TRAITS.buyer_select.staticHandles ?? []).filter((h) => h !== 'deferred' || canDefer)
}

/**
 * The handles a walker node that routes by name must have wired, or null for a
 * type with no such rule. buyer_click_send (#1542) and buyer_click_check
 * (#1543) can take every one of their handles at run time, so all of them are
 * required; the list is the trait's.
 */
function requiredHandles(node: NodeDef): string[] | null {
  if (node.type === 'buyer_select') return buyerSelectRequiredHandles(node.config ?? {})
  if (node.type === 'buyer_click_send') return [...(NODE_TRAITS.buyer_click_send.staticHandles ?? [])]
  if (node.type === 'buyer_click_check') return [...(NODE_TRAITS.buyer_click_check.staticHandles ?? [])]
  return null
}

/**
 * Attached buyer_select, buyer_click_send and buyer_click_check nodes with a required outgoing
 * handle no edge leaves from. At run time an unwired handle the node needs to
 * take is a named step failure in every mode, so a live workflow must not save
 * with one (L72).
 */
export function findUnwiredRequiredHandles(nodes: NodeDef[], edges: EdgeDef[]): Map<string, ValidationError> {
  const errors = new Map<string, ValidationError>()
  for (const node of nodes) {
    const required = requiredHandles(node)
    if (!required) continue
    const attached = edges.some((e) => e.source === node.id || e.target === node.id)
    if (!attached) continue
    const wired = new Set(edges.filter((e) => e.source === node.id).map((e) => normalizeHandle(e.source_handle)))
    const missing = required.filter((h) => !wired.has(h))
    if (missing.length === 0) continue
    errors.set(node.id, {
      nodeId: node.id,
      namespace: node.namespace,
      label: node.label,
      message: `Outgoing handle not wired: ${missing.join(', ')}`,
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
