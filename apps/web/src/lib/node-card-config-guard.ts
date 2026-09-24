/**
 * Classifier for the node-card config guard (#645). See the test file for the
 * rule and why it exists.
 */

export interface CardSource {
  card: string
  type: string
  content: string
}

export interface CardConfigViolation {
  card: string
  type: string
  field: string
}

import type { NodeType } from '@/types/workflow'

/** Which worker source files are authoritative for each canvas card's node type. Typed by NodeType (#1411) so a misspelt type is a compile error. */
export const CARD_EXECUTORS: Record<string, { type: NodeType | 'trigger'; sources: string[] }> = {
  'AchieveOffersNode.tsx': { type: 'achieve_offers', sources: ['engine/nodes/achieve-offers.ts'] },
  'BidGroupNode.tsx': { type: 'bid_group', sources: ['engine/nodes/bid-group.ts'] },
  'BuyerSelectNode.tsx': { type: 'buyer_select', sources: ['engine/nodes/buyer-select.ts'] },
  'BuyerClickSendNode.tsx': { type: 'buyer_click_send', sources: ['engine/nodes/buyer-click-send.ts'] },
  'BuyerClickCheckNode.tsx': { type: 'buyer_click_check', sources: ['engine/nodes/buyer-click-check.ts'] },
  'BranchNode.tsx': { type: 'branch', sources: ['engine/nodes/branch.ts'] },
  'CodeNode.tsx': { type: 'code', sources: ['engine/nodes/code.ts'] },
  'ConstantsNode.tsx': { type: 'constants', sources: ['engine/nodes/constants.ts'] },
  'DataStoreNode.tsx': { type: 'data_store', sources: ['engine/nodes/data-store.ts'] },
  'FilterNode.tsx': { type: 'filter', sources: ['engine/nodes/filter.ts'] },
  'IntegrationNode.tsx': { type: 'webhook', sources: ['engine/nodes/integration.ts'] },
  'LatencyGateNode.tsx': { type: 'latency_gate', sources: ['engine/nodes/latency-gate.ts'] },
  'ParallelNode.tsx': { type: 'parallel', sources: ['engine/nodes/parallel.ts'] },
  // No PartnerBidNode: the type is retired and now renders as the generic card
  // (see nodes/registry.tsx), so there is no bespoke card left to make a claim.
  'ResponseNode.tsx': { type: 'response', sources: ['engine/nodes/response.ts'] },
  'SalesforceNode.tsx': { type: 'salesforce', sources: ['engine/nodes/salesforce.ts'] },
  'TransformNode.tsx': { type: 'transform', sources: ['engine/nodes/transform.ts'] },
  // The trigger has no executor: its config is enforced (or not) by the routes
  // that accept the inbound request.
  'TriggerNode.tsx': {
    type: 'trigger',
    sources: ['routes/custom-endpoint.ts', 'routes/webhooks.ts'],
  },
}

/**
 * Config fields a card may display even though the executor never reads them.
 *
 * The bar is narrow, and every entry must argue it: the field has to be a NAME
 * the user authored, not a claim about what the node does or who it talks to. A
 * name cannot be falsified by the engine, so nothing needs to validate it. A
 * description of behaviour (which product we request, which partner we call) can
 * be falsified, and those must be engine-read or they are exactly the #645 trap.
 */
export const DISPLAY_ONLY_FIELDS: Record<string, Record<string, string>> = {
  branch: {
    // The engine routes on the handle id ('else'), never on this text. Renaming
    // the label cannot change which edge is taken, so it cannot lie about routing.
    else_label: 'cosmetic handle text; the engine routes on the handle id, not this string',
  },
  webhook: {
    // The "Service name" the user types for a custom integration (ConfigPanel).
    // It names the node; it does not assert what gets sent, and the URL that IS
    // sent is rendered directly beneath it on the same card.
    service_label: 'user-authored display name for the integration, not a claim about the request',
  },
}

/** Config fields a node card reads in order to render something. */
export function extractDisplayedConfigFields(source: string): string[] {
  const fields = new Set<string>()
  for (const m of source.matchAll(/(?<![.\w])config\.([A-Za-z_][A-Za-z0-9_]*)/g)) fields.add(m[1])
  for (const m of source.matchAll(/(?<![.\w])config\[['"]([^'"]+)['"]\]/g)) fields.add(m[1])
  return [...fields]
}

/** Does this executor source reference the field at all (dot, bracket, or destructured)? */
function executorReadsField(executorSource: string, field: string): boolean {
  return new RegExp(`\\b${field}\\b`).test(executorSource)
}

export function findCardConfigViolations(
  cards: CardSource[],
  executorsByType: Record<string, string>,
  displayOnly: Record<string, Record<string, string>>,
): CardConfigViolation[] {
  const violations: CardConfigViolation[] = []
  for (const card of cards) {
    const executor = executorsByType[card.type] ?? ''
    const allowed = displayOnly[card.type] ?? {}
    for (const field of extractDisplayedConfigFields(card.content)) {
      if (field in allowed) continue
      if (executorReadsField(executor, field)) continue
      violations.push({ card: card.card, type: card.type, field })
    }
  }
  return violations
}
