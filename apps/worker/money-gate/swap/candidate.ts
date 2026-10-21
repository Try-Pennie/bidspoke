/**
 * A validation swap candidate (#2591, part of #934): the lead validation node a
 * workflow's `validate_bidding_and_state` code node is to be replaced with, and
 * everything the three proofs need to judge it.
 *
 * One file per workflow under `money-gate/swap/candidates/`. Phase 5 pastes the
 * `node` exactly as it is here (same id, namespace and label as the code node it
 * replaces, because lead sightings and Snowflake record the terminal step by that
 * namespace), and applies `constants_data` to the workflow's Constants step.
 *
 * - `replaces.script_md5` pins the live script text the proofs compare against.
 *   The grid (instrument 1) refuses a committed definition whose script no longer
 *   has it; the real traffic replay (instrument 3) reads only runs of versions
 *   whose script has it.
 * - `grid_accepted` lists the differences instrument 1 finds that are a named,
 *   accepted change, each with its reason. Any other difference fails, and an
 *   entry that matches nothing fails, so the list cannot outlive what it excuses.
 * - `gate_accepted` does the same for the money gate's definition A/B mode
 *   (instrument 2), in the shape of an expected-changes.json entry.
 */
import { parseLeadValidationConfig, type LeadValidationCheck, type LeadValidationConfig } from '@bidspoke/workflow-definition'
import type { ExpectedChange } from '../lib/expected-changes'

export interface CandidateNode {
  id: string
  namespace: string
  label: string
  type: 'lead_validation'
  position?: { x: number; y: number }
  config: LeadValidationConfig
  variables?: Record<string, string>
}

/** A grid difference accepted as a named change: the arm it happens on and the check it names. */
export interface GridAccepted {
  /** The arm's name, `*` matching any run of characters. */
  arm: string
  /** The check the difference names. */
  check: string
  /** What kind of difference (see OutcomeDifference.kind in outcomes.ts). */
  kind: string
  /** For an `answer` difference, exactly the fields that differ. */
  fields?: string[]
  reason: string
}

export interface SwapCandidate {
  workflow_id: string
  workflow_name: string
  replaces: { node_id: string; namespace: string; script_md5: string }
  node: CandidateNode
  /** Keys of the Constants step's data that the swap sets, merged over what is there. */
  constants_data?: Record<string, unknown>
  grid_accepted: GridAccepted[]
  gate_accepted: ExpectedChange[]
}

const MIN_REASON = 10

/** Every reason a candidate file cannot be used, by name; an empty list means it can. */
export function candidateProblems(raw: unknown): string[] {
  const c = (raw ?? {}) as Partial<SwapCandidate>
  const problems: string[] = []
  if (typeof c.workflow_id !== 'string' || !c.workflow_id) problems.push('no workflow_id')
  if (typeof c.workflow_name !== 'string' || !c.workflow_name) problems.push('no workflow_name')
  const r = c.replaces
  if (!r || typeof r.node_id !== 'string' || typeof r.namespace !== 'string' || !/^[0-9a-f]{32}$/.test(String(r.script_md5))) {
    problems.push('replaces needs node_id, namespace and the 32 character md5 of the script it replaces')
  }
  const n = c.node
  if (!n || n.type !== 'lead_validation') problems.push('node is not a lead_validation node')
  else {
    if (r && n.id !== r.node_id) problems.push(`node id ${n.id} is not the id of the node it replaces (${r.node_id}), so its edges would not reach it`)
    if (r && n.namespace !== r.namespace) problems.push(`node namespace ${n.namespace} is not ${r.namespace}, which lead sightings and Snowflake record`)
    if (typeof n.label !== 'string' || !n.label) problems.push('node has no label')
    const parsed = parseLeadValidationConfig(n.config)
    if (!parsed.ok) problems.push(...parsed.problems.map((p) => `node config: ${p}`))
  }
  if (!Array.isArray(c.grid_accepted)) problems.push('no grid_accepted list (an empty list says none)')
  else c.grid_accepted.forEach((g, i) => {
    if (!g || typeof g.arm !== 'string' || typeof g.check !== 'string' || typeof g.kind !== 'string') problems.push(`grid_accepted ${i} needs arm, check and kind`)
    if (!g || typeof g.reason !== 'string' || g.reason.trim().length < MIN_REASON) problems.push(`grid_accepted ${i} has no written reason`)
  })
  if (!Array.isArray(c.gate_accepted)) problems.push('no gate_accepted list (an empty list says none)')
  return problems
}

export function parseCandidate(raw: unknown, name: string): SwapCandidate {
  const problems = candidateProblems(raw)
  if (problems.length) throw new Error(`swap candidate ${name}: ${problems.join('; ')}`)
  return raw as SwapCandidate
}

interface DefNode { id: string; namespace: string; type: string; label?: string; config?: Record<string, unknown>; [k: string]: unknown }
interface DefLike { id: string; name: string; definition: { nodes: DefNode[]; edges: Array<{ source: string; target: string; source_handle?: string }> } }

/**
 * The workflow's definition with the candidate in place: the code node swapped
 * for the lead validation node (keeping its position), and the Constants data
 * the candidate sets merged in. Refuses, by name, a definition that is not the
 * candidate's workflow or does not hold the node it replaces as a code node.
 */
export function applyCandidate<T extends DefLike>(def: T, candidate: SwapCandidate): T {
  if (def.id !== candidate.workflow_id) throw new Error(`swap candidate for ${candidate.workflow_name} applied to ${def.name} (${def.id})`)
  const old = def.definition.nodes.find((n) => n.id === candidate.replaces.node_id)
  if (!old) throw new Error(`${def.name} has no node ${candidate.replaces.node_id} for the candidate to replace`)
  if (old.namespace !== candidate.replaces.namespace || old.type !== 'code') {
    throw new Error(`${def.name}: node ${old.id} is the ${old.type} step ${old.namespace}, not the code step ${candidate.replaces.namespace} the candidate replaces`)
  }
  const constantsData = candidate.constants_data ?? {}
  const constantsKeys = Object.keys(constantsData)
  const constantsNodes = def.definition.nodes.filter((n) => n.type === 'constants')
  if (constantsKeys.length && constantsNodes.length !== 1) {
    throw new Error(`${def.name}: the candidate sets Constants data but the workflow has ${constantsNodes.length} Constants steps`)
  }
  const nodes = def.definition.nodes.map((n) => {
    if (n.id === old.id) {
      const { position: _ignored, ...rest } = candidate.node
      return { ...rest, position: old.position ?? candidate.node.position, config: structuredClone(candidate.node.config) as unknown as Record<string, unknown> }
    }
    if (constantsKeys.length && n.type === 'constants') {
      const config = (n.config ?? {}) as { data?: Record<string, unknown> }
      return { ...n, config: { ...config, data: { ...(config.data ?? {}), ...structuredClone(constantsData) } } }
    }
    return n
  })
  return { ...def, definition: { ...def.definition, nodes } }
}

export type DefectDirection = 'lenient' | 'strict'

/**
 * The candidate with one check made wrong on purpose, so each instrument can be
 * seen to name a difference before it is trusted (L1).
 *
 * - `lenient`: the check passes every lead it can judge (an OR with a group that
 *   always passes), so leads the script rejects for that reason go on.
 * - `strict`: the check fails every lead (an AND with a group that never
 *   passes), so leads the script lets through are rejected for that reason.
 *
 * Both lean on the lead id field, which the base lead of every grid carries, and
 * keep the config one the parser accepts.
 */
export function seedDefect(candidate: SwapCandidate, checkId: string, direction: DefectDirection): SwapCandidate {
  const config = candidate.node.config
  if (!config.checks.some((c) => c.id === checkId)) throw new Error(`${candidate.workflow_name} has no check ${checkId} to seed a defect in`)
  const always = { logic: 'AND' as const, conditions: [{ field: config.lead_id_field, operator: direction === 'lenient' ? 'exists' as const : 'not_exists' as const }] }
  const checks: LeadValidationCheck[] = config.checks.map((c) => {
    if (c.id !== checkId) return c
    // A condition is groups joined by one logic, with no nesting, so "this check
    // OR always" is only expressible for a check of one group. Every check in the
    // candidates is one group; a later one that is not is refused by name.
    if (c.condition.groups.length !== 1) throw new Error(`check ${checkId} has ${c.condition.groups.length} groups; a defect can be seeded only in a check of one group`)
    return { ...c, condition: { groups: [c.condition.groups[0], always], logic: direction === 'lenient' ? 'OR' : 'AND' } }
  })
  return { ...candidate, node: { ...candidate.node, config: { ...config, checks } } }
}

/** `<check>:<lenient|strict>`, the form the A/B mode and the replay CLI take a seeded defect in. */
export function parseSeed(text: string | undefined): { checkId: string; direction: DefectDirection } | null {
  if (!text) return null
  const m = /^([^:]+):(lenient|strict)$/.exec(text)
  if (!m) throw new Error(`a seeded defect is <check id>:lenient or <check id>:strict, not ${JSON.stringify(text)}`)
  return { checkId: m[1], direction: m[2] as DefectDirection }
}
