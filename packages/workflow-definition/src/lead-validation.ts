/**
 * The lead validation node's config: its one shape, the rules a saved one must
 * meet, and the references it reads (#2589, part of #934).
 *
 * The node holds an ordered list of checks. Each check is a rule builder
 * condition describing a lead that may go on, the rejection reason a partner is
 * told when a lead does not, and what happens when the lead lacks a value the
 * condition reads. The first check a lead does not pass rejects it; a lead that
 * passes every check goes on.
 *
 * One parser serves the canvas, the save route and the engine, so what is
 * refused at save is what the executor cannot run (L370): the engine treats a
 * stored config this parser refuses as a configuration fault rather than
 * guessing at it.
 *
 * Which references are CONFIGURATION matters at run time: a Constants value or
 * an env value that is missing is the workflow's fault, the same on every lead,
 * so it is alerted once per incident; a lead value that is missing is that
 * lead's, and the check's own choice applies.
 */
import { isNodeType } from '@bidspoke/node-types'
import { CONDITION_OPERATOR_SPECS, isConditionOperator, isConditionValueReference, type ConditionOperator } from './condition-operators'
import { isLeadRejectionReason, type LeadRejectionReason } from './lead-rejection-reasons'
import { upstreamNamespaces } from './reference-validation'
import type { EdgeDefLike, NodeDefLike, ValidationError } from './workflow-validation'

/**
 * What a check does when the lead lacks a value its condition reads, or holds
 * one of a kind the operator cannot read (text where a number is compared):
 * reject the lead with the check's reason, let it pass this check, or fail the
 * run so a person looks.
 */
export const LEAD_VALIDATION_ON_MISSING = ['reject', 'pass', 'fail_run'] as const
export type LeadValidationOnMissing = (typeof LEAD_VALIDATION_ON_MISSING)[number]

export type LeadValidationLogic = 'AND' | 'OR'

export interface LeadValidationCondition {
  field: string
  operator: ConditionOperator
  value?: unknown
}

export interface LeadValidationGroup {
  conditions: LeadValidationCondition[]
  logic: LeadValidationLogic
}

export interface LeadValidationCheck {
  id: string
  label: string
  /** What a lead that may go on looks like: rule builder groups, as Branch stores them. */
  condition: { groups: LeadValidationGroup[]; logic: LeadValidationLogic }
  reason: LeadRejectionReason
  on_missing: LeadValidationOnMissing
}

export interface LeadValidationConfig {
  /** The lead's id, echoed in the rejection body as `lead_id`. */
  lead_id_field: string
  checks: LeadValidationCheck[]
  /** Sent with a rejection, literally. */
  response_headers: Record<string, string>
}

export type ParsedLeadValidationConfig = { ok: true; config: LeadValidationConfig } | { ok: false; problems: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
const isLogic = (v: unknown): v is LeadValidationLogic => v === 'AND' || v === 'OR'
const ON_MISSING: ReadonlySet<string> = new Set(LEAD_VALIDATION_ON_MISSING)

/** A literal a number comparison can read: a finite number, or text that is one. */
export function isNumericLiteral(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'string' && v.trim() !== '') return Number.isFinite(Number(v))
  return false
}

/**
 * A reference the node can resolve, broken into the parts save validation
 * judges. Read the way the condition resolver reads a path (resolveField in
 * apps/worker/src/engine/graph.ts): `steps.<namespace>` then an optional
 * `output`, then the field; `trigger.` and `env.<name>`. Anything else is null:
 * a coalesce, padding, an empty segment, `execution.` (which conditions cannot
 * read) or no root at all.
 */
export interface NodeReference {
  root: 'steps' | 'trigger' | 'env'
  /** The step a `steps.` reference names. */
  namespace: string | null
  /** For `steps.`, the first field after the namespace (and `output`); for `env.`, the name. */
  key: string | null
}

export function parseNodeReference(path: string): NodeReference | null {
  if (typeof path !== 'string' || path === '' || path !== path.trim() || /\s/.test(path) || path.includes('??')) return null
  const parts = path.split('.')
  if (parts.some((p) => p === '')) return null
  const [root, ...rest] = parts
  if (root === 'trigger') return rest.length > 0 ? { root: 'trigger', namespace: null, key: null } : null
  if (root === 'env') return rest.length === 1 ? { root: 'env', namespace: null, key: rest[0] } : null
  if (root === 'steps') {
    if (rest.length === 0) return null
    const [namespace, ...field] = rest
    const afterOutput = field[0] === 'output' ? field.slice(1) : field
    const first = afterOutput[0]
    return { root: 'steps', namespace, key: first === undefined ? null : first.replace(/\[\d+\]$/, '') }
  }
  return null
}

/**
 * A `steps.` reference in the form templates and scripts write it, with the
 * `output` segment the condition resolver lets an author leave out, so a reader
 * that matches `steps.<ns>.output.<key>` (the partner workflow values scanner)
 * sees a condition path written either way. Anything else is returned as is.
 */
export function withOutputSegment(path: string): string {
  const parts = path.split('.')
  if (parts[0] !== 'steps' || parts.length < 3 || parts[2] === 'output') return path
  return [parts[0], parts[1], 'output', ...parts.slice(2)].join('.')
}

/** The namespaces of a definition's Constants nodes: the configuration its checks may read. */
export function constantsNamespacesOf(nodes: ReadonlyArray<{ type?: unknown; namespace?: unknown }>): Set<string> {
  const out = new Set<string>()
  for (const n of nodes) {
    if (n.type === 'constants' && typeof n.namespace === 'string' && n.namespace !== '') out.add(n.namespace)
  }
  return out
}

/** Whether a reference reads configuration (env, or a Constants node's output) rather than the lead. */
export function isLeadValidationConfigReference(path: string, constantsNamespaces: ReadonlySet<string>): boolean {
  const ref = parseNodeReference(path)
  if (!ref) return false
  if (ref.root === 'env') return true
  return ref.root === 'steps' && ref.namespace !== null && constantsNamespaces.has(ref.namespace)
}

/** Whether an operator reads the value side as a reference when it is one: numbers and lists (graph.ts). */
export function valueSideResolves(op: ConditionOperator): boolean {
  const kind = CONDITION_OPERATOR_SPECS[op].valueKind
  return kind === 'number' || kind === 'list'
}

function checkName(check: Record<string, unknown>, index: number): string {
  return typeof check.label === 'string' && check.label.trim() !== '' ? `"${check.label}"` : `${index + 1}`
}

function conditionProblem(name: string, raw: unknown): { problem: string } | { condition: LeadValidationCondition } {
  const c = isRecord(raw) ? raw : {}
  const field = c.field
  if (typeof field !== 'string' || field.trim() === '') return { problem: `Check ${name}: a condition has no field` }
  if (c.operator === undefined || c.operator === null || c.operator === '') return { problem: `Check ${name}: the condition on ${field} has no operator` }
  if (!isConditionOperator(c.operator)) {
    // Shown back to the author: a scalar from stored config in practice.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return { problem: `Check ${name}: "${String(c.operator)}" is not a condition Bidspoke knows` }
  }
  if (parseNodeReference(field) === null) return { problem: `Check ${name}: ${field} is not a reference (it starts with trigger., steps. or env.)` }
  const op = c.operator
  const kind = CONDITION_OPERATOR_SPECS[op].valueKind
  if (kind === 'none') return { condition: { field, operator: op } }
  const value = c.value
  if (isBlank(value) || (Array.isArray(value) && value.length === 0)) return { problem: `Check ${name}: the condition on ${field} has no value` }
  if (kind === 'list') {
    if (isConditionValueReference(value)) return { condition: { field, operator: op, value } }
    if (!Array.isArray(value)) return { problem: `Check ${name}: the condition on ${field} needs a list or a reference to one` }
    if (value.some(isBlank)) return { problem: `Check ${name}: the list on ${field} has an empty entry` }
    return { condition: { field, operator: op, value } }
  }
  if (kind === 'number') {
    if (isConditionValueReference(value)) return { condition: { field, operator: op, value } }
    if (!isNumericLiteral(value)) {
      return { problem: `Check ${name}: the condition on ${field} compares against ${JSON.stringify(value)}, which is not a number` }
    }
    return { condition: { field, operator: op, value } }
  }
  // scalar and text: compared as written, never resolved, so a reference here
  // would be compared as the words of the path.
  if (isConditionValueReference(value)) {
    return { problem: `Check ${name}: the condition on ${field} compares against ${value} as text; this operator cannot read a value from it` }
  }
  return { condition: { field, operator: op, value } }
}

function checkProblems(raw: unknown, index: number, seenIds: Set<string>): { problems: string[]; check: LeadValidationCheck | null } {
  const check = isRecord(raw) ? raw : {}
  const name = checkName(check, index)
  const problems: string[] = []
  if (typeof check.label !== 'string' || check.label.trim() === '') problems.push(`Check ${name} has no label`)
  const id = check.id
  if (typeof id !== 'string' || id.trim() === '') problems.push(`Check ${name} has no id`)
  else if (seenIds.has(id)) problems.push(`Check ${name} has the same id as another check`)
  else seenIds.add(id)

  if (isBlank(check.reason)) problems.push(`Check ${name}: no rejection reason chosen`)
  else if (!isLeadRejectionReason(check.reason)) problems.push(`Check ${name}: "${String(check.reason)}" is not a rejection reason Bidspoke knows`)
  if (typeof check.on_missing !== 'string' || !ON_MISSING.has(check.on_missing)) {
    problems.push(`Check ${name}: no choice for a lead missing a value (reject, pass or fail the run)`)
  }

  const condition = isRecord(check.condition) ? check.condition : {}
  const groupsRaw = Array.isArray(condition.groups) ? condition.groups : []
  const groups: LeadValidationGroup[] = []
  if (groupsRaw.length === 0) problems.push(`Check ${name} has no conditions`)
  else if (!isLogic(condition.logic)) problems.push(`Check ${name} joins its groups by neither AND nor OR`)
  for (const g of groupsRaw) {
    const group = isRecord(g) ? g : {}
    const conds = Array.isArray(group.conditions) ? group.conditions : []
    if (conds.length === 0) {
      problems.push(`Check ${name} has a group with no conditions`)
      continue
    }
    if (!isLogic(group.logic)) problems.push(`Check ${name} joins a group's conditions by neither AND nor OR`)
    const conditions: LeadValidationCondition[] = []
    for (const c of conds) {
      const judged = conditionProblem(name, c)
      if ('problem' in judged) problems.push(judged.problem)
      else conditions.push(judged.condition)
    }
    groups.push({ conditions, logic: isLogic(group.logic) ? group.logic : 'AND' })
  }

  if (problems.length > 0) return { problems, check: null }
  return {
    problems,
    check: {
      id: id as string,
      label: check.label as string,
      condition: { groups, logic: condition.logic as LeadValidationLogic },
      reason: check.reason as LeadRejectionReason,
      on_missing: check.on_missing as LeadValidationOnMissing,
    },
  }
}

/**
 * The config as the engine runs it, or every reason it cannot be run. Pure and
 * graph free: whether a reference runs before the node is
 * findLeadValidationProblems's question, since only the definition can answer it.
 */
export function parseLeadValidationConfig(config: unknown): ParsedLeadValidationConfig {
  const c = isRecord(config) ? config : {}
  const problems: string[] = []

  const leadId = c.lead_id_field
  if (typeof leadId !== 'string' || leadId.trim() === '') problems.push('No lead id field set')
  else if (parseNodeReference(leadId) === null) problems.push(`The lead id field ${leadId} is not a reference (it starts with trigger., steps. or env.)`)

  const checksRaw = Array.isArray(c.checks) ? c.checks : []
  if (checksRaw.length === 0) problems.push('No checks set')
  const seenIds = new Set<string>()
  const checks: LeadValidationCheck[] = []
  checksRaw.forEach((raw, i) => {
    const judged = checkProblems(raw, i, seenIds)
    problems.push(...judged.problems)
    if (judged.check) checks.push(judged.check)
  })

  const headers: Record<string, string> = {}
  if (c.response_headers !== undefined && c.response_headers !== null) {
    if (!isRecord(c.response_headers)) problems.push('The response headers are not a list of names and values')
    else {
      for (const [name, value] of Object.entries(c.response_headers)) {
        if (name.trim() === '') problems.push('A response header has no name')
        else if (typeof value !== 'string' || value.trim() === '') problems.push(`Response header ${name} has no value`)
        else headers[name] = value
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, config: { lead_id_field: leadId as string, checks, response_headers: headers } }
}

/** The first problem with a stored config, or null: what the canvas and the enable check show (validateNodeConfig). */
export function leadValidationConfigProblem(config: unknown): string | null {
  const parsed = parseLeadValidationConfig(config)
  return parsed.ok ? null : parsed.problems[0]
}

export interface LeadValidationReference {
  /** The check it belongs to, or null for the lead id field. */
  checkId: string | null
  side: 'lead_id' | 'field' | 'value'
  path: string
}

/**
 * Every reference the node reads, in check order: the lead id field, then each
 * condition's field, and its value where the operator resolves one. The one
 * list the save check, the run time configuration check and the readers of a
 * definition (the partner workflow values scanner) walk.
 */
export function leadValidationReferences(config: LeadValidationConfig): LeadValidationReference[] {
  const out: LeadValidationReference[] = [{ checkId: null, side: 'lead_id', path: config.lead_id_field }]
  for (const check of config.checks) {
    for (const group of check.condition.groups) {
      for (const c of group.conditions) {
        out.push({ checkId: check.id, side: 'field', path: c.field })
        if (valueSideResolves(c.operator) && isConditionValueReference(c.value)) out.push({ checkId: check.id, side: 'value', path: c.value })
      }
    }
  }
  return out
}

/** The keys a Constants node's own data holds: the only keys save time can vouch for. */
function constantsDataKeys(node: NodeDefLike): Set<string> {
  const data = isRecord(node.config) && isRecord(node.config.data) ? node.config.data : {}
  return new Set(Object.keys(data))
}

/**
 * Every problem with the workflow's lead validation nodes, judged where each
 * sits: the shape problems, then any reference that does not run before the
 * node or names a Constants key its Constants node does not hold. Partner
 * values the Constants node adds from the database (`activeBidding`,
 * `<Slug>ClickUrl` and the rest) are not in its data and are refused: no check
 * in the first version reads them, and a partner lookup check is its own issue.
 *
 * Attached nodes only, as validateWorkflowDef judges them, so a node lying
 * loose on the canvas while it is being built does not block a save.
 */
export function findLeadValidationProblems(nodes: NodeDefLike[], edges: EdgeDefLike[]): ValidationError[] {
  const errors: ValidationError[] = []
  const constantsByNs = new Map(nodes.filter((n) => n.type === 'constants').map((n) => [n.namespace, n]))
  for (const node of nodes) {
    if (!isNodeType(node.type) || node.type !== 'lead_validation') continue
    const attached = edges.some((e) => e.source === node.id || e.target === node.id)
    if (!attached) continue
    const push = (message: string) => errors.push({ nodeId: node.id, namespace: node.namespace, label: node.label, message })

    const parsed = parseLeadValidationConfig(node.config)
    if (!parsed.ok) {
      parsed.problems.forEach(push)
      continue
    }
    const upstream = upstreamNamespaces(nodes, edges, node.id)
    const labelOf = new Map(parsed.config.checks.map((c) => [c.id, c.label]))
    for (const ref of leadValidationReferences(parsed.config)) {
      const where = ref.checkId === null ? `The lead id field ${ref.path}` : `Check "${labelOf.get(ref.checkId) ?? ref.checkId}": ${ref.path}`
      const parsedRef = parseNodeReference(ref.path)
      if (!parsedRef) {
        push(`${where} is not a reference (it starts with trigger., steps. or env.)`)
        continue
      }
      if (parsedRef.root !== 'steps' || parsedRef.namespace === null) continue
      if (!upstream.has(parsedRef.namespace)) {
        push(`${where} reads ${parsedRef.namespace}, which does not run before this step`)
        continue
      }
      const constantsNode = constantsByNs.get(parsedRef.namespace)
      if (!constantsNode) continue
      if (parsedRef.key === null) push(`${where} names no key of the ${parsedRef.namespace} step`)
      else if (!constantsDataKeys(constantsNode).has(parsedRef.key)) push(`${where} names ${parsedRef.key}, which the ${parsedRef.namespace} step does not hold`)
    }
  }
  return errors
}
