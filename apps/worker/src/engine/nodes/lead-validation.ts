// Lead validation node (#2589, part of #934): an ordered list of checks a lead
// must pass, each with the reason a partner is told when it does not.
//
// Config: LeadValidationConfig in packages/workflow-definition (lead-validation.ts),
// parsed by the same function the save route refuses with.
// Output: { valid: true } (plus `passed_unjudged` when a check let a lead through
// for want of a value), or { valid: false, check_id, field, reason, cause? }.
// A rejection answers through `earlyResponse` exactly as the validate scripts'
// code sentinel did: status 200, the configured headers, and
// { lead_id, status: 'rejected', reason }, ending the walk. A check with
// `include_request_id` adds `requestId`, the run's trace id, after `reason` (#2594).
//
// Why it does not call evaluateConditionGroups: that returns a plain boolean,
// reads a missing value as false, turns '' and null into 0 in a number compare
// and drops blank rows. Here each condition is judged three ways, pass, fail, or
// unevaluable with a cause, and the check decides what an unevaluable LEAD value
// does. A missing CONFIGURATION value (a Constants key, an env value) is the
// workflow's fault, the same on every lead, so it is found before any check runs,
// fails the run as a named fault whose per run page is suppressed, and is paged
// once per incident by the engine (lib/lead-validation-config-alert.ts).
//
// The output and the logged input carry the check id and the field path only,
// never a value compared: the lead's values are PII and the step row is kept.

import {
  CONDITION_OPERATOR_SPECS,
  isConditionValueReference,
  isLeadValidationConfigReference,
  isNumericLiteral,
  parseLeadValidationConfig,
  type LeadValidationCheck,
  type LeadValidationCondition,
  type LeadValidationConfig,
  type LeadValidationLogic,
} from '@bidspoke/workflow-definition'
import { assertNever } from '@bidspoke/node-types'
import type { ExecutionContext, NodeDefinition, ResolvedStepInput, StepExecutionResult } from '../../types'
import { coerceString } from '../../lib/coerce'
import { hasLetter, notBlank, resolveField, valuesEqual } from '../graph'

/** Why a configuration value cannot be used. `config_invalid` is a stored config the parser refuses. */
export type ConfigFaultProblem = 'missing' | 'not_a_number' | 'not_a_list' | 'config_invalid'

export interface ConfigFault {
  /** The check reading it, or null for a fault in the config as a whole. */
  check_id: string | null
  /** The reference, or null for a fault in the config as a whole. */
  reference: string | null
  problem: ConfigFaultProblem
  /** The parser's words, for `config_invalid`. */
  detail?: string
}

/** What the engine is told about one lead validation step (ctx.reportLeadValidation). */
export type LeadValidationEvent =
  | { kind: 'evaluated'; namespace: string }
  | { kind: 'config_fault'; namespace: string; faults: ConfigFault[] }

/** What each setting fault says about the setting: the one wording the failure message and the page share. */
export const CONFIG_FAULT_WORDS: Record<Exclude<ConfigFaultProblem, 'config_invalid'>, string> = {
  missing: 'is missing',
  not_a_number: 'is not a number',
  not_a_list: 'is not a list',
}

function describeFault(f: ConfigFault): string {
  if (f.problem === 'config_invalid') return `the node config is not runnable: ${f.detail ?? 'unreadable'}`
  return `check ${f.check_id ?? '?'} reads ${f.reference ?? '?'}, which ${CONFIG_FAULT_WORDS[f.problem]}`
}

/**
 * A configuration value a check reads is missing or unusable. Permanent (no
 * retry can make it appear) and its per run page suppressed: the engine pages it
 * once per incident instead, through the incident signal, never once per lead.
 */
export class LeadValidationConfigFault extends Error {
  readonly permanent = true
  readonly suppressAlert = true
  constructor(
    readonly namespace: string,
    readonly faults: ConfigFault[],
  ) {
    super(`Lead validation setting missing: ${faults.map(describeFault).join('; ')}`)
    this.name = 'LeadValidationConfigFault'
  }
}

/** Why a lead's value could not be judged. */
export type UnevaluableCause = 'missing' | 'not_a_number' | 'not_a_list'

/** The same words a setting fault uses: a lead value and a setting fail to be read the same three ways. */
const CAUSE_WORDS: Record<UnevaluableCause, string> = CONFIG_FAULT_WORDS

/**
 * A check set to fail the run met a lead it could not judge. Permanent, and
 * paged per run like any failure: the author chose to be told about each one.
 */
export class LeadValidationMissingValue extends Error {
  readonly permanent = true
  constructor(
    readonly checkId: string,
    readonly field: string,
    readonly cause: UnevaluableCause,
  ) {
    super(`Lead validation check ${checkId} could not be judged: ${field} ${CAUSE_WORDS[cause]}`)
    this.name = 'LeadValidationMissingValue'
  }
}

type Verdict =
  | { kind: 'pass' }
  | { kind: 'fail'; field: string }
  | { kind: 'unevaluable'; field: string; cause: UnevaluableCause }

const isAbsent = (v: unknown): boolean => v === undefined || v === null

/** A lead value a number comparison can read: a finite number, or text that is one. Never '' or a boolean as 0 or 1. */
function asNumber(v: unknown): number | null {
  return isNumericLiteral(v) ? Number(v) : null
}

/** The operators that judge presence themselves, so a missing value is their input rather than unevaluable. */
const PRESENCE_OPERATORS: ReadonlySet<string> = new Set(['exists', 'not_exists', 'is_null', 'is_not_null'])

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Every configuration value the checks read, resolved before any check runs, so
 * a fault is the same whichever lead arrives (an earlier rejection cannot hide
 * it) and evaluation never meets one.
 */
function configFaults(config: LeadValidationConfig, ctx: ExecutionContext, constants: ReadonlySet<string>): ConfigFault[] {
  const faults: ConfigFault[] = []
  const isConfig = (path: string) => isLeadValidationConfigReference(path, constants)
  for (const check of config.checks) {
    for (const group of check.condition.groups) {
      for (const c of group.conditions) {
        const kind = CONDITION_OPERATOR_SPECS[c.operator].valueKind
        if (isConfig(c.field)) {
          const v = resolveField(c.field, ctx)
          if (isAbsent(v)) faults.push({ check_id: check.id, reference: c.field, problem: 'missing' })
          else if (kind === 'number' && asNumber(v) === null) faults.push({ check_id: check.id, reference: c.field, problem: 'not_a_number' })
        }
        if ((kind === 'number' || kind === 'list') && isConditionValueReference(c.value) && isConfig(c.value)) {
          const v = resolveField(c.value, ctx)
          if (isAbsent(v)) faults.push({ check_id: check.id, reference: c.value, problem: 'missing' })
          else if (kind === 'number' && asNumber(v) === null) faults.push({ check_id: check.id, reference: c.value, problem: 'not_a_number' })
          else if (kind === 'list' && !Array.isArray(v)) faults.push({ check_id: check.id, reference: c.value, problem: 'not_a_list' })
        }
      }
    }
  }
  return faults
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/** The value side: a literal as written, or a reference resolved (a missing lead reference is unevaluable). */
function valueSide(c: LeadValidationCondition, ctx: ExecutionContext): { ok: true; value: unknown } | { ok: false; cause: UnevaluableCause } {
  if (!isConditionValueReference(c.value)) return { ok: true, value: c.value }
  const v = resolveField(c.value, ctx)
  return isAbsent(v) ? { ok: false, cause: 'missing' } : { ok: true, value: v }
}

function judgeCondition(c: LeadValidationCondition, ctx: ExecutionContext): Verdict {
  const actual = resolveField(c.field, ctx)
  const op = c.operator
  const verdict = (passed: boolean): Verdict => (passed ? { kind: 'pass' } : { kind: 'fail', field: c.field })
  const unevaluable = (cause: UnevaluableCause): Verdict => ({ kind: 'unevaluable', field: c.field, cause })

  if (!PRESENCE_OPERATORS.has(op) && isAbsent(actual)) return unevaluable('missing')

  // Exhaustive over the shared operator list: an operator added there without a
  // case here fails to compile (#2588).
  switch (op) {
    case 'exists': return verdict(!isAbsent(actual))
    case 'not_exists': return verdict(isAbsent(actual))
    case 'is_null': return verdict(actual === null)
    case 'is_not_null': return verdict(actual !== null)
    case 'is_true': return verdict(actual === true)
    case 'is_false': return verdict(actual === false)
    case 'has_letter': return verdict(hasLetter(actual))
    case 'not_blank': return verdict(notBlank(actual))
    case 'eq': return verdict(valuesEqual(actual, c.value))
    case 'neq': return verdict(!valuesEqual(actual, c.value))
    case 'contains': return verdict(coerceString(actual).includes(coerceString(c.value)))
    case 'not_contains': return verdict(!coerceString(actual).includes(coerceString(c.value)))
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(actual)
      if (a === null) return unevaluable('not_a_number')
      const side = valueSide(c, ctx)
      if (!side.ok) return { kind: 'unevaluable', field: c.value as string, cause: side.cause }
      const b = asNumber(side.value)
      if (b === null) return { kind: 'unevaluable', field: c.value as string, cause: 'not_a_number' }
      if (op === 'gt') return verdict(a > b)
      if (op === 'gte') return verdict(a >= b)
      if (op === 'lt') return verdict(a < b)
      return verdict(a <= b)
    }
    case 'in_array':
    case 'not_in_array': {
      const side = valueSide(c, ctx)
      if (!side.ok) return { kind: 'unevaluable', field: c.value as string, cause: side.cause }
      if (!Array.isArray(side.value)) return { kind: 'unevaluable', field: c.value as string, cause: 'not_a_list' }
      const found = side.value.some((el) => valuesEqual(actual, el))
      return verdict(op === 'in_array' ? found : !found)
    }
    default:
      return assertNever(op, 'condition operator')
  }
}

/**
 * Three valued AND and OR. AND: any fail fails (the first), else any
 * unevaluable is unevaluable (the first), else pass. OR: any pass passes, else
 * any unevaluable is unevaluable, else the first fail. So a lead that plainly
 * fails is rejected for its reason whatever else it lacks, and a lead the check
 * cannot judge is left to the check's own choice.
 */
function combine(verdicts: Verdict[], logic: LeadValidationLogic): Verdict {
  const firstFail = verdicts.find((v) => v.kind === 'fail')
  const firstUnevaluable = verdicts.find((v) => v.kind === 'unevaluable')
  if (logic === 'AND') return firstFail ?? firstUnevaluable ?? { kind: 'pass' }
  if (verdicts.some((v) => v.kind === 'pass')) return { kind: 'pass' }
  return firstUnevaluable ?? firstFail ?? { kind: 'pass' }
}

function judgeCheck(check: LeadValidationCheck, ctx: ExecutionContext): Verdict {
  const groups = check.condition.groups.map((g) => combine(g.conditions.map((c) => judgeCondition(c, ctx)), g.logic))
  return combine(groups, check.condition.logic)
}

// ── Executor ──────────────────────────────────────────────────────────────────

/**
 * The run's trace id, read where a code node's script reads `execution.trace_id`
 * (the `execution` block code.ts hands the sandbox), so a check answering
 * `requestId` sends what the script it replaces sent.
 */
function runTraceId(ctx: ExecutionContext): string {
  return (ctx.execution ?? { trace_id: ctx.trigger.trace_id }).trace_id
}

export function executeLeadValidationNode(node: NodeDefinition, ctx: ExecutionContext): StepExecutionResult {
  const constants = ctx.constantsNamespaces
  if (!constants) {
    // Every engine run sets it (walkGraph). Without it a Constants value would be
    // read as the lead's, so a missing setting would reject leads in silence.
    throw Object.assign(new Error('Lead validation needs the workflow\'s Constants steps, which this run did not provide'), { permanent: true })
  }

  const parsed = parseLeadValidationConfig(node.config)
  if (!parsed.ok) {
    const faults: ConfigFault[] = parsed.problems.map((detail) => ({ check_id: null, reference: null, problem: 'config_invalid', detail }))
    ctx.reportLeadValidation?.({ kind: 'config_fault', namespace: node.namespace, faults })
    throw new LeadValidationConfigFault(node.namespace, faults)
  }
  const config = parsed.config

  const faults = configFaults(config, ctx, constants)
  if (faults.length > 0) {
    ctx.reportLeadValidation?.({ kind: 'config_fault', namespace: node.namespace, faults })
    throw new LeadValidationConfigFault(node.namespace, faults)
  }
  // The configuration read whole: the evidence an open incident is over.
  ctx.reportLeadValidation?.({ kind: 'evaluated', namespace: node.namespace })

  const template = { lead_id_field: config.lead_id_field, checks: config.checks.map((c) => ({ id: c.id, reason: c.reason, on_missing: c.on_missing })) }
  const passedUnjudged: Array<{ check_id: string; field: string; cause: UnevaluableCause }> = []

  for (const check of config.checks) {
    const verdict = judgeCheck(check, ctx)
    if (verdict.kind === 'pass') continue
    if (verdict.kind === 'unevaluable') {
      if (check.on_missing === 'pass') {
        passedUnjudged.push({ check_id: check.id, field: verdict.field, cause: verdict.cause })
        continue
      }
      if (check.on_missing === 'fail_run') throw new LeadValidationMissingValue(check.id, verdict.field, verdict.cause)
    }
    const output = {
      valid: false as const,
      check_id: check.id,
      field: verdict.field,
      reason: check.reason,
      ...(verdict.kind === 'unevaluable' ? { cause: verdict.cause } : {}),
    }
    const headers = Object.keys(config.response_headers).length > 0 ? { ...config.response_headers } : undefined
    const resolvedInput: ResolvedStepInput = { template, resolved: { outcome: 'rejected', check_id: check.id, field: verdict.field } }
    return {
      output,
      earlyResponse: {
        status: 200,
        ...(headers ? { headers } : {}),
        // requestId last, as Lead Economy's script wrote it: the source reads JSON
        // text, so the key order is part of the answer (#2594).
        body: {
          lead_id: resolveField(config.lead_id_field, ctx),
          status: 'rejected',
          reason: check.reason,
          ...(check.include_request_id ? { requestId: runTraceId(ctx) } : {}),
        },
      },
      resolvedInput,
    }
  }

  const output = passedUnjudged.length > 0 ? { valid: true as const, passed_unjudged: passedUnjudged } : { valid: true as const }
  return { output, resolvedInput: { template, resolved: { outcome: 'passed' } } }
}
