/**
 * validateDefinition (#1947): every rule a stored workflow definition is held
 * to, composed from the validators both apps already share, judged by the
 * rules in force at the definition's own schema stamp.
 *
 * Pure: it reads only its arguments. Every money lane definition write calls
 * it, report only (the Worker's lib/definition-report.ts, #1947 PR 3): it
 * logs what it would refuse and refuses nothing, so every live definition and
 * every saved version is measured against it before it refuses anything (L56,
 * L65). Nothing on the execution path calls it.
 *
 * Each rule says how it is enforced, matching what the canvas and the save
 * route do today:
 * - every_save: refused on any save, live or not (a loop, a step id used twice,
 *   a duplicate branch label, a malformed Salesforce option, a lead validation
 *   step inside a parallel block, a trigger nothing on the lane reads).
 * - live_save: refused only when the save makes or keeps the workflow live, so
 *   a switched off draft can be saved half built (unconfigured or mis-wired
 *   steps, as the canvas's liveSaveBlocker).
 * - advisory: shown, never refused (a reference to a step that does not run
 *   first, which the canvas marks on the node).
 * blockingProblems applies those to a save.
 */
import { NODE_TRAITS, isNodeType, nodeTypeRunsInLane, type WorkflowLane } from '@bidspoke/node-types'
import { appActionSaveProblems } from './app-action'
import { findBranchLabelConflicts } from './branch-validation'
import { findLeadValidationPlacementProblems, findLeadValidationProblems } from './lead-validation'
import { validateDefinitionReferences } from './reference-validation'
import { retrySaveProblems } from './retry'
import { findSalesforceConfigProblems } from './salesforce-write-options'
import { DEFINITION_SCHEMA_VERSION, readSchemaStamp } from './schema-version'
import { validateTrigger } from './trigger'
import {
  findDuplicateOutEdges,
  findUnwiredRequiredHandles,
  findWorkflowCycle,
  validateWorkflowDef,
  type EdgeDefLike,
  type NodeDefLike,
  type ValidationError,
} from './workflow-validation'

export const DEFINITION_RULE_IDS = [
  'trigger',
  'namespace_unique',
  'node_type',
  'node_lane',
  'cycle',
  'branch_labels',
  'duplicate_out_edges',
  'node_config',
  'unwired_handles',
  'references',
  'salesforce_options',
  'lead_validation_placement',
  'lead_validation_config',
  'app_action',
  'connection_lane',
  'retry',
] as const
export type DefinitionRuleId = (typeof DEFINITION_RULE_IDS)[number]

export type DefinitionEnforcement = 'every_save' | 'live_save' | 'advisory'

/** What one rule found. */
export interface RuleFinding {
  /** A name a caller can switch on; the trigger's are TRIGGER_REFUSALS. */
  reason: string
  severity: 'error' | 'warning'
  message: string
  nodeId?: string
  namespace?: string
  /** A sub reason, where the finding carries one (a schedule's refusal). */
  detail?: string
}

export interface DefinitionProblem extends RuleFinding {
  /** definition_shape is the parse every rule depends on, outside the registry. */
  rule: DefinitionRuleId | 'definition_shape'
  enforce: DefinitionEnforcement
}

/** The definition as every rule reads it, once its shape has been checked. */
export interface ShapedDefinition {
  trigger: unknown
  /** The workflow's retry setting (#1693), read only by the ops run engine: retry.ts. */
  retry?: unknown
  nodes: NodeDefLike[]
  edges: EdgeDefLike[]
}

export interface DefinitionRuleContext {
  lane: WorkflowLane
}

export interface DefinitionRule {
  id: DefinitionRuleId
  /** The schema version the rule took effect at. A definition stamped earlier is not judged by it. */
  since: number
  enforce: DefinitionEnforcement
  check(definition: ShapedDefinition, context: DefinitionRuleContext): RuleFinding[]
}

export interface ValidateDefinitionOptions {
  lane: WorkflowLane
  /** The row's stored definition_schema_version, exactly as read. Absent or null is an unstamped row. */
  schemaVersion?: unknown
}

/**
 * The outcome. A caller must handle all three: a stamp newer than this code
 * knows (a deploy where the writer is ahead) and a stamp that is not a version
 * are named, and carry no problems list, so neither can be mistaken for a
 * clean definition (L255).
 */
export type DefinitionVerdict =
  | { kind: 'judged'; schemaVersion: number; stamped: boolean; problems: DefinitionProblem[] }
  | { kind: 'unknown_schema_version'; stamp: number; known: number }
  | { kind: 'invalid_schema_version'; stamp: unknown }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const fromValidationError = (reason: string) => (e: ValidationError): RuleFinding => ({
  reason,
  severity: 'error',
  message: e.message,
  nodeId: e.nodeId,
  namespace: e.namespace,
})

/** Every rule, with the version it took effect at. A new rule takes effect at a new version, never an old one (L1010). */
export const DEFINITION_RULES: readonly DefinitionRule[] = [
  {
    id: 'trigger',
    since: 1,
    enforce: 'every_save',
    check: (d, { lane }) => validateTrigger(d.trigger, lane),
  },
  {
    // The engine keys step output and step logs by namespace, so two steps on
    // one id cannot be told apart. The canvas refuses it on every save.
    id: 'namespace_unique',
    since: 1,
    enforce: 'every_save',
    check: (d) => {
      const seen = new Map<string, string>()
      const findings: RuleFinding[] = []
      for (const n of d.nodes) {
        const first = seen.get(n.namespace)
        if (first === undefined) seen.set(n.namespace, n.id)
        else findings.push({ reason: 'namespace_duplicate', severity: 'error', message: `step id ${n.namespace} is used by more than one step`, nodeId: n.id, namespace: n.namespace })
      }
      return findings
    },
  },
  {
    id: 'node_type',
    since: 1,
    enforce: 'every_save',
    check: (d) =>
      d.nodes
        .filter((n) => !isNodeType(n.type))
        .map((n) => ({ reason: 'node_type_unknown', severity: 'error', message: `the step type ${n.type} is not one this build knows`, nodeId: n.id, namespace: n.namespace })),
  },
  {
    id: 'node_lane',
    since: 1,
    enforce: 'every_save',
    check: (d, { lane }) =>
      d.nodes.flatMap((n) =>
        isNodeType(n.type) && !nodeTypeRunsInLane(n.type, lane)
          ? [{ reason: 'node_not_on_lane', severity: 'error' as const, message: `a ${n.type} step is ${NODE_TRAITS[n.type].lane} only and cannot run on the ${lane} lane`, nodeId: n.id, namespace: n.namespace }]
          : [],
      ),
  },
  {
    id: 'cycle',
    since: 1,
    enforce: 'every_save',
    check: (d) => {
      const cycle = findWorkflowCycle(d.nodes, d.edges)
      return cycle ? [{ reason: 'cycle', severity: 'error', message: `the workflow has a loop: ${cycle.join(' to ')}` }] : []
    },
  },
  {
    id: 'branch_labels',
    since: 1,
    enforce: 'every_save',
    check: (d) =>
      findBranchLabelConflicts(d.nodes.map((n) => ({ type: n.type, data: { label: n.label, namespace: n.namespace, config: n.config as { branches?: { label: string }[] } } }))).map((c) => ({
        reason: 'branch_label_duplicate',
        severity: 'error',
        message: `branch ${c.node} has more than one arm labelled ${c.labels.map((l) => l || 'blank').join(', ')}`,
        namespace: c.node,
      })),
  },
  {
    id: 'duplicate_out_edges',
    since: 1,
    enforce: 'live_save',
    check: (d) => [
      ...findDuplicateOutEdges(
        d.nodes.map((n) => ({ id: n.id, type: n.type, data: { namespace: n.namespace, label: n.label } })),
        d.edges.map((e) => ({ source: e.source, target: e.target, sourceHandle: e.source_handle })),
      ).values(),
    ].map(fromValidationError('duplicate_out_edge')),
  },
  {
    id: 'node_config',
    since: 1,
    enforce: 'live_save',
    check: (d) => validateWorkflowDef(d.nodes, d.edges).map(fromValidationError('node_unconfigured')),
  },
  {
    id: 'unwired_handles',
    since: 1,
    enforce: 'live_save',
    check: (d) => [...findUnwiredRequiredHandles(d.nodes, d.edges).values()].map(fromValidationError('handle_unwired')),
  },
  {
    id: 'references',
    since: 1,
    enforce: 'advisory',
    check: (d) =>
      validateDefinitionReferences(d.nodes, d.edges).map((p) => ({
        reason: 'reference_not_upstream',
        severity: p.severity,
        message: p.message,
        nodeId: p.nodeId,
        namespace: p.namespace,
      })),
  },
  {
    id: 'salesforce_options',
    since: 1,
    enforce: 'every_save',
    check: (d) => findSalesforceConfigProblems(d.nodes).map(fromValidationError('salesforce_option_invalid')),
  },
  {
    id: 'lead_validation_placement',
    since: 1,
    enforce: 'every_save',
    check: (d) => findLeadValidationPlacementProblems(d.nodes, d.edges).map(fromValidationError('lead_validation_in_parallel')),
  },
  {
    id: 'lead_validation_config',
    since: 1,
    enforce: 'live_save',
    check: (d) => findLeadValidationProblems(d.nodes, d.edges).map(fromValidationError('lead_validation_invalid')),
  },
  {
    // An ops catalogue step (#2339): a version the catalogue does not have,
    // arguments that version would refuse, a connection that is not an id.
    // Since version 1, because no stored definition has ever held an app_action
    // step (measured on production, 2026-10-23: 0 of 56 workflows and 0 of 610
    // saved versions), so no row's meaning changes (L1013).
    id: 'app_action',
    since: 1,
    enforce: 'every_save',
    check: (d) =>
      d.nodes.flatMap((n) =>
        n.type === 'app_action'
          ? appActionSaveProblems(n.config ?? {}).map((p) => ({ reason: p.reason, severity: 'error' as const, message: `step ${n.namespace}: ${p.message}`, nodeId: n.id, namespace: n.namespace }))
          : [],
      ),
  },
  {
    // A second check beside node_lane (#2339): a connection is an ops login, so
    // a money step bound to one is refused, whatever its type. Since version 1:
    // no stored definition has ever held a connection field (0 of 610 saved
    // versions, measured 2026-10-23).
    id: 'connection_lane',
    since: 1,
    enforce: 'every_save',
    check: (d, { lane }) =>
      lane !== 'money'
        ? []
        : d.nodes.flatMap((n) =>
          n.config !== undefined && Object.hasOwn(n.config, 'connection') && n.config.connection !== null && n.config.connection !== undefined && n.config.connection !== ''
            ? [{ reason: 'connection_on_money_lane', severity: 'error' as const, message: `step ${n.namespace} is bound to a connection, which only an ops workflow may use`, nodeId: n.id, namespace: n.namespace }]
            : [],
        ),
  },
  {
    // An ops workflow's retry setting (#1693, Dan's decision of 2026-10-28):
    // a bad one, or one on a money workflow, refused by name (retry.ts). Since
    // version 1: no stored definition has ever held a retry field (0 of 57
    // workflows and 0 of 614 saved versions, measured 2026-10-29).
    id: 'retry',
    since: 1,
    enforce: 'every_save',
    check: (d, { lane }) => retrySaveProblems(d.retry, lane).map((p) => ({ reason: p.reason, severity: 'error' as const, message: p.message })),
  },
]

const shapeProblem = (message: string): DefinitionProblem => ({ rule: 'definition_shape', enforce: 'every_save', reason: 'definition_shape', severity: 'error', message })

/**
 * The shape every rule assumes: an object with a list of nodes, each with a
 * string id, type and namespace, and a list of edges, each with a string source
 * and target. It has held since before any stamp; a version that changes it
 * adds its own parse stage rather than editing this one (L1010).
 */
function shape(definition: unknown): { ok: true; value: ShapedDefinition } | { ok: false; problems: DefinitionProblem[] } {
  if (!isRecord(definition)) return { ok: false, problems: [shapeProblem('the definition is not an object')] }
  const problems: DefinitionProblem[] = []
  const { nodes, edges } = definition
  if (!Array.isArray(nodes)) problems.push(shapeProblem('the definition has no list of steps'))
  else {
    nodes.forEach((n, i) => {
      if (!isRecord(n) || typeof n.id !== 'string' || typeof n.type !== 'string' || typeof n.namespace !== 'string') {
        problems.push(shapeProblem(`step ${i + 1} needs a string id, type and step id`))
      } else if (n.config !== undefined && !isRecord(n.config)) {
        problems.push(shapeProblem(`step ${n.namespace} has settings that are not an object`))
      }
    })
  }
  if (!Array.isArray(edges)) problems.push(shapeProblem('the definition has no list of connections'))
  else {
    edges.forEach((e, i) => {
      if (!isRecord(e) || typeof e.source !== 'string' || typeof e.target !== 'string') problems.push(shapeProblem(`connection ${i + 1} needs a string source and target`))
    })
  }
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, value: { trigger: definition.trigger, nodes: nodes as NodeDefLike[], edges: edges as EdgeDefLike[], ...(Object.hasOwn(definition, 'retry') ? { retry: definition.retry } : {}) } }
}

/**
 * The shape problems alone: the parse every rule reads, as validateDefinition
 * reports it. The save routes refuse a definition with any of these by a named
 * 400 before any other check reads it (#2190), because every validator,
 * the cycle check included, assumes this shape and throws on a null step.
 */
export function definitionShapeProblems(definition: unknown): DefinitionProblem[] {
  const shaped = shape(definition)
  return shaped.ok ? [] : shaped.problems
}

/** One problem per step and message: an attached step's settings are refused by its own rule and by node_config alike, so keep the stricter. */
function withoutRepeats(problems: DefinitionProblem[]): DefinitionProblem[] {
  const strictness: Record<DefinitionEnforcement, number> = { every_save: 0, live_save: 1, advisory: 2 }
  const kept = new Map<string, DefinitionProblem>()
  const out: DefinitionProblem[] = []
  for (const p of problems) {
    if (p.nodeId === undefined) {
      out.push(p)
      continue
    }
    const key = `${p.nodeId}\u0000${p.message}`
    const prior = kept.get(key)
    if (prior === undefined) {
      kept.set(key, p)
      out.push(p)
    } else if (strictness[p.enforce] < strictness[prior.enforce]) {
      out[out.indexOf(prior)] = p
      kept.set(key, p)
    }
  }
  return out
}

/**
 * The version gating, with the rules and the newest known version as
 * arguments so the gating itself can be tested with rules of a version this
 * code does not have yet. validateDefinition is this with the real registry.
 */
export function judgeDefinition(definition: unknown, options: ValidateDefinitionOptions, rules: readonly DefinitionRule[], known: number): DefinitionVerdict {
  const stamp = readSchemaStamp(options.schemaVersion, known)
  switch (stamp.kind) {
    case 'unknown_schema_version':
    case 'invalid_schema_version':
      return stamp
    case 'stamped':
    case 'unstamped':
      break
  }
  const result = { kind: 'judged' as const, schemaVersion: stamp.version, stamped: stamp.kind === 'stamped' }
  const shaped = shape(definition)
  if (!shaped.ok) return { ...result, problems: shaped.problems }
  const problems: DefinitionProblem[] = []
  for (const rule of rules) {
    if (rule.since > stamp.version) continue
    for (const finding of rule.check(shaped.value, { lane: options.lane })) problems.push({ ...finding, rule: rule.id, enforce: rule.enforce })
  }
  return { ...result, problems: withoutRepeats(problems) }
}

/** Every problem with a stored definition for a workflow of `lane`, judged at its own stamp. */
export function validateDefinition(definition: unknown, options: ValidateDefinitionOptions): DefinitionVerdict {
  return judgeDefinition(definition, options, DEFINITION_RULES, DEFINITION_SCHEMA_VERSION)
}

/** An App Action step a live write may not hold, by its step id and what it lacks first. */
export interface UnfinishedStep {
  nodeId: string
  namespace: string
  message: string
}

/**
 * The App Action steps that are not finished (#2338, plan section 3.3 of
 * #1689): a step is incomplete until what it runs, its connection and its
 * required fields are set, and a workflow holding one cannot be switched on.
 * Read from validateDefinition at the definition's own stamp (its node_config
 * rule, through appActionConfigProblem), so the routes that make a definition
 * live refuse exactly what the rules in force at that stamp say. A stamp this
 * build cannot judge is answered as such, never as finished.
 */
export function unfinishedAppActionSteps(definition: unknown, options: ValidateDefinitionOptions):
  | { kind: 'judged'; steps: UnfinishedStep[] }
  | Exclude<DefinitionVerdict, { kind: 'judged' }> {
  const verdict = validateDefinition(definition, options)
  if (verdict.kind !== 'judged') return verdict
  const nodes = isRecord(definition) && Array.isArray(definition.nodes) ? (definition.nodes as unknown[]) : []
  const appSteps = new Set(nodes.filter((n): n is { id: string; type: string } => isRecord(n) && n.type === 'app_action' && typeof n.id === 'string').map((n) => n.id))
  // Through the one predicate a live save refuses by, so a step is unfinished
  // exactly when its settings would block switching on (lessons review).
  const steps = blockingProblems(verdict.problems, { live: true })
    .filter((p) => p.rule === 'node_config' && p.nodeId !== undefined && appSteps.has(p.nodeId))
    .map((p) => ({ nodeId: p.nodeId as string, namespace: p.namespace ?? (p.nodeId as string), message: p.message }))
  return { kind: 'judged', steps }
}

/** The problems that refuse a save: errors on every save, and on a live save the live rules too. Advice and warnings never refuse. */
export function blockingProblems(problems: readonly DefinitionProblem[], { live }: { live: boolean }): DefinitionProblem[] {
  return problems.filter((p) => p.severity === 'error' && (p.enforce === 'every_save' || (live && p.enforce === 'live_save')))
}
