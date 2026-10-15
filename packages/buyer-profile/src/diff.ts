/**
 * A buyer profile document as paths (#1412, #2134): flattenProfileDocument and
 * its inverse unflattenProfileDocument. The paths are keyed by the same things
 * buyer_profile_flatten keys them by in the database (a tier by population and
 * lower bound, a window by day and opening minute, a blackout by date, the
 * state list as one value), so the partners page registry, its three way merge
 * (apps/web/src/lib/partner-page-merge.ts) and the history list speak one
 * vocabulary (L83). The two SPELL those keys differently (`windows[1:540]`
 * here, `windows.1.540` there, and a tier here is one row where there it is two
 * fields); normaliseSqlPath (paths.ts) converts, and fixtures/flatten-cases.json
 * pins both (#2132).
 */
import type { BuyerProfileDocument } from './document'

const SCALARS = [
  'sold_on', 'is_enabled', 'priority', 'debt_min', 'debt_max', 'loan_amount_min',
  'hourly_lead_cap', 'daily_lead_cap', 'hourly_spend_cap_cents', 'daily_spend_cap_cents',
] as const

/** The document as paths in this package's spelling, each with its value. */
export function flattenProfileDocument(doc: BuyerProfileDocument): Map<string, unknown> {
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

const ROW_PATH = /^(windows|blackout_dates|tiers|click_delivery\.routes)\[.+\]$/

/**
 * The inverse of flattenProfileDocument (#2134): the document a set of paths
 * describes, rows in the order the paths give them, so whoever chose the paths
 * (the partners page merge) also chose the order. Every scalar must be present,
 * as flatten always writes them; a path it cannot place is refused rather than
 * dropped. No delivery paths at all is no delivery (null), which is what the
 * flatten of both an absent and a null delivery reads as.
 */
export function unflattenProfileDocument(paths: ReadonlyMap<string, unknown>): BuyerProfileDocument {
  for (const key of paths.keys()) {
    const known = (SCALARS as readonly string[]).includes(key) || key === 'allowed_states' || key === 'click_delivery.success_pattern' || ROW_PATH.test(key)
    if (!known) throw new Error(`unflattenProfileDocument: ${key} is not a profile path`)
  }
  const scalar = (key: (typeof SCALARS)[number]): unknown => {
    if (!paths.has(key)) throw new Error(`unflattenProfileDocument: ${key} is missing`)
    return paths.get(key)
  }
  const rows = <T>(prefix: string): T[] => [...paths.entries()].filter(([k]) => k.startsWith(`${prefix}[`)).map(([, v]) => ({ ...(v as object) }) as T)
  const doc: BuyerProfileDocument = {
    sold_on: scalar('sold_on') as BuyerProfileDocument['sold_on'],
    is_enabled: scalar('is_enabled') as boolean,
    priority: scalar('priority') as number | null,
    allowed_states: [...((paths.get('allowed_states') as string[] | undefined) ?? [])],
    debt_min: scalar('debt_min') as number | null,
    debt_max: scalar('debt_max') as number | null,
    loan_amount_min: scalar('loan_amount_min') as number | null,
    hourly_lead_cap: scalar('hourly_lead_cap') as number | null,
    daily_lead_cap: scalar('daily_lead_cap') as number | null,
    hourly_spend_cap_cents: scalar('hourly_spend_cap_cents') as number | null,
    daily_spend_cap_cents: scalar('daily_spend_cap_cents') as number | null,
    windows: rows<BuyerProfileDocument['windows'][number]>('windows'),
    blackout_dates: rows<BuyerProfileDocument['blackout_dates'][number]>('blackout_dates'),
    tiers: rows<BuyerProfileDocument['tiers'][number]>('tiers'),
  }
  const routeEntries = [...paths.entries()].filter(([k]) => k.startsWith('click_delivery.routes['))
  if (paths.has('click_delivery.success_pattern') || routeEntries.length > 0) {
    doc.click_delivery = {
      success_pattern: (paths.get('click_delivery.success_pattern') as string | undefined) ?? '',
      routes: routeEntries.map(([k, v]) => {
        const r = v as { url: string; states: string[] }
        return { name: k.slice('click_delivery.routes['.length, -1), url: r.url, states: [...r.states] }
      }),
    }
  } else {
    doc.click_delivery = null
  }
  return doc
}
