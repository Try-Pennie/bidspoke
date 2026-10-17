/**
 * The words the buyer profile section uses for its fields (#1412), stated once
 * here so the form's labels, the history list and the merge dialog say the
 * same thing for the same path (L118). Paths are the ones the database's
 * flatten and the package's flattenProfileDocument produce: a scalar name, `allowed_states`,
 * `windows[day:opens]`, `blackout_dates[date]`, `tiers[population:from]`.
 */
import { DAYS_OF_WEEK, DEFAULT_DISPLAY_TIME_ZONE, DISPLAY_TIME_ZONE_LABELS, EASTERN, isDisplayTimeZone, POPULATIONS, type Population, type ProfileError, type SoldOn } from '@bidspoke/buyer-profile'
import { formatTime } from '@/components/ui/date-time'
import type { OfferBuyer } from '@/lib/api'

export const FIELD_LABELS: Record<string, string> = {
  sold_on: 'Sold on',
  is_enabled: 'Enabled',
  priority: 'Priority',
  allowed_states: 'States',
  debt_min: 'Debt minimum',
  debt_max: 'Debt maximum',
  loan_amount_min: 'Loan amount minimum',
  collections_max_percent: 'Collections at most',
  hourly_lead_cap: 'Leads per hour',
  daily_lead_cap: 'Leads per day',
  hourly_spend_cap_cents: 'Spend per hour',
  daily_spend_cap_cents: 'Spend per day',
  // Where the hours and reset times are shown (#2143, PM-10): the settled design's word for the control under Hours.
  display_time_zone: 'Time zone',
  // Partner record fields the validator names when a profile cannot be enabled without them (#1416).
  click_url: 'Click URL',
  external_routing_code: 'Salesforce routing code',
}

/**
 * The headings of the section's grouped editors, which the validator names as a
 * whole (`windows`, `tiers`, `blackoutDates`, `acceptSignals`) when the problem
 * is the set rather than one row. The section renders these same words.
 */
export const SECTION_LABELS = {
  windows: 'Hours',
  tiers: 'Pricing',
  blackout_dates: 'Blackout dates',
  accept_signals: 'Accept when every one of',
  duplicate_signals: 'Duplicate when any of',
} as const

/**
 * Stored hours are kept and judged in Eastern whatever zone the profile shows
 * them in, so History and the merge dialog, which show stored hours, name that
 * zone on the label (#2253): a person viewing Pacific is not left reading two
 * times for one window.
 */
const STORED_HOURS_ZONE = DISPLAY_TIME_ZONE_LABELS[EASTERN]
export const STORED_HOURS_LABEL = `${SECTION_LABELS.windows} (${STORED_HOURS_ZONE})`

/**
 * The two answers to Sold on (#1541), in the order the choice offers them, worded
 * as the settled design words them (#2324, PM-21). The Record type makes a new
 * kind without a label a compile error (L113).
 */
export const SOLD_ON_LABELS: Record<SoldOn, string> = {
  offer: 'Offer',
  click: 'Click',
}

/** The one sentence under Sold on, for the kind chosen (#2324, the design's SOLD_WHY). */
export const SOLD_ON_WHY: Record<SoldOn, string> = {
  offer: 'Sold through buyer selection at a priced rate.',
  click: 'Quoted at the Engine bid, and sent to the buyer only when the person clicks.',
}

const listOf = (items: readonly string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

/**
 * Where an offer buyer stands today, under the priority rule (#2324, PM-21):
 * alone on the offer, or beside the other buyers the Worker named with their
 * priorities. A buyer switched off is never told it is offered every lead.
 * Null when the Worker did not say (one deployed before it could), so the
 * page never claims a buyer is alone on the strength of a missing list.
 */
export function priorityStanding(partnerName: string, others: readonly OfferBuyer[] | undefined, enabled: boolean): string | null {
  if (others === undefined) return null
  if (others.length === 0) {
    return enabled ? `Today ${partnerName} is the only buyer sold on the offer, so it is offered every lead it qualifies for.` : 'Today no other buyer is sold on the offer.'
  }
  const named = others.map((o) => `${o.name} (${o.priority === null ? 'no priority' : `priority ${o.priority}`})`)
  return `Today ${listOf(named)} ${others.length === 1 ? 'is' : 'are'} also sold on the offer.`
}

/** A click buyer's one cap counts clicks, so its field is named for them wherever the form names it (#1541, L118). */
export const CLICK_FIELD_LABELS: Record<string, string> = {
  daily_lead_cap: 'Clicks per day',
}

/**
 * A click buyer's delivery (#1639), named as its editor names its controls: the
 * section, the routes as a set, a route's field by its number, and the reply.
 */
const SUCCESS_REPLY = 'Success reply'
const ROUTE_FIELD_LABELS: Record<string, string> = { name: 'name', url: 'address', states: 'states' }

function clickDeliveryErrorLabel(path: string): string | null {
  if (path === 'clickDelivery') return 'Click delivery'
  if (path === 'clickDelivery.routes') return 'Routes'
  if (path === 'clickDelivery.successPattern') return SUCCESS_REPLY
  const route = /^clickDelivery\.routes\[(\d+)\]\.(\w+)$/.exec(path)
  if (route) return `Route ${Number(route[1]) + 1} ${ROUTE_FIELD_LABELS[route[2]] ?? route[2]}`
  return null
}

const camelToSnake = (path: string): string => path.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/**
 * The on screen words for a path the shared validator emits (#1464). The
 * validator speaks the profile's camelCase field names; the labels are keyed by
 * the snake_case paths flattenProfileDocument and the history use, so the two are joined here
 * rather than kept as a second list (L118, L41). An unknown path comes back as
 * itself, visibly unlabelled rather than silently blank. A click buyer's cap is
 * named as its form names it.
 */
export function profileErrorLabel(path: string, soldOn?: SoldOn | null): string {
  const delivery = clickDeliveryErrorLabel(path)
  if (delivery) return delivery
  const snake = camelToSnake(path)
  if (soldOn === 'click' && CLICK_FIELD_LABELS[snake]) return CLICK_FIELD_LABELS[snake]
  return FIELD_LABELS[snake] ?? (SECTION_LABELS as Record<string, string>)[snake] ?? path
}

/**
 * The refusal beside the Save button: every refused field by its label with the
 * validator's own sentence, one field once. It names what to fix and why (L111,
 * L399) rather than how many problems there are and where to look for them.
 */
export function describeProfileErrors(errors: readonly ProfileError[], soldOn?: SoldOn | null): string {
  const byPath = new Map<string, string[]>()
  for (const e of errors) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e.message])
  return [...byPath.entries()].map(([path, messages]) => `${profileErrorLabel(path, soldOn)}: ${messages.join(' ')}`).join(' ')
}

export const POPULATION_LABELS: Record<Population, string> = {
  engine: 'Engine',
  main_flow: 'Main Flow',
  lead_economy: 'Lead Economy',
}

/** The share of a cap at which a usage panel says the cap is within reach (#1557: one number for both panels). */
export const CAP_NEAR_SHARE = 0.8

/**
 * The sentence naming the workflows that sell to this buyer outside what the
 * panel counts, grammatical for one seller or many (#1557): "Main Flow also sells
 * to Tripoint", "Main Flow and Lead Economy also sell to Tripoint", "A, B and C
 * also sell to Tripoint". Both usage panels read it.
 */
export function alsoSellTo(sellers: ReadonlyArray<{ name: string }>, partnerName: string): string {
  const names = sellers.map((s) => s.name)
  const list = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${list} also ${names.length === 1 ? 'sells' : 'sell'} to ${partnerName}`
}

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export const formatCents = (cents: number): string => dollars.format(cents / 100)
export const formatDollars = (amount: number): string => dollars.format(amount)
export const formatWhole = (n: number): string => whole.format(n)

/**
 * The two spellings of a row path (#1672). flattenProfileDocument (diff.ts)
 * keys a row in brackets and values it by the whole row: `windows[1:660]`,
 * `blackout_dates[2026-12-25]`, `tiers[engine:10000]`. The history reads
 * audit_log, which save_buyer_profile fills through buyer_profile_flatten, and
 * that keys a row in dots and values it by ONE field of the row: `windows.1.660`
 * holds the closing minute, `blackout_dates.2026-12-25` holds the note, and a
 * tier is two paths, `tiers.engine.10000.multiplier` and `.debt_to`. Both are
 * read here so neither surface shows a raw path.
 */
const WINDOW_PATH = /^windows(?:\[(\d+):(\d+)\]|\.(\d+)\.(\d+))$/
const BLACKOUT_PATH = /^blackout_dates(?:\[(.+)\]|\.(.+))$/
const TIER_PATH = /^tiers(?:\[([^:]+):(\d+(?:\.\d+)?)\]|\.([^.]+)\.(\d+(?:\.\d+)?)\.(multiplier|debt_to))$/
const TIER_FIELD_LABELS: Record<string, string> = { multiplier: 'multiplier', debt_to: 'upper bound' }

type RowPath =
  | { kind: 'window'; dotted: boolean; day: number; opens: number }
  | { kind: 'blackout'; dotted: boolean; date: string }
  | { kind: 'tier'; dotted: boolean; population: string; from: number; field: string | null }

function parseRowPath(path: string): RowPath | null {
  const w = WINDOW_PATH.exec(path)
  if (w) return { kind: 'window', dotted: w[3] !== undefined, day: Number(w[1] ?? w[3]), opens: Number(w[2] ?? w[4]) }
  const b = BLACKOUT_PATH.exec(path)
  if (b) return { kind: 'blackout', dotted: b[2] !== undefined, date: b[1] ?? b[2] }
  const t = TIER_PATH.exec(path)
  if (t) return { kind: 'tier', dotted: t[3] !== undefined, population: t[1] ?? t[3], from: Number(t[2] ?? t[4]), field: t[5] ?? null }
  return null
}

/** A human label for a flattened profile path or a history path. */
export function profileFieldLabel(path: string): string {
  if (FIELD_LABELS[path]) return FIELD_LABELS[path]
  if (path === 'click_delivery.success_pattern') return SUCCESS_REPLY
  const clickRoute = /^click_delivery\.routes\[(.*)\]$/.exec(path)
  if (clickRoute) return `Route ${clickRoute[1]}`
  const row = parseRowPath(path)
  if (row?.kind === 'window') {
    const day = DAYS_OF_WEEK.find((d) => d.index === row.day)?.label ?? `Day ${row.day}`
    return `${day} hours (${STORED_HOURS_ZONE}) from ${formatTime(row.opens)}`
  }
  if (row?.kind === 'blackout') return row.dotted ? `Blackout ${row.date} note` : `Blackout ${row.date}`
  if (row?.kind === 'tier') {
    const population = (POPULATIONS as readonly string[]).includes(row.population) ? POPULATION_LABELS[row.population as Population] : row.population
    const tier = `${population} tier from $${formatWhole(row.from)}`
    return row.field ? `${tier} ${TIER_FIELD_LABELS[row.field] ?? row.field}` : tier
  }
  return path
}

/** A history value at a dotted row path, which holds one field of the row (#1672). Null means the field was absent on that side. */
function formatDottedRowValue(row: RowPath, value: unknown): string | null {
  if (!row.dotted) return null
  if (row.kind === 'window' && typeof value === 'number') return `open until ${formatTime(value)}`
  if (row.kind === 'blackout' && typeof value === 'string') return value
  if (row.kind === 'tier' && row.field === 'debt_to' && (typeof value === 'number' || typeof value === 'string')) return formatDollars(Number(value))
  if (row.kind === 'tier' && row.field === 'multiplier' && (typeof value === 'number' || typeof value === 'string')) return String(Number(value))
  return null
}

/** A human value at a flattened profile path or a history path. */
export function formatProfileValue(path: string, value: unknown): string {
  // A zone by its name (L611); unset is shown in Eastern, so it reads as Eastern, not as none.
  if (path === 'display_time_zone') {
    if (value === null || value === undefined) return DISPLAY_TIME_ZONE_LABELS[DEFAULT_DISPLAY_TIME_ZONE]
    if (isDisplayTimeZone(value)) return DISPLAY_TIME_ZONE_LABELS[value]
  }
  if (value === null || value === undefined) return 'none'
  if (path === 'sold_on' && typeof value === 'string' && value in SOLD_ON_LABELS) return SOLD_ON_LABELS[value as SoldOn]
  if (path.endsWith('_cents') && typeof value === 'number') return formatCents(value)
  // #2268: the cap is a whole percent of the lead's own debt.
  if (path === 'collections_max_percent' && typeof value === 'number') return `${value}% of debt`
  const row = parseRowPath(path)
  const dotted = row ? formatDottedRowValue(row, value) : null
  if (dotted !== null) return dotted
  if (path.startsWith('click_delivery.routes[') && typeof value === 'object') {
    const r = value as { url?: unknown; states?: unknown }
    const states = Array.isArray(r.states) && r.states.length > 0 ? [...r.states].map(String).sort().join(', ') : 'every state no other route lists'
    return `${String(r.url)} for ${states}`
  }
  if (path === 'allowed_states' && Array.isArray(value)) return value.length ? [...value].map(String).sort().join(', ') : 'none'
  if (path.startsWith('windows[') && typeof value === 'object') {
    const w = value as { opens_minute?: number; closes_minute?: number }
    return typeof w.opens_minute === 'number' && typeof w.closes_minute === 'number' ? `${formatTime(w.opens_minute)} to ${formatTime(w.closes_minute)}` : JSON.stringify(value)
  }
  if (path.startsWith('blackout_dates[') && typeof value === 'object') {
    const b = value as { note?: string | null }
    return b.note ? `off (${b.note})` : 'off'
  }
  if (path.startsWith('tiers[') && typeof value === 'object') {
    const t = value as { multiplier?: number | string; debt_to?: number | string | null }
    const upper = t.debt_to === null || t.debt_to === undefined ? 'no upper bound' : `up to $${formatWhole(Number(t.debt_to))}`
    return `${Number(t.multiplier)} with ${upper}`
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return path.startsWith('debt') || path.startsWith('loan') ? formatDollars(value) : String(value)
  return String(value)
}
