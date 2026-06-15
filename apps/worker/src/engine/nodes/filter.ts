// Filter node — two-output pass/exit gate (PRD Section 5.1)
// Config: { operation, condition } — see FilterConfigV2 below
// Output: { passed: boolean, _route: 'pass' | 'exit' }
// The engine routes to the edge whose source_handle matches _route.

import type { NodeDefinition, ExecutionContext, StepExecutionResult, ConditionGroup, EdgeCondition, ResolvedStepInput } from '../../types'
import { evaluateConditionGroups, resolveField, hasConfiguredCondition } from '../graph'

// ── Config ────────────────────────────────────────────────────────────────────

// Pipedream-style flat format: single condition + operation direction
interface FilterConfigV2 {
  operation?: 'continue_if' | 'end_if'  // default: 'continue_if'
  condition?: {
    field: string
    operator: EdgeCondition['operator']
    value?: unknown
  }
  // Legacy multi-group format — kept for backward compatibility
  rules?: {
    groups: ConditionGroup[]
    logic: 'AND' | 'OR'
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function executeFilterNode(
  node: NodeDefinition,
  ctx: ExecutionContext
): StepExecutionResult {
  const config = node.config as unknown as FilterConfigV2
  const operation = config.operation ?? 'continue_if'

  // New single-condition format takes priority over legacy rules groups
  let conditionMet = true
  if (config.condition?.field) {
    conditionMet = evaluateConditionGroups(
      [{ conditions: [config.condition as EdgeCondition], logic: 'AND' }],
      'AND',
      ctx
    )
  } else if (config.rules?.groups?.length && hasConfiguredCondition(config.rules.groups)) {
    // Only evaluate a legacy rules set that actually has a field-bearing
    // condition. An empty or half-filled rules group keeps conditionMet=true
    // (pass), matching the "unconfigured filter passes" default — without this
    // the fail-closed empty handling (#93) would flip such a filter to exit.
    conditionMet = evaluateConditionGroups(config.rules.groups, config.rules.logic ?? 'AND', ctx)
  }

  // 'continue_if' → pass when condition met; 'end_if' → exit when condition met
  const passed = operation === 'continue_if' ? conditionMet : !conditionMet

  // Capture the field value the condition actually compared against — the most
  // useful thing to see for a filter that routed unexpectedly.
  const resolved: Record<string, unknown> = { operation, condition_met: conditionMet }
  if (config.condition?.field) {
    resolved.field = config.condition.field
    resolved.field_value = resolveField(config.condition.field, ctx)
    resolved.operator = config.condition.operator
    resolved.compare_value = config.condition.value
  }
  const resolvedInput: ResolvedStepInput = {
    template: { operation, condition: config.condition, rules: config.rules },
    resolved,
  }

  return {
    output: { passed, _route: passed ? 'pass' : 'exit' },
    resolvedInput,
  }
}
