// Filter node — two-output pass/exit gate (PRD Section 5.1)
// Config: { operation, condition } — see FilterConfigV2 below
// Output: { passed: boolean, _route: 'pass' | 'exit' }
// The engine routes to the edge whose source_handle matches _route.

import type { NodeDefinition, ExecutionContext, StepExecutionResult, ConditionGroup, EdgeCondition } from '../../types'
import { evaluateConditionGroups } from '../graph'

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
  } else if (config.rules?.groups?.length) {
    conditionMet = evaluateConditionGroups(config.rules.groups, config.rules.logic ?? 'AND', ctx)
  }

  // 'continue_if' → pass when condition met; 'end_if' → exit when condition met
  const passed = operation === 'continue_if' ? conditionMet : !conditionMet

  return {
    output: { passed, _route: passed ? 'pass' : 'exit' },
  }
}
