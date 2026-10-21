/**
 * Single source of truth for "what condition is this filter actually gating on"
 * (#645), shared by the Filter card and the workflow validation pass.
 *
 * The engine (apps/worker/src/engine/nodes/filter.ts) evaluates two shapes, in
 * this order: the simple `config.condition`, then the legacy rule-builder
 * `config.rules.groups` (but only when a group carries a real field: an empty
 * group passes everything, so the engine treats it as unconfigured).
 *
 * The card and the validator both knew only the simple shape. A filter built
 * with the rule builder therefore rendered "No condition set" and was flagged as
 * an unconfigured node, while it was gating live traffic. Mirror the engine's
 * precedence here, once, so the two surfaces cannot drift from it again.
 */
import { CONDITION_OPERATORS, CONDITION_OPERATOR_SPECS } from './condition-operators'

// The card names an operator in the rule builder dropdown's own words, one
// vocabulary for both (Dan, 2026-10-21, docs/design/lead-validation-node.html
// D9 and D10), so the labels are CONDITION_OPERATOR_SPECS' and never a copy. A Map, not a
// plain object, because the operator comes from stored config: a bracket lookup
// on an object finds inherited members like `constructor` or `toString` for those
// keys and returns a truthy value, so the summary would show one instead of no
// label (L738). A missing key yields undefined.
const OP_LABELS = new Map<string, string>(
  CONDITION_OPERATORS.map((op) => [op, CONDITION_OPERATOR_SPECS[op].label]),
)

interface SimpleCondition {
  field?: string
  operator?: string
  value?: unknown
}

interface RuleGroups {
  groups?: Array<{ conditions?: SimpleCondition[] }>
}

function simpleCondition(config: Record<string, unknown>): SimpleCondition | null {
  const c = config.condition as SimpleCondition | undefined
  return c?.field?.trim() ? c : null
}

/** Field-bearing conditions in the rule-builder shape. Mirrors hasConfiguredCondition in filter.ts. */
function ruleConditions(config: Record<string, unknown>): SimpleCondition[] {
  const rules = config.rules as RuleGroups | undefined
  return (rules?.groups ?? [])
    .flatMap((g) => g.conditions ?? [])
    .filter((c) => c.field?.trim())
}

function describe(c: SimpleCondition): string {
  return [
    c.field,
    OP_LABELS.get(c.operator ?? 'eq'),
    // c.value is a user-entered filter value shown in a one-line summary; it is a
    // scalar in practice, so its default stringification is what we want here.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    c.value !== undefined && c.value !== '' ? String(c.value) : undefined,
  ]
    .filter(Boolean)
    .join(' ')
}

/** True when the engine would actually gate on this filter's config. */
export function filterHasCondition(config: Record<string, unknown>): boolean {
  return simpleCondition(config) !== null || ruleConditions(config).length > 0
}

/** One-line summary for the card, or null when there is genuinely no condition. */
export function filterConditionSummary(config: Record<string, unknown>): string | null {
  const simple = simpleCondition(config)
  if (simple) return describe(simple)

  const conditions = ruleConditions(config)
  if (conditions.length === 0) return null
  if (conditions.length === 1) return describe(conditions[0])
  return `${conditions.length} conditions`
}
