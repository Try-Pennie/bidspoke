/**
 * The words the buyer profile section uses for its fields (#1412), stated once
 * here so the form's labels, the history list and the 409 side by side say the
 * same thing for the same path (L118). Paths are the ones the database's
 * flatten and the package's diff produce: a scalar name, `allowed_states`,
 * `windows[day:opens]`, `blackout_dates[date]`, `tiers[population:from]`.
 */
import { DAYS_OF_WEEK, POPULATIONS, type Population, type ProfileError, type SoldOn } from '@bidspoke/buyer-profile'

export const FIELD_LABELS: Record<string, string> = {
  sold_on: 'Sold on',
  is_enabled: 'Enabled',
  priority: 'Priority',
  allowed_states: 'States',
  debt_min: 'Debt minimum',
  debt_max: 'Debt maximum',
  loan_amount_min: 'Loan amount minimum',
  hourly_lead_cap: 'Leads per hour',
  daily_lead_cap: 'Leads per day',
  hourly_spend_cap_cents: 'Spend per hour',
  daily_spend_cap_cents: 'Spend per day',
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
  accept_signals: 'Accept when all of',
  duplicate_signals: 'Duplicate when any of',
} as const

/** The two answers to Sold on (#1541), in the order the choice offers them. The Record type makes a new kind without a label a compile error (L113). */
export const SOLD_ON_LABELS: Record<SoldOn, string> = {
  offer: 'The offer',
  click: 'The click',
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
 * the snake_case paths the diff and history use, so the two are joined here
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

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** A human label for a diff or history path. */
export function profileFieldLabel(path: string): string {
  if (FIELD_LABELS[path]) return FIELD_LABELS[path]
  if (path === 'click_delivery.success_pattern') return SUCCESS_REPLY
  const clickRoute = /^click_delivery\.routes\[(.*)\]$/.exec(path)
  if (clickRoute) return `Route ${clickRoute[1]}`
  const window = /^windows\[(\d+):(\d+)\]$/.exec(path)
  if (window) {
    const day = DAYS_OF_WEEK.find((d) => d.index === Number(window[1]))?.label ?? `Day ${window[1]}`
    return `${day} hours from ${minutesToTime(Number(window[2]))}`
  }
  const blackout = /^blackout_dates\[(.+)\]$/.exec(path)
  if (blackout) return `Blackout ${blackout[1]}`
  const tier = /^tiers\[([^:]+):(\d+(?:\.\d+)?)\]$/.exec(path)
  if (tier) {
    const population = (POPULATIONS as readonly string[]).includes(tier[1]) ? POPULATION_LABELS[tier[1] as Population] : tier[1]
    return `${population} tier from $${formatWhole(Number(tier[2]))}`
  }
  return path
}

/** A human value for a diff or history value at a path. */
export function formatProfileValue(path: string, value: unknown): string {
  if (value === null || value === undefined) return 'none'
  if (path === 'sold_on' && typeof value === 'string' && value in SOLD_ON_LABELS) return SOLD_ON_LABELS[value as SoldOn]
  if (path.endsWith('_cents') && typeof value === 'number') return formatCents(value)
  if (path.startsWith('click_delivery.routes[') && typeof value === 'object') {
    const r = value as { url?: unknown; states?: unknown }
    const states = Array.isArray(r.states) && r.states.length > 0 ? [...r.states].map(String).sort().join(', ') : 'every state no other route lists'
    return `${String(r.url)} for ${states}`
  }
  if (path === 'allowed_states' && Array.isArray(value)) return value.length ? [...value].map(String).sort().join(', ') : 'none'
  if (path.startsWith('windows[') && typeof value === 'object') {
    const w = value as { opens_minute?: number; closes_minute?: number }
    return typeof w.opens_minute === 'number' && typeof w.closes_minute === 'number' ? `${minutesToTime(w.opens_minute)} to ${minutesToTime(w.closes_minute)}` : JSON.stringify(value)
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
