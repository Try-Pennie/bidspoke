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
import { executeDataStoreNode } from './data-store'
import { executeLatencyGateNode } from './latency-gate'
import { executeAchieveOffersNode } from './achieve-offers'

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
    case 'bid_group':
      // Bid Group is handled directly in walkGraph (synthesizes per-partner step rows).
      throw new Error('Bid Group node must be executed through walkGraph, not executeNode directly')
    case 'parallel_end':
      throw new Error('Parallel End node must be executed through walkGraph, not executeNode directly')
    case 'branch_end':
      // Passive convergence node — passthrough. The engine routes to whichever
      // path the branch's selected handle led down; once that chain reaches
      // branch_end, this returns the prior step's output and the main walk
      // continues to branch_end's successor.
      return executeBranchEndNode(node, ctx)
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
    case 'data_store':
      return executeDataStoreNode(node, ctx, env)
    case 'latency_gate':
      return executeLatencyGateNode(node, ctx, env, supabase)
    case 'achieve_offers':
      return executeAchieveOffersNode(node, ctx)
    default:
      throw new Error(`Unknown node type: ${(node as NodeDefinition).type}`)
  }
}

function executeExitNode(node: NodeDefinition): StepExecutionResult {
  return {
    output: (node.config.response as unknown) ?? null,
  }
}

function executeBranchEndNode(_node: NodeDefinition, ctx: ExecutionContext): StepExecutionResult {
  // Whichever branch handle's chain led here, the most recent step's output
  // is what we want to surface as branch_end's output. Mirrors how
  // parallel_end inherits the parallel's output, but here we pass through
  // the single winning chain instead of an array of fan-out results.
  const lastStep = Object.values(ctx.steps).at(-1)
  return { output: lastStep?.output ?? null }
}
