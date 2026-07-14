import type { EdgeCondition } from '@/types/workflow'

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
const OP_LABELS: Partial<Record<EdgeCondition['operator'], string>> = {
  eq: 'equals', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
  contains: 'contains', not_contains: "doesn't contain",
  exists: 'exists', not_exists: "doesn't exist",
}

interface SimpleCondition {
  field?: string
  operator?: EdgeCondition['operator']
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
    OP_LABELS[c.operator ?? 'eq'],
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
