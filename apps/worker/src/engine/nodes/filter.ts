// Filter node — two-output pass/exit gate with rule builder (PRD Section 5.1)
// Config: { rules: { groups: ConditionGroup[], logic: 'AND' | 'OR' } }
// Output: { passed: boolean, _route: 'pass' | 'exit' }
// The engine routes to the edge whose source_handle matches _route.

import type { NodeDefinition, ExecutionContext, StepExecutionResult, ConditionGroup } from '../../types'
import { evaluateConditionGroups } from '../graph'

interface FilterConfig {
  rules?: {
    groups: ConditionGroup[]
    logic: 'AND' | 'OR'
  }
}

export function executeFilterNode(
  node: NodeDefinition,
  ctx: ExecutionContext
): StepExecutionResult {
  const config = node.config as FilterConfig
  let passed = true

  if (config.rules?.groups?.length) {
    passed = evaluateConditionGroups(config.rules.groups, config.rules.logic ?? 'AND', ctx)
  }

  return {
    output: { passed, _route: passed ? 'pass' : 'exit' },
  }
}
