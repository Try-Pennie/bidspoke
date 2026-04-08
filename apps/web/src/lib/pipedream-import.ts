/**
 * Pipedream workflow JSON → Bidspoke WorkflowDef converter
 * PRD Section 7
 */

import type { NodeDef, EdgeDef, WorkflowDef, EdgeCondition, ConditionGroup } from '@/types/workflow'

// ── Pipedream shape types ─────────────────────────────────────────────────────

interface PdRule {
  key: string
  operator: string
  value?: unknown
}

interface PdRuleGroup {
  operatorGroup?: 'AND' | 'OR'
  rules?: PdRule[]
}

interface PdFilter {
  type?: string
  ruleGroup?: PdRuleGroup
}

interface PdIfElseCondition {
  label?: string
  expression?: PdRuleGroup
  // sometimes nested directly
  operatorGroup?: 'AND' | 'OR'
  rules?: PdRule[]
}

interface PdControlFlow {
  type?: string
  conditions?: PdIfElseCondition[]
}

interface PdConfigurableProp {
  name: string
  type?: string
  label?: string
  default?: unknown
}

interface PdSavedComponent {
  key?: string
  name?: string
  code?: string
  apps?: Array<{ name_slug?: string; app?: string }>
  configurableProps?: PdConfigurableProp[]
}

interface PdStep {
  id?: string
  namespace?: string
  type?: string        // "trigger" | "action" | "filter" | etc.
  name?: string
  code?: string        // sometimes code is directly on the step
  savedComponent?: PdSavedComponent
  configured_props?: Record<string, unknown>
  _filter?: PdFilter | null
  _controlFlow?: PdControlFlow | null
}

interface PdWorkflow {
  id?: string
  name?: string
  active?: boolean
  // Most common shape: top-level steps array
  steps?: PdStep[]
  // Alternate shape: components object
  components?: {
    triggers?: PdStep[]
    actions?: PdStep[]
  }
}

// ── Import result ─────────────────────────────────────────────────────────────

export interface ImportResult {
  name: string
  def: WorkflowDef
  warnings: string[]
}

// ── Operator mapping ──────────────────────────────────────────────────────────

type BidEdgeOp = EdgeCondition['operator']

const OPERATOR_MAP: Record<string, BidEdgeOp> = {
  // equality
  eq: 'eq',
  equals: 'eq',
  equal: 'eq',
  '==': 'eq',
  neq: 'neq',
  not_equals: 'neq',
  not_equal: 'neq',
  '!=': 'neq',
  // comparison
  gt: 'gt',
  greater_than: 'gt',
  '>': 'gt',
  gte: 'gte',
  greater_than_or_equal: 'gte',
  '>=': 'gte',
  lt: 'lt',
  less_than: 'lt',
  '<': 'lt',
  lte: 'lte',
  less_than_or_equal: 'lte',
  '<=': 'lte',
  // string
  contains: 'contains',
  contains_str: 'contains',
  str_contains: 'contains',
  not_contains: 'not_contains',
  not_contains_str: 'not_contains',
  str_not_contains: 'not_contains',
  // existence
  is_blank: 'not_exists',
  is_empty: 'not_exists',
  blank: 'not_exists',
  empty: 'not_exists',
  is_not_blank: 'exists',
  not_blank: 'exists',
  is_not_empty: 'exists',
  not_empty: 'exists',
  exists: 'exists',
  not_exists: 'not_exists',
  is_null: 'not_exists',
  is_not_null: 'exists',
}

const APPROXIMATE_OPS = new Set(['starts_with', 'ends_with', 'regex', 'matches'])

// ── Field path translation ────────────────────────────────────────────────────

function translateField(key: string): { field: string; warn?: string } {
  // steps.trigger.event.body.X → trigger.payload.X
  const triggerBody = /^steps\.trigger\.event\.body\.?(.*)$/.exec(key)
  if (triggerBody) return { field: triggerBody[1] ? `trigger.payload.${triggerBody[1]}` : 'trigger.payload' }

  // steps.trigger.event.X → trigger.payload.X
  const triggerEvent = /^steps\.trigger\.event\.?(.*)$/.exec(key)
  if (triggerEvent) return { field: triggerEvent[1] ? `trigger.payload.${triggerEvent[1]}` : 'trigger.payload' }

  // steps.NAMESPACE.$return_value.X → steps.NAMESPACE.X
  const returnVal = /^steps\.([^.]+)\.\$return_value\.?(.*)$/.exec(key)
  if (returnVal) return { field: returnVal[2] ? `steps.${returnVal[1]}.${returnVal[2]}` : `steps.${returnVal[1]}` }

  // steps.NAMESPACE.output.X or steps.NAMESPACE.X (pass through)
  const stepsRef = /^steps\.(.+)$/.exec(key)
  if (stepsRef) return { field: `steps.${stepsRef[1]}` }

  // process.env.VAR → env.VAR
  const envRef = /^process\.env\.(.+)$/.exec(key)
  if (envRef) return { field: `env.${envRef[1]}` }

  // Bare field — pass through
  return { field: key, warn: key.includes('.') ? undefined : `Field "${key}" may need a prefix (e.g. trigger.payload.${key})` }
}

// ── Rule group → ConditionGroup[] ────────────────────────────────────────────

function parseRuleGroup(rg: PdRuleGroup, warnings: string[]): { groups: ConditionGroup[]; logic: 'AND' | 'OR' } {
  const rules = rg.rules ?? []
  const topLogic: 'AND' | 'OR' = rg.operatorGroup === 'OR' ? 'OR' : 'AND'

  const conditions: EdgeCondition[] = rules.map((r) => {
    const { field, warn } = translateField(r.key ?? '')
    if (warn) warnings.push(warn)

    const pdOp = (r.operator ?? '').toLowerCase().replace(/ /g, '_')
    let operator: BidEdgeOp = OPERATOR_MAP[pdOp]

    if (!operator) {
      if (APPROXIMATE_OPS.has(pdOp)) {
        warnings.push(`Operator "${r.operator}" has no exact match — mapped to "contains". Review rule on field "${field}".`)
        operator = 'contains'
      } else {
        warnings.push(`Unknown operator "${r.operator}" on field "${field}" — defaulted to "eq".`)
        operator = 'eq'
      }
    }

    const isValueLess = operator === 'exists' || operator === 'not_exists'
    return { field, operator, value: isValueLess ? undefined : r.value }
  })

  return {
    groups: [{ conditions, logic: topLogic }],
    logic: topLogic,
  }
}

// ── Code translation ──────────────────────────────────────────────────────────

function translateCode(code: string): string {
  return code
    // Remove @pipedream/platform imports
    .replace(/import\s*\{[^}]*axios[^}]*\}\s*from\s*["']@pipedream\/platform["'];?/g, '// Uses native fetch')
    .replace(/import\s*\{[^}]*\}\s*from\s*["']@pipedream\/platform["'];?/g, '// @pipedream/platform removed')
    // Translate data refs
    .replace(/steps\.trigger\.event\.body/g, 'trigger.payload')
    .replace(/steps\.trigger\.event/g, 'trigger.payload')
    .replace(/steps\.trigger\.context\.trace_id/g, 'execution.trace_id')
    .replace(/steps\.([^.]+)\.\$return_value/g, 'steps.$1')
    // Env vars
    .replace(/process\.env\.(\w+)/g, 'env.$1')
    // `this.prop` → `config.prop`
    .replace(/\bthis\.(\w+)\b/g, 'config.$1')
    // $.export("$summary", msg) → console.log(msg)
    .replace(/\$\.export\(['"]?\$summary['"]?,\s*/g, 'console.log(')
    // $.export("fieldName", val) → // exported: fieldName = val (rough note)
    .replace(/\$\.export\(['"]?([^'"]+)['"]?,\s*([^)]+)\)/g, '/* exported $1: */ $2')
    // $.flow.exit(reason) → return { exit: true, reason }
    .replace(/await\s+\$\.flow\.exit\(([^)]*)\)/g, 'return { exit: true, reason: $1 }')
    .replace(/\$\.flow\.exit\(([^)]*)\)/g, 'return { exit: true, reason: $1 }')
    // $.respond({ ... }) → return { response: { ... } }
    .replace(/await\s+\$\.respond\((\{(?:[^{}]|\{[^{}]*\})*\})\)/g, 'return { response: $1 }')
    .replace(/\$\.respond\((\{(?:[^{}]|\{[^{}]*\})*\})\)/g, 'return { response: $1 }')
    // axios($, config) → await fetch(url, config) (rough)
    .replace(/\baxios\(\$,\s*/g, 'await fetch(')
}

// ── Auto-layout ───────────────────────────────────────────────────────────────

const STEP_X = 250
const STEP_Y_START = 80
const STEP_Y_GAP = 160

function autoLayout(nodes: NodeDef[]): NodeDef[] {
  return nodes.map((n, i) => ({
    ...n,
    position: n.position ?? { x: STEP_X, y: STEP_Y_START + i * STEP_Y_GAP },
  }))
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parsePipedreamExport(raw: string): ImportResult {
  const warnings: string[] = []
  let pd: PdWorkflow

  try {
    pd = JSON.parse(raw) as PdWorkflow
  } catch {
    throw new Error('Invalid JSON — paste the raw export from Pipedream.')
  }

  // Normalise steps array
  let steps: PdStep[] = []
  if (Array.isArray(pd.steps) && pd.steps.length > 0) {
    steps = pd.steps
  } else if (pd.components) {
    const triggers = pd.components.triggers ?? []
    const actions = pd.components.actions ?? []
    steps = [...triggers, ...actions]
  }

  if (steps.length === 0) {
    throw new Error('No steps found in this Pipedream export. Expected a "steps" array or "components.triggers/actions".')
  }

  const nodes: NodeDef[] = []
  const edges: EdgeDef[] = []
  let stepIndex = 0

  // Track the "previous" node id for sequential edge creation
  // For branch nodes, we track per-branch targets
  const edgePending: Array<{ sourceId: string; sourceHandle?: string; label?: string }> = []

  function flushEdge(targetId: string) {
    for (const e of edgePending) {
      edges.push({
        id: `e_${e.sourceId}_${targetId}`,
        source: e.sourceId,
        source_handle: e.sourceHandle,
        target: targetId,
      })
    }
    edgePending.length = 0
  }

  for (const step of steps) {
    const namespace = step.namespace ?? `step_${stepIndex}`
    const nodeId = `n_${namespace}`
    stepIndex++

    // ── Trigger ──────────────────────────────────────────────────────────────
    if (step.type === 'trigger' || namespace === 'trigger') {
      // Don't create a node for the trigger itself — it becomes the trigger config
      edgePending.push({ sourceId: 'trigger' })
      continue
    }

    // ── Filter node ──────────────────────────────────────────────────────────
    if (step._filter && step._filter.type === 'evalRuleGroup' && step._filter.ruleGroup) {
      const { groups, logic } = parseRuleGroup(step._filter.ruleGroup, warnings)
      flushEdge(nodeId)
      nodes.push({
        id: nodeId,
        namespace,
        type: 'filter',
        config: { rules: { groups, logic } },
      })
      // Filter has a pass edge (continues) and an implicit exit edge
      edgePending.push({ sourceId: nodeId, sourceHandle: 'pass' })
      continue
    }

    // ── Branch node ──────────────────────────────────────────────────────────
    if (step._controlFlow && step._controlFlow.type === 'ifelse') {
      const cf = step._controlFlow
      const branchDefs = (cf.conditions ?? []).map((cond) => {
        const rg: PdRuleGroup = cond.expression ?? {
          operatorGroup: cond.operatorGroup,
          rules: cond.rules,
        }
        const { groups, logic } = parseRuleGroup(rg, warnings)
        return {
          label: cond.label ?? 'branch',
          condition: { groups, logic },
        }
      })

      flushEdge(nodeId)
      nodes.push({
        id: nodeId,
        namespace,
        type: 'branch',
        config: { branches: branchDefs },
      })
      // Branch produces one pending edge per branch + else
      for (const b of branchDefs) {
        edgePending.push({ sourceId: nodeId, sourceHandle: b.label, label: b.label })
      }
      edgePending.push({ sourceId: nodeId, sourceHandle: 'else', label: 'else' })
      continue
    }

    // ── Code node ────────────────────────────────────────────────────────────
    const rawCode = step.savedComponent?.code ?? step.code ?? ''
    const translatedCode = rawCode ? translateCode(rawCode) : ''

    const configuredProps = step.configured_props ?? {}
    const variables: Record<string, string> = {}
    for (const [k, v] of Object.entries(configuredProps)) {
      if (typeof v === 'string') variables[k] = v
    }

    const apps = step.savedComponent?.apps ?? []
    const hasApp = apps.length > 0
    if (hasApp) {
      const appNames = apps.map((a) => a.name_slug ?? a.app ?? 'unknown').join(', ')
      warnings.push(`Step "${namespace}" uses app integration(s): ${appNames}. Mapped to a code node — consider a Webhook node when Phase 2 is ready.`)
    }

    if (!translatedCode) {
      warnings.push(`Step "${namespace}" has no code. A placeholder code node was created.`)
    } else if (rawCode !== translatedCode) {
      warnings.push(`Step "${namespace}" code was translated (Pipedream APIs replaced). Review before deploying.`)
    }

    flushEdge(nodeId)
    nodes.push({
      id: nodeId,
      namespace,
      type: 'code',
      config: {
        script: translatedCode ?? '',
      },
      variables: Object.keys(variables).length > 0 ? variables : undefined,
    })
    if (translatedCode) {
      warnings.push(`Code node "${namespace}": review the imported script before running — automatic translation may need adjustments.`)
    }
    edgePending.push({ sourceId: nodeId })
  }

  // If there are still pending edges, they lead nowhere (last step in chain)
  // We can add a response node automatically or just leave them
  // For now we leave them — user can wire up

  if (nodes.length === 0) {
    throw new Error('No actionable steps found. This export may be a trigger-only workflow.')
  }

  const positioned = autoLayout(nodes)

  const def: WorkflowDef = {
    trigger: {
      type: 'http_webhook',
      config: { method: 'POST', auth_method: 'api_key' },
    },
    nodes: positioned,
    edges,
  }

  return {
    name: pd.name ?? 'Imported Workflow',
    def,
    warnings,
  }
}
