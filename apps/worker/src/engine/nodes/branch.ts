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
  // tri-state, back-compat with the old use_else boolean:
  //  - 'output' (default): fire an 'else' route
  //  - 'none':  no else handle; walk stops if no branch matches
  //  - 'error': throw a permanent error when no branch matches
  else_behavior?: 'output' | 'none' | 'error'
  use_else?: boolean
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

  const behavior: 'output' | 'none' | 'error' =
    config.else_behavior ?? (config.use_else === false ? 'none' : 'output')

  if (behavior === 'error') {
    const err = new Error(`Branch "${node.namespace}" didn't match any branch (else=error)`)
    ;(err as { permanent?: boolean }).permanent = true
    throw err
  }

  return {
    output: { matched_branch: null, _route: 'else' },
  }
}
