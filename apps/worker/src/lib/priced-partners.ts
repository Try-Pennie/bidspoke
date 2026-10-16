/**
 * The partners each buyer_select population sells to, for the workflow finder
 * (partner-workflow-finder.ts), which a buyer_select node names no partner for:
 * the decision recorded on #1411 is that a workflow carrying one uses every
 * partner holding an enabled profile priced for that node's population.
 *
 * Shared by the step rename impact route and the partner delete check (#2140),
 * so both read the snapshot the same way (L613). The snapshot is read only when
 * some workflow carries a buyer_select node, and a failed read throws, so the
 * caller refuses its whole answer rather than reporting a partner as unused (L98).
 */
import { populationsInUse, type WorkflowForFinder } from './partner-workflow-finder'
import { partnersPricedFor, type BuyerProfilesSnapshot } from './buyer-profile-loader'

export async function pricedPartnersByPopulation(
  workflows: readonly WorkflowForFinder[],
  loadSnapshot: () => Promise<BuyerProfilesSnapshot>
): Promise<Map<string, Set<string>>> {
  const populations = populationsInUse(workflows)
  const out = new Map<string, Set<string>>()
  if (populations.size === 0) return out
  const snapshot = await loadSnapshot()
  for (const population of populations) out.set(population, new Set(partnersPricedFor(snapshot, population)))
  return out
}
