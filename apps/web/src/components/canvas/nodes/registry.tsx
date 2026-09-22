import type { NodeTypes } from '@xyflow/react'
import type { NodeType } from '@/types/workflow'

import { FilterNode } from './FilterNode'
import { BranchNode } from './BranchNode'
import { BranchEndNode } from './BranchEndNode'
import { CodeNode } from './CodeNode'
import { ResponseNode } from './ResponseNode'
import { ExitNode } from './ExitNode'
import { TriggerNode } from './TriggerNode'
import { GenericNode } from './GenericNode'
import { BidGroupNode } from './BidGroupNode'
import { TransformNode } from './TransformNode'
import { IntegrationNode } from './IntegrationNode'
import { ParallelNode } from './ParallelNode'
import { ParallelEndNode } from './ParallelEndNode'
import { ConstantsNode } from './ConstantsNode'
import { SalesforceNode } from './SalesforceNode'
import { DataStoreNode } from './DataStoreNode'
import { LatencyGateNode } from './LatencyGateNode'
import { AchieveOffersNode } from './AchieveOffersNode'
import { BuyerSelectNode } from './BuyerSelectNode'
import { RegionNode } from './RegionNode'
import { withNodeBadges } from './withNodeBadges'

/**
 * Source registry. Every node type a saved definition can contain MUST be listed
 * here (enforced against NODE_TYPES in registry.test.ts): a type with no entry
 * renders as a broken node and can take the canvas down.
 *
 * It is also the single chokepoint where the corner badges are attached, since
 * withNodeBadges wraps every entry below. A newly added node type gets the
 * timeout warning, success, note and unconfigured badges with no per-card wiring.
 */
const baseNodeTypesInternal = {
  trigger: TriggerNode,
  filter: FilterNode,
  branch: BranchNode,
  branch_end: BranchEndNode,
  code: CodeNode,
  response: ResponseNode,
  exit: ExitNode,
  webhook: IntegrationNode,
  // Retired (#645). Bid Group replaced it and fans out to partners internally,
  // and it was hidden from the palette in 2931b59, so no workflow (and no saved
  // version) contains one. Its bespoke card is gone: it printed a partner name
  // copied into config that the engine never read, so a rename left it asserting
  // a name that was no longer true, and nobody could see it because nothing
  // renders it. The type still resolves to the generic card because the engine
  // still executes it and the format still permits it.
  partner_bid: GenericNode,
  transform: TransformNode,
  parallel: ParallelNode,
  parallel_end: ParallelEndNode,
  bid_group: BidGroupNode,
  constants: ConstantsNode,
  salesforce: SalesforceNode,
  data_store: DataStoreNode,
  latency_gate: LatencyGateNode,
  achieve_offers: AchieveOffersNode,
  buyer_select: BuyerSelectNode,
  region: RegionNode,
  // `satisfies` over every NodeType plus the two canvas only entries (#1411):
  // a type added to @bidspoke/node-types with no card here is a compile error,
  // while each entry keeps its own component type.
} satisfies Record<NodeType | 'trigger' | 'region', unknown>

export const baseNodeTypes: Record<string, (typeof baseNodeTypesInternal)[keyof typeof baseNodeTypesInternal]> =
  baseNodeTypesInternal

/**
 * The registry the canvas actually renders with. Also imported by the dev
 * node-state preview page (/dev/nodes) so it draws nodes through the exact same
 * registry and badge HOC the canvas uses (#227).
 */
export const nodeTypes: NodeTypes = Object.fromEntries(
  Object.entries(baseNodeTypesInternal).map(([type, Component]) => [type, withNodeBadges(Component)]),
)
