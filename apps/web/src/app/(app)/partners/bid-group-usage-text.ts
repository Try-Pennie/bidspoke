/**
 * The Bid Group tab's first row (#2137), worded as the settled design words it
 * ("Bids in": the workflows, then who is asked and which bid wins), from the
 * usage read. Pure, so every wording is tested.
 */
import type { PartnerUsage } from '@/lib/api'

/** A, B and C. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const workflowLabel = (s: { workflow_name: string; is_active: boolean }) => (s.is_active ? s.workflow_name : `${s.workflow_name} (switched off)`)

function askedSentence(mode: PartnerUsage['bid_group'][number]['mode'], partners: readonly string[]): string {
  const who = joinNames(partners)
  if (mode === 'cascade') {
    return partners.length === 1 ? `On each lead, ${who} is asked for a bid.` : `On each lead, ${partners.join(', then ')} are asked in turn, and the first bid wins.`
  }
  if (mode === 'tiered') return `On each lead, its tiers are asked in turn until one has a winner; ${who} ${partners.length === 1 ? 'is' : 'are'} in them.`
  if (partners.length === 1) return `On each lead, ${who} is asked for a bid.`
  return `On each lead, ${who} are ${partners.length === 2 ? 'both' : 'all'} asked for a bid, and the ${partners.length === 2 ? 'higher' : 'highest'} bid wins.`
}

/**
 * One sentence per distinct Bid Group (the same mode and partners read as one,
 * so Main Flow and its copy are named together), then one for the Partner Bid
 * steps. `names` maps a partner id to its name; an id not on the list is said
 * as such rather than shown as an id.
 */
export function bidsInSentences(usage: PartnerUsage, names: ReadonlyMap<string, string>): string[] {
  const nameOf = (id: string) => names.get(id) ?? 'a partner not on this list'
  const groups = new Map<string, { mode: PartnerUsage['bid_group'][number]['mode']; partners: string[]; fallback: string | null; workflows: string[] }>()
  for (const s of usage.bid_group) {
    const key = `${s.mode}|${s.partner_ids.join(',')}|${s.fallback_partner_id ?? ''}`
    const g = groups.get(key) ?? { mode: s.mode, partners: s.partner_ids.map(nameOf), fallback: s.fallback_partner_id === null ? null : nameOf(s.fallback_partner_id), workflows: [] }
    const label = workflowLabel(s)
    if (!g.workflows.includes(label)) g.workflows.push(label)
    groups.set(key, g)
  }
  const out = [...groups.values()].map((g) => {
    const asked = g.partners.length > 0 ? ` ${askedSentence(g.mode, g.partners)}` : ''
    const fallback = g.fallback ? ` If nobody wins, ${g.fallback} is asked last.` : ''
    return `${joinNames(g.workflows)}.${asked}${fallback}`
  })
  const single = [...new Set(usage.partner_bid.map(workflowLabel))]
  if (single.length > 0) out.push(`${joinNames(single)}, in ${single.length === 1 ? 'a Partner Bid step' : 'their Partner Bid steps'}.`)
  return out
}
