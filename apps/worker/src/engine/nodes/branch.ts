// Branch node — N conditional outputs with else edge (PRD Section 5.1)
// Config: { branches: Array<{ label: string, condition: { groups, logic } }> }
// Output: { matched_branch: string | null, _route: string }
// Branches evaluated in order; first match wins. Falls through to _route='else'.
// The engine routes to the edge whose source_handle matches _route.

import type { NodeDefinition, ExecutionContext, StepExecutionResult, ConditionGroup, ResolvedStepInput } from '../../types'
import { evaluateConditionGroups, resolveField } from '../graph'

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

  // Snapshot each condition's actual values so a branch that routed to "else"
  // (or matched the wrong branch) is debuggable without panel-hopping.
  const branchEvaluations = (config.branches ?? []).map((b) => ({
    label: b.label,
    fields: b.condition.groups.flatMap((g) =>
      g.conditions.map((c) => ({
        field: c.field,
        operator: c.operator,
        compare_value: c.value,
        actual: resolveField(c.field, ctx),
      }))
    ),
  }))

  for (const branch of (config.branches ?? [])) {
    if (evaluateConditionGroups(branch.condition.groups, branch.condition.logic ?? 'AND', ctx)) {
      return {
        output: { matched_branch: branch.label, _route: branch.label },
        resolvedInput: makeInput(config, branchEvaluations, branch.label),
      }
    }
  }

  const behavior: 'output' | 'none' | 'error' =
    config.else_behavior ?? (config.use_else === false ? 'none' : 'output')

  if (behavior === 'error') {
    const err = new Error(`Branch "${node.namespace}" didn't match any branch (else=error)`) as Error & { permanent?: boolean; resolvedInput?: ResolvedStepInput }
    err.permanent = true
    err.resolvedInput = makeInput(config, branchEvaluations, null)
    throw err
  }

  return {
    output: { matched_branch: null, _route: 'else' },
    resolvedInput: makeInput(config, branchEvaluations, null),
  }
}

function makeInput(
  config: BranchConfig,
  evaluations: Array<{ label: string; fields: Array<{ field: string; operator: string; compare_value: unknown; actual: unknown }> }>,
  matched: string | null
): ResolvedStepInput {
  return {
    template: { branches: config.branches, else_behavior: config.else_behavior },
    resolved: { matched_branch: matched ?? 'else', evaluations },
  }
}
