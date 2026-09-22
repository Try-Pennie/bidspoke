/**
 * The words the buyer profile section uses for its fields (#1412), stated once
 * here so the form's labels, the history list and the 409 side by side say the
 * same thing for the same path (L118). Paths are the ones the database's
 * flatten and the package's diff produce: a scalar name, `allowed_states`,
 * `windows[day:opens]`, `blackout_dates[date]`, `tiers[population:from]`.
 */
import { DAYS_OF_WEEK, POPULATIONS, type Population } from '@bidspoke/buyer-profile'

export const FIELD_LABELS: Record<string, string> = {
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
}

export const POPULATION_LABELS: Record<Population, string> = {
  engine: 'Engine',
  main_flow: 'Main Flow',
  lead_economy: 'Lead Economy',
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
  if (path.endsWith('_cents') && typeof value === 'number') return formatCents(value)
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
