import type { SupabaseClient } from '@supabase/supabase-js'
import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import type { Env } from '../../index'
import { executeFilterNode } from './filter'
import { executeBranchNode } from './branch'
import { executeResponseNode } from './response'
import { executeCodeNode } from './code'
import { executePartnerBidNode } from './partner-bid'
import { executeBidEvaluationNode } from './bid-evaluation'
import { executeTransformNode } from './transform'
import { executeIntegrationNode } from './integration'
import { executeConstantsNode } from './constants'
import { executeSalesforceNode } from './salesforce'

export async function executeNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env,
  supabase?: SupabaseClient
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
    case 'partner_bid':
      if (!supabase) throw new Error('Partner Bid node requires a Supabase client')
      return executePartnerBidNode(node, ctx, env, supabase)
    case 'parallel':
      // Parallel nodes are handled directly in walkGraph before reaching executeNode.
      // If this case is ever hit, it means a parallel node was called outside of walkGraph.
      throw new Error('Parallel node must be executed through walkGraph, not executeNode directly')
    case 'webhook':
      return executeIntegrationNode(node, ctx, env)
    case 'transform':
      return executeTransformNode(node, ctx)
    case 'bid_evaluation':
      return executeBidEvaluationNode(node, ctx, supabase)
    case 'constants':
      if (!supabase) throw new Error('Constants node requires a Supabase client')
      return executeConstantsNode(node, ctx, env, supabase)
    case 'salesforce':
      return executeSalesforceNode(node, ctx, env)
    default:
      throw new Error(`Unknown node type: ${(node as NodeDefinition).type}`)
  }
}

function executeExitNode(node: NodeDefinition): StepExecutionResult {
  return {
    output: (node.config.response as unknown) ?? null,
  }
}
