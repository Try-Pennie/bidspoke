import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import type { Env } from '../../index'
import { executeFilterNode } from './filter'
import { executeBranchNode } from './branch'
import { executeResponseNode } from './response'
import { executeCodeNode } from './code'

export async function executeNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env
): Promise<StepExecutionResult> {
  switch (node.type) {
    case 'filter':
      return executeFilterNode(node, ctx)
    case 'branch':
      return executeBranchNode(node, ctx)
    case 'response':
      return executeResponseNode(node, ctx)
    case 'exit':
      return executeExitNode(node)
    case 'code':
      return executeCodeNode(node, ctx, env)
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

function executeExitNode(node: NodeDefinition): StepExecutionResult {
  return {
    output: (node.config.response as unknown) ?? null,
  }
}
