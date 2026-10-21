import type { SupabaseClient } from '@supabase/supabase-js'
import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import { assertNever } from '../../types'
import type { NodeType } from '../../types'
import { isNodeType, nodeTypesForLane, type WorkflowLane } from '@bidspoke/node-types'
import { LaneRefusedNodeError } from '../lane'

export { LaneRefusedNodeError }
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
import { executeLeadValidationNode } from './lead-validation'

/** Everything an executor may need; each one reads only what it uses. */
interface ExecutorArgs {
  node: NodeDefinition
  ctx: ExecutionContext
  env: Env
  supabase?: SupabaseClient
  signal?: AbortSignal
  chainOutput?: unknown
}

type NodeExecutor = (args: ExecutorArgs) => Promise<StepExecutionResult> | StepExecutionResult

const walkGraphOnly = (message: string): NodeExecutor => () => {
  throw new Error(message)
}

/**
 * One executor per node type (#1707, plan 0.C). A Record over NodeType, so a
 * type added to @bidspoke/node-types without an executor here is a compile
 * error, as the switch's assertNever was before.
 */
const EXECUTORS: Record<NodeType, NodeExecutor> = {
  filter: ({ node, ctx }) => executeFilterNode(node, ctx),
  branch: ({ node, ctx }) => executeBranchNode(node, ctx),
  response: ({ node, ctx }) => executeResponseNode(node, ctx),
  exit: ({ node }) => executeExitNode(node),
  code: ({ node, ctx, env, signal }) => executeCodeNode(node, ctx, env, signal),
  partner_bid: ({ node, ctx, env, supabase, signal }) => {
    if (!supabase) throw new Error('Partner Bid node requires a Supabase client')
    return executePartnerBidNode(node, ctx, env, supabase, signal)
  },
  // Parallel nodes are handled directly in walkGraph before reaching executeNode.
  // If this is ever hit, a parallel node was called outside of walkGraph.
  parallel: walkGraphOnly('Parallel node must be executed through walkGraph, not executeNode directly'),
  // Bid Group is handled directly in walkGraph (synthesizes per-partner step rows).
  bid_group: walkGraphOnly('Bid Group node must be executed through walkGraph, not executeNode directly'),
  // Buyer selection is handled directly in walkGraph too: one attempt row per buyer tried (#1411).
  buyer_select: walkGraphOnly('Buyer Select node must be executed through walkGraph, not executeNode directly'),
  // Run once by walkGraph and never retried: a retried click is a duplicate send (#1542).
  buyer_click_send: walkGraphOnly('Buyer Click Send node must be executed through walkGraph, not executeNode directly'),
  // Run once by walkGraph under its own budget, never retried (#1543).
  buyer_click_check: walkGraphOnly('Buyer Click Check node must be executed through walkGraph, not executeNode directly'),
  parallel_end: walkGraphOnly('Parallel End node must be executed through walkGraph, not executeNode directly'),
  // Passive convergence node: passthrough. The engine routes to whichever path
  // the branch's selected handle led down; once that chain reaches branch_end,
  // this returns the prior step's output and the main walk continues to
  // branch_end's successor.
  branch_end: ({ chainOutput }) => executeBranchEndNode(chainOutput),
  webhook: ({ node, ctx, env, signal }) => executeIntegrationNode(node, ctx, env, signal),
  transform: ({ node, ctx }) => executeTransformNode(node, ctx),
  constants: ({ node, ctx, env, supabase }) => {
    if (!supabase) throw new Error('Constants node requires a Supabase client')
    return executeConstantsNode(node, ctx, env, supabase)
  },
  salesforce: ({ node, ctx, env, signal }) => executeSalesforceNode(node, ctx, env, signal),
  data_store: ({ node, ctx, env }) => executeDataStoreNode(node, ctx, env),
  latency_gate: ({ node, ctx, env, supabase }) => executeLatencyGateNode(node, ctx, env, supabase),
  achieve_offers: ({ node, ctx, signal }) => executeAchieveOffersNode(node, ctx, signal),
  lead_validation: ({ node, ctx }) => executeLeadValidationNode(node, ctx),
}

/** The registry for one lane: a filter on EXECUTORS by each type's lane trait. */
function registryForLane(lane: WorkflowLane): Partial<Record<NodeType, NodeExecutor>> {
  const out: Partial<Record<NodeType, NodeExecutor>> = {}
  for (const type of nodeTypesForLane(lane)) out[type] = EXECUTORS[type]
  return out
}

/** The node types a lane's registry can run. */
export function executorTypesForLane(lane: WorkflowLane): NodeType[] {
  return Object.keys(registryForLane(lane)) as NodeType[]
}

export type ExecuteNode = (
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
) => Promise<StepExecutionResult>

/**
 * The node executor for one lane. A type outside the lane's registry is refused
 * by name; a type this build has never heard of fails loud, as assertNever did.
 */
export function createNodeExecutor(lane: WorkflowLane): ExecuteNode {
  const registry = registryForLane(lane)
  return async (node, ctx, env, supabase, signal, chainOutput) => {
    if (!isNodeType(node.type)) return assertNever(node.type, 'node type')
    const executor = registry[node.type]
    if (!executor) throw new LaneRefusedNodeError(node.type, lane)
    return executor({ node, ctx, env, supabase, signal, chainOutput })
  }
}

/** The bidding Worker's executor: the money lane runs every node type. */
export const executeNode: ExecuteNode = createNodeExecutor('money')

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
