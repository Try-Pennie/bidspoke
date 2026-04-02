// Branch node — N conditional outputs with else edge (PRD Section 5.1)
// Config: { branches: Array<{ label: string, condition: { groups, logic } }> }
// Output: { matched_branch: string | null, _route: string }
// Branches evaluated in order; first match wins. Falls through to _route='else'.
// The engine routes to the edge whose source_handle matches _route.

import type { NodeDefinition, ExecutionContext, StepExecutionResult, ConditionGroup } from '../../types'
import { evaluateConditionGroups } from '../graph'

interface BranchEntry {
  label: string
  condition: {
    groups: ConditionGroup[]
    logic: 'AND' | 'OR'
  }
}

interface BranchConfig {
  branches?: BranchEntry[]
}

export function executeBranchNode(
  node: NodeDefinition,
  ctx: ExecutionContext
): StepExecutionResult {
  const config = node.config as BranchConfig

  for (const branch of (config.branches ?? [])) {
    if (evaluateConditionGroups(branch.condition.groups, branch.condition.logic ?? 'AND', ctx)) {
      return {
        output: { matched_branch: branch.label, _route: branch.label },
      }
    }
  }

  return {
    output: { matched_branch: null, _route: 'else' },
  }
}
