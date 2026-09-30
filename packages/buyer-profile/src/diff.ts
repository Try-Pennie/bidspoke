/**
 * diffProfileDocuments (#1412): the paths on which two documents differ, keyed
 * the way buyer_profile_flatten keys them in the database (a tier by population
 * and lower bound, a window by day and opening minute, a blackout by date, the
 * state list as one value), so the 409 side by side and the history list speak
 * one vocabulary (L83).
 */
import type { BuyerProfileDocument } from './document'

export interface ProfileFieldDiff {
  path: string
  mine: unknown
  theirs: unknown
}

const SCALARS = [
  'sold_on', 'is_enabled', 'priority', 'debt_min', 'debt_max', 'loan_amount_min',
  'hourly_lead_cap', 'daily_lead_cap', 'hourly_spend_cap_cents', 'daily_spend_cap_cents',
] as const

function flatten(doc: BuyerProfileDocument): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const key of SCALARS) out.set(key, doc[key] ?? null)
  out.set('allowed_states', [...doc.allowed_states].sort())
  for (const w of doc.windows) out.set(`windows[${w.day_of_week}:${w.opens_minute}]`, { ...w })
  for (const b of doc.blackout_dates) out.set(`blackout_dates[${b.date}]`, { date: b.date, note: b.note ?? null })
  // A click buyer's delivery (#1639): the success line on its own path, each
  // route by its name with its address and states, keyed as buyer_profile_flatten keys them.
  if (doc.click_delivery) {
    out.set('click_delivery.success_pattern', doc.click_delivery.success_pattern)
    for (const r of doc.click_delivery.routes) out.set(`click_delivery.routes[${r.name}]`, { url: r.url, states: [...r.states].sort() })
  }
  for (const t of doc.tiers) out.set(`tiers[${t.population}:${Number(t.debt_from)}]`, { population: t.population, debt_from: Number(t.debt_from), debt_to: t.debt_to === null ? null : Number(t.debt_to), multiplier: Number(t.multiplier) })
  return out
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export function diffProfileDocuments(mine: BuyerProfileDocument, theirs: BuyerProfileDocument): ProfileFieldDiff[] {
  const a = flatten(mine)
  const b = flatten(theirs)
  const paths = [...new Set([...a.keys(), ...b.keys()])]
  const out: ProfileFieldDiff[] = []
  for (const path of paths) {
    const m = a.has(path) ? a.get(path) : null
    const t = b.has(path) ? b.get(path) : null
    if (!same(m, t)) out.push({ path, mine: m, theirs: t })
  }
  return out
}
