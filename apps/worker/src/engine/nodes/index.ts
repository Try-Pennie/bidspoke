import type { SupabaseClient } from '@supabase/supabase-js'
import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import { assertNever } from '../../types'
import type { Env } from '../../index'
import { executeFilterNode } from './filter'
import { executeBranchNode } from './branch'
import { executeResponseNode } from './response'
import { executeCodeNode } from './code'
import { executePartnerBidNode } from './partner-bid'
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
  supabase?: SupabaseClient,
  // Fires when the step-level timeout elapses; forwarded to every node type that
  // makes an outbound call so the in-flight request is canceled before a retry (#66).
  signal?: AbortSignal,
  // Output of the step the caller's walk just executed in THIS chain. Only
  // branch_end consumes it; see executeBranchEndNode (#489).
  chainOutput?: unknown
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
      return executeCodeNode(node, ctx, env, signal)
    case 'partner_bid':
      if (!supabase) throw new Error('Partner Bid node requires a Supabase client')
      return executePartnerBidNode(node, ctx, env, supabase, signal)
    case 'parallel':
      // Parallel nodes are handled directly in walkGraph before reaching executeNode.
      // If this case is ever hit, it means a parallel node was called outside of walkGraph.
      throw new Error('Parallel node must be executed through walkGraph, not executeNode directly')
    case 'bid_group':
      // Bid Group is handled directly in walkGraph (synthesizes per-partner step rows).
      throw new Error('Bid Group node must be executed through walkGraph, not executeNode directly')
    case 'buyer_select':
      // Buyer selection is handled directly in walkGraph too: one attempt row per buyer tried (#1411).
      throw new Error('Buyer Select node must be executed through walkGraph, not executeNode directly')
    case 'parallel_end':
      throw new Error('Parallel End node must be executed through walkGraph, not executeNode directly')
    case 'branch_end':
      // Passive convergence node — passthrough. The engine routes to whichever
      // path the branch's selected handle led down; once that chain reaches
      // branch_end, this returns the prior step's output and the main walk
      // continues to branch_end's successor.
      return executeBranchEndNode(chainOutput)
    case 'webhook':
      return executeIntegrationNode(node, ctx, env, signal)
    case 'transform':
      return executeTransformNode(node, ctx)
    case 'constants':
      if (!supabase) throw new Error('Constants node requires a Supabase client')
      return executeConstantsNode(node, ctx, env, supabase)
    case 'salesforce':
      return executeSalesforceNode(node, ctx, env, signal)
    case 'data_store':
      return executeDataStoreNode(node, ctx, env)
    case 'latency_gate':
      return executeLatencyGateNode(node, ctx, env, supabase)
    case 'achieve_offers':
      return executeAchieveOffersNode(node, ctx, signal)
    default:
      // Exhaustive over NodeType at compile time (#1411): a type added to
      // @bidspoke/node-types without a case here is a type error on this line,
      // and a definition carrying a type this build never heard of fails loud.
      return assertNever(node.type, 'node type')
  }
}

function executeExitNode(node: NodeDefinition): StepExecutionResult {
  return {
    output: (node.config.response) ?? null,
  }
}

function executeBranchEndNode(chainOutput: unknown): StepExecutionResult {
  // Whichever branch handle's chain led here, that chain's final step output is
  // what we surface. Mirrors how parallel_end inherits the parallel's output,
  // but here we pass through the single winning chain instead of an array of
  // fan-out results.
  //
  // This used to read Object.values(ctx.steps).at(-1). ctx.steps is shared with
  // writers that are not on this chain (a bid_group partner attempt that lost
  // its race keeps running and appends itself whenever it finally settles), so
  // "newest key" was not "my chain's last step" and branch_end could emit some
  // other partner's bid. The caller passes its own walk-local value now (#489).
  return { output: chainOutput ?? null }
}
