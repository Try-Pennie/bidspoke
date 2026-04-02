import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'

// Node implementations are added in Phase 1.5.
// Each node type receives the node definition and current execution context,
// and returns its output (or throws on error).

export async function executeNode(
  node: NodeDefinition,
  ctx: ExecutionContext
): Promise<StepExecutionResult> {
  switch (node.type) {
    case 'code':
      throw new Error('Code node not yet implemented (Phase 1.5)')
    case 'filter':
      throw new Error('Filter node not yet implemented (Phase 1.5)')
    case 'branch':
      throw new Error('Branch node not yet implemented (Phase 1.5)')
    case 'response':
      throw new Error('Response node not yet implemented (Phase 1.5)')
    case 'exit':
      return executeExitNode(node, ctx)
    case 'parallel':
      throw new Error('Parallel node not yet implemented (Phase 2.2)')
    case 'partner_bid':
      throw new Error('Partner Bid node not yet implemented (Phase 2.2)')
    case 'integration':
      throw new Error('Integration node not yet implemented (Phase 2.2)')
    case 'transform':
      throw new Error('Transform node not yet implemented (Phase 2.2)')
    case 'bid_evaluation':
      throw new Error('Bid Evaluation node not yet implemented (Phase 2.2)')
    default:
      throw new Error(`Unknown node type: ${(node as NodeDefinition).type}`)
  }
}

function executeExitNode(
  node: NodeDefinition,
  _ctx: ExecutionContext
): StepExecutionResult {
  return {
    output: (node.config.response as unknown) ?? null,
  }
}
