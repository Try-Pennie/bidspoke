/**
 * What a validation step did with one lead, as the script and as the node, and
 * how the two compare (#2591). Shared by the script against node grid
 * (instrument 1) and the real traffic replay (instrument 3), so the two
 * instruments sort a lead into the same buckets by the same rule.
 *
 * Both sides are read the way the engine reads them: the script's return value
 * goes through `codeSentinel`, the rule that turns `{ response }` into the answer
 * the source gets, after a JSON round trip, because a code node's output crosses
 * the sandbox boundary as JSON (a `lead_id: undefined` is dropped there). The
 * node's answer goes through the same round trip, as the HTTP response does.
 */
import { constantsNamespacesOf, type LeadValidationConfig } from '@bidspoke/workflow-definition'
import { codeSentinel } from '../../src/engine/nodes/code'
import { compileCanvasScript } from '../../src/engine/scripts/__tests__/canvas-script'
import { executeLeadValidationNode } from '../../src/engine/nodes/lead-validation'
import type { ExecutionContext, NodeDefinition } from '../../src/types'
import { canonical, deepDiff } from '../lib/compare'

export type ValidationOutcome =
  /** `unjudged`: the node's checks that let the lead through for want of a value (on_missing pass). */
  | { kind: 'pass'; unjudged?: string[] }
  | { kind: 'reject'; status: number; headers: Record<string, string> | null; body: unknown; check_id: string | null }
  | { kind: 'threw'; error: string }

/** One lead as a validation step sees it: the trigger payload and the outputs of the steps before it. */
export interface LeadInput {
  payload: unknown
  steps: Record<string, { output: unknown }>
  /** The run's trace id: Lead Economy's script sends it back as `requestId`. */
  trace_id: string
}

const jsonRoundTrip = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)) as unknown)

/** A step's recorded or returned output, read as the engine reads a code node's. */
export function outcomeOfScriptOutput(output: unknown): ValidationOutcome {
  const sentinel = codeSentinel(jsonRoundTrip(output))
  const r = sentinel.earlyResponse
  if (!r) return { kind: 'pass' }
  return { kind: 'reject', status: r.status, headers: r.headers ?? null, body: jsonRoundTrip(r.body), check_id: null }
}

type CompiledScript = ReturnType<typeof compileCanvasScript>

/**
 * The script compiled once, the way the code node deployer wraps it
 * (lib/code-node-deployer.ts: `trigger` and `process` synthesised, `props`
 * defaulted), by the one harness kept scripts are held to.
 */
export const compileValidationScript = compileCanvasScript

const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} }
const noFetch = () => { throw new Error('a validation script fetched') }

function errorName(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return typeof err === 'string' ? err : 'a non Error value'
}

export async function runScript(script: CompiledScript, lead: LeadInput): Promise<ValidationOutcome> {
  // The sandbox hands the script parsed JSON, so it never sees an undefined
  // inside an array or a value JSON cannot carry.
  const payload = jsonRoundTrip(lead.payload)
  const steps = jsonRoundTrip(lead.steps)
  try {
    const out = await script(payload, steps, {}, { trace_id: lead.trace_id }, quiet, {}, noFetch)
    return outcomeOfScriptOutput(out)
  } catch (err) {
    return { kind: 'threw', error: errorName(err) }
  }
}

/** The node's answer to one lead, through its own executor. */
export function runNode(config: LeadValidationConfig, namespace: string, constantsNamespaces: ReadonlySet<string>, lead: LeadInput): ValidationOutcome {
  const node = { id: 'swap-candidate', namespace, type: 'lead_validation', config } as unknown as NodeDefinition
  const ctx = {
    trigger: { payload: jsonRoundTrip(lead.payload), source: 'swap-proof', workflow_id: 'swap-proof', trace_id: lead.trace_id, org_id: 'swap-proof' },
    steps: jsonRoundTrip(lead.steps) as ExecutionContext['steps'],
    env: {},
    execution: { workflow_id: 'swap-proof', trace_id: lead.trace_id },
    constantsNamespaces,
  } as ExecutionContext
  try {
    const result = executeLeadValidationNode(node, ctx)
    const r = result.earlyResponse
    if (!r) {
      const unjudged = (result.output as { passed_unjudged?: Array<{ check_id: string }> }).passed_unjudged
      return unjudged?.length ? { kind: 'pass', unjudged: unjudged.map((u) => u.check_id) } : { kind: 'pass' }
    }
    const checkId = (result.output as { check_id?: unknown }).check_id
    return { kind: 'reject', status: r.status, headers: r.headers ?? null, body: jsonRoundTrip(r.body), check_id: typeof checkId === 'string' ? checkId : null }
  } catch (err) {
    return { kind: 'threw', error: errorName(err) }
  }
}

export { constantsNamespacesOf }

/**
 * The buckets a lead falls in. Every lead lands in exactly one.
 * - agree: both went on, or both answered the same status, headers and body.
 * - response_differs: one went on and the other answered, or both answered differently.
 * - script_threw: the script threw (the run failed); what the node did is noted.
 * - node_threw: the node threw (a check set to fail the run, or a setting fault) where the script answered.
 * - no_validate_step: the run never reached the validation step (instrument 3 only).
 */
export const BUCKETS = ['agree', 'response_differs', 'script_threw', 'node_threw', 'no_validate_step'] as const
export type Bucket = (typeof BUCKETS)[number]

/** How the node parted from the script, named by the checks involved. */
export interface OutcomeDifference {
  /** The check carrying the script's rejection reason, where the script rejected. */
  script_check: string | null
  /** The node's rejecting check, where the node rejected. */
  node_check: string | null
  /**
   * node_rejects: the script let the lead go on, the node rejected it (too strict).
   * node_passes: the script rejected it, the node let it go on (too lenient).
   * other_reason: both rejected, for different reasons.
   * answer: both rejected for the same reason, but the status, headers or body differ.
   * node_threw: the node threw where the script answered.
   * passes_after_throw: the script threw (the run failed) and the node lets the lead go on.
   */
  kind: 'node_rejects' | 'node_passes' | 'other_reason' | 'answer' | 'node_threw' | 'passes_after_throw'
  /** The fields that differ, for `answer`; never a value. */
  fields: string[]
}

/** The check a difference is about, as one name: `<script check>><node check>` where both rejected differently. */
export function namedCheck(d: OutcomeDifference): string {
  if (d.kind === 'other_reason') return `${d.script_check ?? '?'}>${d.node_check ?? '?'}`
  return d.node_check ?? d.script_check ?? '-'
}

export interface Comparison {
  bucket: Exclude<Bucket, 'no_validate_step'>
  difference: OutcomeDifference | null
}

const reasonOf = (o: ValidationOutcome): string | null => {
  if (o.kind !== 'reject') return null
  const r = (o.body as { reason?: unknown } | null)?.reason
  return typeof r === 'string' ? r : null
}

export function compareOutcomes(script: ValidationOutcome, node: ValidationOutcome, config: LeadValidationConfig): Comparison {
  const checkByReason = (reason: string | null) => config.checks.find((c) => c.reason === reason)?.id ?? null
  const diff = (kind: OutcomeDifference['kind'], script_check: string | null, node_check: string | null, fields: string[] = []): OutcomeDifference => ({ script_check, node_check, kind, fields })
  if (script.kind === 'threw') {
    return { bucket: 'script_threw', difference: node.kind === 'pass' ? diff('passes_after_throw', null, null) : null }
  }
  if (node.kind === 'threw') return { bucket: 'node_threw', difference: diff('node_threw', checkByReason(reasonOf(script)), null) }
  if (script.kind === 'pass' && node.kind === 'pass') return { bucket: 'agree', difference: null }
  if (script.kind === 'pass' && node.kind === 'reject') return { bucket: 'response_differs', difference: diff('node_rejects', null, node.check_id) }
  if (script.kind === 'reject' && node.kind === 'pass') return { bucket: 'response_differs', difference: diff('node_passes', checkByReason(reasonOf(script)), null) }
  const s = script as Extract<ValidationOutcome, { kind: 'reject' }>
  const n = node as Extract<ValidationOutcome, { kind: 'reject' }>
  if (reasonOf(s) !== reasonOf(n)) return { bucket: 'response_differs', difference: diff('other_reason', checkByReason(reasonOf(s)), n.check_id, ['body.reason']) }
  const a = { status: s.status, headers: s.headers ?? {}, body: s.body }
  const b = { status: n.status, headers: n.headers ?? {}, body: n.body }
  if (canonical(a) === canonical(b)) return { bucket: 'agree', difference: null }
  return { bucket: 'response_differs', difference: diff('answer', checkByReason(reasonOf(s)), n.check_id, deepDiff(a, b).map((d) => d.path)) }
}
