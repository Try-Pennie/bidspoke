/**
 * The buyer profile DOCUMENT (#1412): the wire shape the API and the partner
 * form exchange, and the shape save_buyer_profile and buyer_profile_document
 * return. snake_case, windows and blackout dates with notes, tiers. The
 * evaluator reads BuyerProfile (camelCase, no notes); documentToProfile is the
 * one mapping between them, so the form's worked example, the API's validation
 * and the engine agree about every field (L83).
 *
 * parseProfileDocument names every field that is missing or of the wrong type
 * at once (L688): the type is erased at the boundary, so a typed object built
 * from JSON without this would fail far away from the cause.
 */
import type { BuyerProfile } from './eligibility'

export interface ProfileWindowDocument {
  day_of_week: number
  opens_minute: number
  closes_minute: number
}

export interface ProfileBlackoutDocument {
  date: string
  note: string | null
}

export interface ProfileTierDocument {
  population: string
  debt_from: number
  debt_to: number | null
  multiplier: number
}

export interface BuyerProfileDocument {
  /** Set by the database; absent on a document that has never been saved. */
  partner_id?: string
  /** Set by the database; 0 or absent on a document that has never been saved. */
  version?: number
  is_enabled: boolean
  priority: number | null
  allowed_states: string[]
  debt_min: number | null
  debt_max: number | null
  loan_amount_min: number | null
  hourly_lead_cap: number | null
  daily_lead_cap: number | null
  hourly_spend_cap_cents: number | null
  daily_spend_cap_cents: number | null
  windows: ProfileWindowDocument[]
  blackout_dates: ProfileBlackoutDocument[]
  tiers: ProfileTierDocument[]
}

export interface DocumentFieldError {
  path: string
  message: string
}

export type ParsedProfileDocument = { ok: true; document: BuyerProfileDocument } | { ok: false; errors: DocumentFieldError[] }

/** Postgres returns numeric columns as strings through PostgREST; both spellings are one number here. */
function num(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function integer(value: unknown): number | null | undefined {
  const n = num(value)
  return n === null || n === undefined ? n : Number.isInteger(n) ? n : undefined
}

export function parseProfileDocument(input: unknown): ParsedProfileDocument {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ path: '', message: 'The profile must be an object.' }] }
  }
  const raw = input as Record<string, unknown>
  const errors: DocumentFieldError[] = []
  const err = (path: string, message: string) => errors.push({ path, message })

  const nullableNumber = (path: string): number | null => {
    const v = num(raw[path])
    if (v === undefined) { err(path, `${path} must be a number or null.`); return null }
    return v
  }
  const nullableInteger = (path: string): number | null => {
    const v = integer(raw[path])
    if (v === undefined) { err(path, `${path} must be a whole number or null.`); return null }
    return v
  }

  const is_enabled = raw.is_enabled
  if (typeof is_enabled !== 'boolean') err('is_enabled', 'is_enabled must be true or false.')

  const priority = nullableInteger('priority')
  const allowed_states: string[] = []
  if (!Array.isArray(raw.allowed_states) || raw.allowed_states.some((s) => typeof s !== 'string')) {
    err('allowed_states', 'allowed_states must be a list of state codes.')
  } else {
    allowed_states.push(...(raw.allowed_states as string[]))
  }

  const debt_min = nullableNumber('debt_min')
  const debt_max = nullableNumber('debt_max')
  const loan_amount_min = nullableNumber('loan_amount_min')
  const hourly_lead_cap = nullableInteger('hourly_lead_cap')
  const daily_lead_cap = nullableInteger('daily_lead_cap')
  const hourly_spend_cap_cents = nullableInteger('hourly_spend_cap_cents')
  const daily_spend_cap_cents = nullableInteger('daily_spend_cap_cents')

  const windows: ProfileWindowDocument[] = []
  if (!Array.isArray(raw.windows)) {
    err('windows', 'windows must be a list.')
  } else {
    raw.windows.forEach((w, i) => {
      const row = (w ?? {}) as Record<string, unknown>
      const day = integer(row.day_of_week)
      const opens = integer(row.opens_minute)
      const closes = integer(row.closes_minute)
      if (day === undefined || day === null) err(`windows[${i}].day_of_week`, 'day_of_week must be a whole number.')
      if (opens === undefined || opens === null) err(`windows[${i}].opens_minute`, 'opens_minute must be a whole number.')
      if (closes === undefined || closes === null) err(`windows[${i}].closes_minute`, 'closes_minute must be a whole number.')
      if (typeof day === 'number' && typeof opens === 'number' && typeof closes === 'number') {
        windows.push({ day_of_week: day, opens_minute: opens, closes_minute: closes })
      }
    })
  }

  const blackout_dates: ProfileBlackoutDocument[] = []
  if (!Array.isArray(raw.blackout_dates)) {
    err('blackout_dates', 'blackout_dates must be a list.')
  } else {
    raw.blackout_dates.forEach((b, i) => {
      const row = (b ?? {}) as Record<string, unknown>
      if (typeof row.date !== 'string') err(`blackout_dates[${i}].date`, 'date must be a YYYY-MM-DD string.')
      if (row.note !== undefined && row.note !== null && typeof row.note !== 'string') err(`blackout_dates[${i}].note`, 'note must be text or null.')
      if (typeof row.date === 'string') blackout_dates.push({ date: row.date, note: typeof row.note === 'string' ? row.note : null })
    })
  }

  const tiers: ProfileTierDocument[] = []
  if (!Array.isArray(raw.tiers)) {
    err('tiers', 'tiers must be a list.')
  } else {
    raw.tiers.forEach((t, i) => {
      const row = (t ?? {}) as Record<string, unknown>
      const from = num(row.debt_from)
      const to = num(row.debt_to)
      const multiplier = num(row.multiplier)
      if (typeof row.population !== 'string') err(`tiers[${i}].population`, 'population must be a string.')
      if (from === undefined || from === null) err(`tiers[${i}].debt_from`, 'debt_from must be a number.')
      if (to === undefined) err(`tiers[${i}].debt_to`, 'debt_to must be a number or null.')
      if (multiplier === undefined || multiplier === null) err(`tiers[${i}].multiplier`, 'multiplier must be a number.')
      if (typeof row.population === 'string' && typeof from === 'number' && to !== undefined && typeof multiplier === 'number') {
        tiers.push({ population: row.population, debt_from: from, debt_to: to, multiplier })
      }
    })
  }

  if (raw.partner_id !== undefined && typeof raw.partner_id !== 'string') err('partner_id', 'partner_id must be a string.')
  if (raw.version !== undefined && integer(raw.version) === undefined) err('version', 'version must be a whole number.')

  if (errors.length > 0) return { ok: false, errors }
  const document: BuyerProfileDocument = {
    is_enabled: is_enabled as boolean,
    priority,
    allowed_states,
    debt_min,
    debt_max,
    loan_amount_min,
    hourly_lead_cap,
    daily_lead_cap,
    hourly_spend_cap_cents,
    daily_spend_cap_cents,
    windows,
    blackout_dates,
    tiers,
  }
  if (typeof raw.partner_id === 'string') document.partner_id = raw.partner_id
  if (raw.version !== undefined) document.version = integer(raw.version) as number
  return { ok: true, document }
}

/** The evaluator's shape from a document. Numeric strings from Postgres become numbers; notes are dropped. */
export function documentToProfile(doc: BuyerProfileDocument): BuyerProfile {
  const n = (v: unknown): number | null => {
    const parsed = num(v)
    return parsed === undefined ? null : parsed
  }
  return {
    partnerId: doc.partner_id ?? '',
    isEnabled: doc.is_enabled,
    priority: n(doc.priority),
    allowedStates: [...doc.allowed_states],
    debtMin: n(doc.debt_min),
    debtMax: n(doc.debt_max),
    loanAmountMin: n(doc.loan_amount_min),
    hourlyLeadCap: n(doc.hourly_lead_cap),
    dailyLeadCap: n(doc.daily_lead_cap),
    hourlySpendCapCents: n(doc.hourly_spend_cap_cents),
    dailySpendCapCents: n(doc.daily_spend_cap_cents),
    windows: doc.windows.map((w) => ({ dayOfWeek: w.day_of_week, opensMinute: w.opens_minute, closesMinute: w.closes_minute })),
    blackoutDates: doc.blackout_dates.map((b) => b.date),
    tiers: doc.tiers.map((t) => ({ population: t.population, debtFrom: n(t.debt_from) ?? 0, debtTo: n(t.debt_to), multiplier: n(t.multiplier) ?? 0 })),
  }
}
