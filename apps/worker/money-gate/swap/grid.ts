/**
 * Instrument 1 of a validation swap (#2591): the live script and the candidate
 * node, side by side over a generated grid of synthetic leads.
 *
 * A grid is a base lead both sides let through, and dimensions: one value the
 * step reads (a payload field, an upstream step's output, a Constants value),
 * each with the values to try. Every value of every dimension is one arm, with
 * everything else as in the base lead; then every pair of dimensions is tried
 * with each one's first rejecting value, which is how the script's order (the
 * first failing check wins, and a later crash beats an earlier rejection) is
 * compared with the node's.
 *
 * Synthetic only: no value here comes from a real lead.
 */
import type { LeadValidationConfig } from '@bidspoke/workflow-definition'
import {
  BUCKETS,
  compareOutcomes,
  namedCheck,
  runNode,
  runScript,
  type Bucket,
  type LeadInput,
  type OutcomeDifference,
  type ValidationOutcome,
  compileValidationScript,
} from './outcomes'
import type { GridAccepted } from './candidate'

/** A value that is removed from the lead rather than set. */
export const UNSET = Symbol('unset')

export interface GridValue {
  label: string
  value: unknown
  /** One the script rejects; the first such value of each dimension is used in the pairs. */
  rejects?: boolean
}

export interface GridDimension {
  /** The dimension's short name, used in arm names. */
  name: string
  /** `payload.<path>` or `steps.<namespace>.output.<path>`. */
  path: string
  values: GridValue[]
}

export interface GridSpec {
  base: LeadInput
  dimensions: GridDimension[]
}

export interface GridArm {
  name: string
  lead: LeadInput
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let at: Record<string, unknown> = target
  for (const p of parts.slice(0, -1)) {
    const next = at[p]
    if (next === null || typeof next !== 'object') {
      // The path's parent is gone (another dimension removed it): nothing to set.
      if (value === UNSET) return
      at[p] = {}
    }
    at = at[p] as Record<string, unknown>
  }
  const last = parts[parts.length - 1]
  if (value === UNSET) delete at[last]
  else at[last] = structuredClone(value)
}

function withValue(lead: LeadInput, path: string, value: unknown): LeadInput {
  const copy = { payload: structuredClone(lead.payload), steps: structuredClone(lead.steps), trace_id: lead.trace_id }
  setPath(copy, path, value)
  return copy
}

/** Every arm of a grid: the base, every value of every dimension, and the pairs. */
export function gridArms(spec: GridSpec): GridArm[] {
  const arms: GridArm[] = [{ name: 'base', lead: spec.base }]
  for (const d of spec.dimensions) {
    for (const v of d.values) arms.push({ name: `${d.name}=${v.label}`, lead: withValue(spec.base, d.path, v.value) })
  }
  const firstRejecting = spec.dimensions.map((d) => ({ d, v: d.values.find((v) => v.rejects) })).filter((x): x is { d: GridDimension; v: GridValue } => x.v !== undefined)
  for (let i = 0; i < firstRejecting.length; i++) {
    for (let j = i + 1; j < firstRejecting.length; j++) {
      const a = firstRejecting[i]
      const b = firstRejecting[j]
      if (a.d.path.startsWith(`${b.d.path}.`) || b.d.path.startsWith(`${a.d.path}.`)) continue
      const lead = withValue(withValue(spec.base, a.d.path, a.v.value), b.d.path, b.v.value)
      arms.push({ name: `${a.d.name}=${a.v.label} + ${b.d.name}=${b.v.label}`, lead })
    }
  }
  return arms
}

/** The lead as the node sees it: the swap's own Constants data merged over the Constants step's output. */
export function withConstantsData(lead: LeadInput, constantsNamespace: string | null, data: Record<string, unknown> | undefined): LeadInput {
  if (!data || !constantsNamespace || Object.keys(data).length === 0) return lead
  const steps = { ...lead.steps }
  const prior = steps[constantsNamespace]?.output
  steps[constantsNamespace] = { output: { ...(prior && typeof prior === 'object' ? prior : {}), ...structuredClone(data) } }
  return { ...lead, steps }
}

export interface GridArmResult {
  arm: string
  script: ValidationOutcome
  node: ValidationOutcome
  bucket: Exclude<Bucket, 'no_validate_step'>
  difference: OutcomeDifference | null
}

export interface GridReport {
  results: GridArmResult[]
  buckets: Record<Bucket, number>
  /** Script rejections by reason. */
  scriptReasons: Record<string, number>
  /** Node rejections by check. */
  nodeChecks: Record<string, number>
  /** Leads each check let through for want of a value. */
  unjudgedChecks: Record<string, number>
}

export interface GridRun {
  script: string
  config: LeadValidationConfig
  namespace: string
  constantsNamespaces: ReadonlySet<string>
  /** The Constants data the swap sets, for the node side only. */
  constantsData?: Record<string, unknown>
  spec: GridSpec
}

export async function runGrid(run: GridRun): Promise<GridReport> {
  const compiled = compileValidationScript(run.script)
  const constantsNs = run.constantsNamespaces.size === 1 ? [...run.constantsNamespaces][0] : null
  const results: GridArmResult[] = []
  for (const arm of gridArms(run.spec)) {
    const script = await runScript(compiled, arm.lead)
    const node = runNode(run.config, run.namespace, run.constantsNamespaces, withConstantsData(arm.lead, constantsNs, run.constantsData))
    const { bucket, difference } = compareOutcomes(script, node, run.config)
    results.push({ arm: arm.name, script, node, bucket, difference })
  }
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, results.filter((r) => r.bucket === b).length])) as Record<Bucket, number>
  const count = (keys: Array<string | null>) => {
    const out: Record<string, number> = {}
    for (const k of keys) if (k !== null) out[k] = (out[k] ?? 0) + 1
    return out
  }
  const reasonOf = (o: ValidationOutcome) => (o.kind === 'reject' ? String((o.body as { reason?: unknown } | null)?.reason) : null)
  return {
    results,
    buckets,
    scriptReasons: count(results.map((r) => reasonOf(r.script))),
    nodeChecks: count(results.map((r) => (r.node.kind === 'reject' ? r.node.check_id : null))),
    unjudgedChecks: count(results.flatMap((r) => (r.node.kind === 'pass' ? r.node.unjudged ?? [] : []))),
  }
}

/** One difference as a line: the arm, what kind, and the check it names. */
export interface GridDifference {
  arm: string
  kind: OutcomeDifference['kind']
  check: string
  fields: string[]
}

export function gridDifferences(report: GridReport): GridDifference[] {
  return report.results
    .filter((r): r is GridArmResult & { difference: OutcomeDifference } => r.difference !== null)
    .map((r) => ({ arm: r.arm, kind: r.difference.kind, check: namedCheck(r.difference), fields: r.difference.fields }))
}

function globToRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
}

/** The differences no accepted entry covers, and the accepted entries that cover nothing. */
export function applyGridAccepted(diffs: GridDifference[], accepted: GridAccepted[]): { unaccepted: GridDifference[]; unused: GridAccepted[] } {
  const used = new Set<GridAccepted>()
  const unaccepted: GridDifference[] = []
  for (const d of diffs) {
    const matching = accepted.filter((a) => a.kind === d.kind && globToRegex(a.check).test(d.check) && globToRegex(a.arm).test(d.arm) &&
      (a.fields === undefined || a.fields.join(',') === d.fields.join(',')))
    for (const a of matching) used.add(a)
    if (!matching.length) unaccepted.push(d)
  }
  return { unaccepted, unused: accepted.filter((a) => !used.has(a)) }
}

export function formatGridDifference(d: GridDifference): string {
  return `arm ${d.arm}: ${d.kind} at check ${d.check}${d.fields.length ? ` (${d.fields.join(', ')})` : ''}`
}

/** The grid's report in words: counts by bucket, reasons reached, and every difference by check. */
export function formatGridReport(workflow: string, report: GridReport): string {
  const lines = [`${workflow}: ${report.results.length} arms`]
  lines.push(`  buckets: ${BUCKETS.filter((b) => b !== 'no_validate_step').map((b) => `${b} ${report.buckets[b]}`).join(', ')}`)
  lines.push(`  script rejections by reason: ${Object.entries(report.scriptReasons).map(([r, n]) => `${r} ${n}`).join(', ') || '(none)'}`)
  lines.push(`  node rejections by check: ${Object.entries(report.nodeChecks).map(([c, n]) => `${c} ${n}`).join(', ') || '(none)'}`)
  const diffs = gridDifferences(report)
  const byCheck = new Map<string, GridDifference[]>()
  for (const d of diffs) byCheck.set(`${d.check} ${d.kind}`, [...(byCheck.get(`${d.check} ${d.kind}`) ?? []), d])
  for (const [key, ds] of byCheck) lines.push(`  difference at ${key}: ${ds.length} arm(s): ${ds.map((d) => d.arm).join('; ')}`)
  const threw = report.results.filter((r) => r.bucket === 'script_threw')
  if (threw.length) lines.push(`  script threw on ${threw.length} arm(s), the node then ${['pass', 'reject', 'threw'].map((k) => `${k} ${threw.filter((r) => r.node.kind === k).length}`).join(', ')}`)
  return lines.join('\n')
}
