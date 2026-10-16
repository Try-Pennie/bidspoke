/**
 * Which workflow steps name a partner, per node kind (#2137), for the partners
 * page: a Bid Group or Partner Bid step makes the Bid Group tab apply, and a
 * Latency Gate makes the confirmation window apply. Each kind is answered from
 * its own predicate, because each names its partner its own way: a bid_group
 * through the partners it can call (bidGroupPartnerIds, the engine's own
 * reading), a partner_bid and a latency_gate through `config.partner_id`.
 *
 * Every workflow handed in counts, drafts and switched off ones included: a
 * workflow switched on again calls the partner at once, so a setting it reads
 * applies now. Pure; the route reads the organization's workflows through
 * readOrgWorkflows, which is what scopes them.
 */
import type { OrgWorkflow } from './org-workflows'
import { bidGroupPartnerIds } from './partner-workflow-finder'

export interface UsageStep {
  workflow_id: string
  workflow_name: string
  is_active: boolean
  node_id: string | null
}

export interface BidGroupUsage extends UsageStep {
  /** The group's mode as the engine reads it (absent means highest_bid). */
  mode: 'highest_bid' | 'cascade' | 'tiered'
  /** The partners the group asks on every lead (a tiered group's from its tiers), in the order it names them. */
  partner_ids: string[]
  /** The partner asked only once nobody wins, or null. */
  fallback_partner_id: string | null
}

export interface PartnerUsage {
  bid_group: BidGroupUsage[]
  partner_bid: UsageStep[]
  latency_gate: UsageStep[]
}

type DefNode = { id?: unknown; type?: unknown; config?: Record<string, unknown> | null }

const nodesOf = (w: OrgWorkflow): DefNode[] => {
  const def = w.definition as { nodes?: unknown } | null | undefined
  return Array.isArray(def?.nodes) ? (def.nodes as DefNode[]).filter((n): n is DefNode => typeof n === 'object' && n !== null) : []
}

const modeOf = (config: Record<string, unknown>): BidGroupUsage['mode'] =>
  config.mode === 'cascade' || config.mode === 'tiered' ? config.mode : 'highest_bid'

export function partnerUsage(workflows: readonly OrgWorkflow[], partnerId: string): PartnerUsage {
  const out: PartnerUsage = { bid_group: [], partner_bid: [], latency_gate: [] }
  for (const w of workflows) {
    for (const n of nodesOf(w)) {
      const config = n.config
      if (!config) continue
      const step: UsageStep = { workflow_id: w.id, workflow_name: w.name, is_active: w.is_active, node_id: typeof n.id === 'string' ? n.id : null }
      if (n.type === 'bid_group') {
        if (bidGroupPartnerIds(config).includes(partnerId)) {
          const fallback = typeof config.fallback_partner_id === 'string' && config.fallback_partner_id !== '' ? config.fallback_partner_id : null
          out.bid_group.push({ ...step, mode: modeOf(config), partner_ids: bidGroupPartnerIds({ ...config, fallback_partner_id: null }), fallback_partner_id: fallback })
        }
      } else if (n.type === 'partner_bid' && config.partner_id === partnerId) {
        out.partner_bid.push(step)
      } else if (n.type === 'latency_gate' && config.partner_id === partnerId) {
        out.latency_gate.push(step)
      }
    }
  }
  return out
}
