/**
 * Which workflows sell to a partner (#1412, L613): asked by the step id rename
 * impact route (a formula rewrite would break every one of them) and by the
 * buyer profile route (`other_sellers`, the sellers OUTSIDE buyer selection
 * whose wins the buyer's caps do not count, L582).
 *
 * A bid_group, partner_bid or buyer_click_send node names its partner by id in
 * its config; the node types whose trait says so (NODE_TRAITS.referencesPartners)
 * are each matched below, which a test enforces. A
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
  /** Report only active workflows. */
  liveOnly?: boolean
}

type DefNode = { type?: unknown; config?: Record<string, unknown> | null }

function nodesOf(w: WorkflowForFinder): DefNode[] {
  const def = w.definition as { nodes?: unknown } | null | undefined
  return Array.isArray(def?.nodes) ? (def.nodes as DefNode[]) : []
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
        if (n.type === 'partner_bid' && n.config.partner_id === partnerId) return true
        // A click sold buyer's send (#1553): a seller in its own right, so counted whatever the caller says about buyer_select.
        if (n.type === 'buyer_click_send' && n.config.partner_id === partnerId) return true
        if (n.type === 'bid_group') {
          const ids = n.config.partner_ids
          if (Array.isArray(ids) && ids.includes(partnerId)) return true
          if (n.config.fallback_partner_id === partnerId) return true
        }
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
