/**
 * What saving a click delivery change does, in the domain's words (#1639, L180):
 * derived from the two deliveries themselves, state by state through the same
 * pickClickRoute buyer_click_send uses, so the partners page save bar (PM-6,
 * #2138) says, beside the one Save, exactly where each click will go instead of
 * where it went, and says nothing for an edit that moves no click (a route
 * renamed, states reordered).
 */
import { US_STATES, clickDeliveryFromDocument, pickClickRoute, type ClickDeliveryDocument } from '@bidspoke/buyer-profile'

/** Where a click goes while the profile holds no delivery. */
export const NODE_ADDRESS = 'the address on the workflow click send node'
const NODE_SUCCESS_LINE = 'the success line on the workflow click send node'

/** Where one state's clicks go: the address, and the route's name when a route takes them. */
function destination(d: ClickDeliveryDocument | null, state: string): { url: string; name: string | null } {
  if (!d) return { url: NODE_ADDRESS, name: null }
  // A delivery with no catch-all is refused before this is asked; "nowhere" is what it would mean.
  const route = pickClickRoute(clickDeliveryFromDocument(d), state)?.route
  return route ? { url: route.url, name: route.name.trim() || null } : { url: 'nowhere', name: null }
}

/**
 * The two ends of a move in the words that tell them apart (#2138, PM-6): by
 * route name, as the settled design says it (DI4 instead of DV1), when both
 * ends are named routes with different names; otherwise by address, because a
 * route whose address changed keeps its name and only the address shows what moved.
 */
function ends(from: { url: string; name: string | null }, to: { url: string; name: string | null }): { from: string; to: string } {
  if (from.name && to.name && from.name !== to.name) return { from: from.name, to: to.name }
  return { from: from.url, to: to.url }
}

function describeStates(states: readonly string[], after: ClickDeliveryDocument | null): string {
  if (states.length === US_STATES.length) return 'every state'
  if (after) {
    const delivery = clickDeliveryFromDocument(after)
    const catchAll = US_STATES.filter((s) => pickClickRoute(delivery, s)?.matched === 'catch_all')
    if (catchAll.length > 0 && catchAll.length === states.length && catchAll.every((s) => states.includes(s))) return 'every state no other route lists'
  }
  return [...states].sort().join(', ')
}

export function clickDeliveryConsequences(before: ClickDeliveryDocument | null | undefined, after: ClickDeliveryDocument | null | undefined): string[] {
  const b = before ?? null
  const a = after ?? null
  const groups = new Map<string, { from: string; to: string; states: string[] }>()
  for (const state of US_STATES) {
    const before = destination(b, state)
    const after = destination(a, state)
    if (before.url === after.url) continue
    const { from, to } = ends(before, after)
    const key = `${from}\n${to}`
    const group = groups.get(key) ?? { from, to, states: [] }
    group.states.push(state)
    groups.set(key, group)
  }
  const out = [...groups.values()].map((g) => `Clicks from ${describeStates(g.states, a)} will go to ${g.to} instead of ${g.from}.`)

  const beforeLine = b?.success_pattern ?? null
  const afterLine = a?.success_pattern ?? null
  if (beforeLine !== afterLine) {
    out.push(`A click counts as sent only when the reply matches ${afterLine ?? NODE_SUCCESS_LINE} instead of ${beforeLine ?? NODE_SUCCESS_LINE}.`)
  }
  return out
}
