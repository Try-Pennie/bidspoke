/**
 * The one conversion from the database's profile path spelling to this
 * package's (#2132, L26).
 *
 * public.buyer_profile_flatten keys a window `windows.<day>.<opens>`, a
 * blackout `blackout_dates.<date>` and a tier by field,
 * `tiers.<population>.<from>.debt_to` and `.multiplier`. flattenProfileDocument
 * (diff.ts) keys them `windows[<day>:<opens>]`, `blackout_dates[<date>]` and
 * `tiers[<population>:<from>]`, a tier as one row. The partners page registry is
 * keyed in the TypeScript spelling, so every SQL path (an audit row's keys, a
 * conflict's detail) passes through here. fixtures/flatten-cases.json holds
 * both spellings for every row kind and scalar, and both flattens are checked
 * against it, one in vitest and one in the SQL suite.
 */

const TIER_FIELDS = ['debt_to', 'multiplier'] as const

/** The TypeScript spelling of a path buyer_profile_flatten produced. Throws on a path it cannot place. */
export function normaliseSqlPath(sqlPath: string): string {
  if (sqlPath.startsWith('windows.')) {
    const m = /^windows\.(\d+)\.(\d+)$/.exec(sqlPath)
    if (!m) throw new Error(`normaliseSqlPath: ${sqlPath} is not a window path`)
    return `windows[${m[1]}:${m[2]}]`
  }
  if (sqlPath.startsWith('blackout_dates.')) {
    return `blackout_dates[${sqlPath.slice('blackout_dates.'.length)}]`
  }
  if (sqlPath.startsWith('tiers.')) {
    const rest = sqlPath.slice('tiers.'.length)
    const field = TIER_FIELDS.find((f) => rest.endsWith(`.${f}`))
    if (!field) throw new Error(`normaliseSqlPath: ${sqlPath} names no tier field`)
    const row = rest.slice(0, -(field.length + 1))
    const dot = row.indexOf('.')
    if (dot <= 0 || dot === row.length - 1) throw new Error(`normaliseSqlPath: ${sqlPath} is not a tier path`)
    return `tiers[${row.slice(0, dot)}:${row.slice(dot + 1)}]`
  }
  return sqlPath
}

/** The partner record rules the validator judges a profile against, by their own keys (#2133). */
const PARTNER_RULE_PATHS: Readonly<Record<string, string>> = {
  acceptSignals: 'accept_signals',
  clickUrl: 'click_url',
  externalRoutingCode: 'external_routing_code',
}

/** A whole row list, named by its row pattern: an error about the list is about every row of it. */
const ROW_LIST_PATHS: Readonly<Record<string, string>> = {
  windows: 'windows[*]',
  blackoutDates: 'blackout_dates[*]',
  tiers: 'tiers[*]',
  clickDelivery: 'click_delivery.routes[*]',
  'clickDelivery.routes': 'click_delivery.routes[*]',
}

const ROUTE_ROW = /^clickDelivery\.routes\[(\d+)\]/

/**
 * The partners page registry spelling of a path validateProfile names an error
 * by (#2133), so a page save's refusals say which registry field, and so which
 * tab, each is about: a profile field under `profile.` in snake case, a partner
 * rule by its own key, a whole row list by its row pattern, and a click route
 * by its name when `routeNames` (the routes as sent, in order) gives it one.
 * The web registry test holds every path the validator can name to exactly one
 * registry entry.
 */
export function registryPathOf(validatorPath: string, routeNames: readonly string[] = []): string {
  const rule = PARTNER_RULE_PATHS[validatorPath]
  if (rule) return rule
  const list = ROW_LIST_PATHS[validatorPath]
  if (list) return `profile.${list}`
  if (validatorPath === 'clickDelivery.successPattern') return 'profile.click_delivery.success_pattern'
  const route = ROUTE_ROW.exec(validatorPath)
  if (route) {
    const name = routeNames[Number(route[1])]?.trim() ?? ''
    return `profile.click_delivery.routes[${name === '' ? '*' : name}]`
  }
  return `profile.${validatorPath.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`
}
