/**
 * Which workflows sell to a partner (#1412, L613): asked by the step id rename
 * impact route (a formula rewrite would break every one of them) and by the
 * buyer profile route (`other_sellers`, the sellers OUTSIDE buyer selection
 * whose wins the buyer's caps do not count, L582).
 *
 * A bid_group, partner_bid, buyer_click_send or buyer_click_check node names
 * its partner by id in its config; the node types whose trait says so
 * (NODE_TRAITS.referencesPartners) are each matched below, which a test
 * enforces. The two click nodes are counted only when the caller asks
 * (`includeClickNodes`): the rename impact route wants every reference, while
 * `other_sellers` must leave them out, because a click buyer's own clicks are
 * exactly what its cap counts, and a check offers rather than sells (#1543). A
 * buyer_select node names none: the decision recorded on #1411 is that a
 * workflow carrying one uses every partner holding an enabled profile priced for
 * that node's population, which the caller supplies as `pricedPartnersByPopulation`
 * from the profile snapshot. A population with no priced set matches nothing,
 * never everything (L72).
 */

export interface WorkflowForFinder {
  id: string
  name: string
  is_active?: boolean | null
  definition: unknown
}

export interface FinderOptions {
  /** Count buyer_select nodes through the priced partner sets. */
  includeBuyerSelect: boolean
  /** Count buyer_click_send and buyer_click_check nodes (#1543). Stated by every caller, never defaulted. */
  includeClickNodes: boolean
  /** Report only active workflows. */
  liveOnly?: boolean
  /**
   * Count ONLY the two click nodes (#1557), for the profile save route, which
   * refuses switching a click buyer to the offer while a live click node names
   * it. A bid_group or partner_bid sells the partner whichever way its profile
   * is sold, so they never block that switch. Requires includeClickNodes.
   */
  clickNodesOnly?: boolean
}

type DefNode = { type?: unknown; config?: Record<string, unknown> | null }

function nodesOf(w: WorkflowForFinder): DefNode[] {
  const def = w.definition as { nodes?: unknown } | null | undefined
  return Array.isArray(def?.nodes) ? (def.nodes as DefNode[]) : []
}

const idsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [])

/**
 * Every partner a bid_group node can call, as the engine calls them
 * (engine/nodes/bid-group.ts, #2137): a tiered group calls the partners of its
 * tiers and never its top level partner_ids, any other mode calls partner_ids,
 * and every mode calls the fallback once nobody wins. Each id once, in order.
 */
export function bidGroupPartnerIds(config: Record<string, unknown> | null | undefined): string[] {
  if (!config) return []
  const members = config.mode === 'tiered'
    ? (Array.isArray(config.tiers) ? config.tiers : []).flatMap((t) => idsOf((t as { partner_ids?: unknown } | null)?.partner_ids))
    : idsOf(config.partner_ids)
  const fallback = typeof config.fallback_partner_id === 'string' && config.fallback_partner_id !== '' ? [config.fallback_partner_id] : []
  return [...new Set([...members, ...fallback])]
}

/** The populations buyer_select nodes across these workflows name, once each. */
export function populationsInUse(workflows: readonly WorkflowForFinder[]): Set<string> {
  const out = new Set<string>()
  for (const w of workflows) {
    for (const n of nodesOf(w)) {
      if (n && n.type === 'buyer_select' && typeof n.config?.population === 'string') out.add(n.config.population)
    }
  }
  return out
}

export function workflowsUsingPartner(
  workflows: readonly WorkflowForFinder[],
  pricedPartnersByPopulation: ReadonlyMap<string, ReadonlySet<string>>,
  options: FinderOptions
): (partnerId: string) => Array<{ id: string; name: string }> {
  const candidates = options.liveOnly ? workflows.filter((w) => w.is_active === true) : workflows
  return (partnerId) => {
    const out: Array<{ id: string; name: string }> = []
    for (const w of candidates) {
      const used = nodesOf(w).some((n) => {
        if (!n || !n.config) return false
        // A click sold buyer's send (#1553) and its offer side check (#1543).
        if (options.includeClickNodes && (n.type === 'buyer_click_send' || n.type === 'buyer_click_check') && n.config.partner_id === partnerId) return true
        if (options.clickNodesOnly) return false
        if (n.type === 'partner_bid' && n.config.partner_id === partnerId) return true
        if (n.type === 'bid_group' && bidGroupPartnerIds(n.config).includes(partnerId)) return true
        if (options.includeBuyerSelect && n.type === 'buyer_select' && typeof n.config.population === 'string') {
          return pricedPartnersByPopulation.get(n.config.population)?.has(partnerId) ?? false
        }
        return false
      })
      if (used) out.push({ id: w.id, name: w.name })
    }
    return out
  }
}
