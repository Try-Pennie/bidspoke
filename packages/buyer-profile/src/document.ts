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
import { clickDeliveryFromDocument, type ClickDeliveryDocument, type ClickRoute } from './click-delivery'
import { DISPLAY_TIME_ZONES, isDisplayTimeZone, type DisplayTimeZone } from './clock'
import type { BuyerProfile } from './eligibility'
import { SOLD_ON, type SoldOn } from './vocab'

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
  /**
   * How the buyer is sold (#1541). Null on a new profile until the person
   * chooses: there is no preselected answer, and validateProfile refuses the
   * save without one. An absent key parses as null too.
   */
  sold_on: SoldOn | null
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
  /**
   * A click buyer's delivery (#1639). Null clears it. ABSENT means the sender
   * did not speak about it (a form or Worker from before it existed), and
   * save_buyer_profile keeps what is stored, so it is never blanked by omission.
   */
  click_delivery?: ClickDeliveryDocument | null
  /**
   * The zone the page shows this buyer's hours and reset times in (#2143). The
   * hours are stored and judged in Eastern whatever it says. Null means never
   * chosen, shown in Eastern. ABSENT means the sender did not speak about it,
   * and the save keeps what is stored, so a sender from before the column
   * cannot blank it by omission.
   */
  display_time_zone?: DisplayTimeZone | null
  /**
   * The most a lead's collections may be, as a whole percent of its debt
   * (#2111). Null means not judged. ABSENT means the sender did not speak about
   * it, and the save keeps what is stored, so a page from before the field
   * cannot blank a cap set through the API.
   */
  collections_max_percent?: number | null
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

  let sold_on: SoldOn | null = null
  if (raw.sold_on !== undefined && raw.sold_on !== null) {
    if (typeof raw.sold_on === 'string' && (SOLD_ON as readonly string[]).includes(raw.sold_on)) sold_on = raw.sold_on as SoldOn
    else err('sold_on', `sold_on must be one of ${SOLD_ON.join(', ')}.`)
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

  let click_delivery: ClickDeliveryDocument | null | undefined
  if (raw.click_delivery === null) {
    click_delivery = null
  } else if (raw.click_delivery !== undefined) {
    click_delivery = parseClickDelivery(raw.click_delivery, err)
  }

  let display_time_zone: DisplayTimeZone | null | undefined
  if (raw.display_time_zone === null) {
    display_time_zone = null
  } else if (raw.display_time_zone !== undefined) {
    if (isDisplayTimeZone(raw.display_time_zone)) display_time_zone = raw.display_time_zone
    else err('display_time_zone', `display_time_zone must be one of ${DISPLAY_TIME_ZONES.join(', ')}.`)
  }

  let collections_max_percent: number | null | undefined
  if (raw.collections_max_percent !== undefined) collections_max_percent = nullableNumber('collections_max_percent')

  if (raw.partner_id !== undefined && typeof raw.partner_id !== 'string') err('partner_id', 'partner_id must be a string.')
  if (raw.version !== undefined && integer(raw.version) === undefined) err('version', 'version must be a whole number.')

  if (errors.length > 0) return { ok: false, errors }
  const document: BuyerProfileDocument = {
    sold_on,
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
  if (click_delivery !== undefined) document.click_delivery = click_delivery
  if (display_time_zone !== undefined) document.display_time_zone = display_time_zone
  if (collections_max_percent !== undefined) document.collections_max_percent = collections_max_percent
  if (typeof raw.partner_id === 'string') document.partner_id = raw.partner_id
  if (raw.version !== undefined) document.version = integer(raw.version) as number
  return { ok: true, document }
}

/** The delivery's shape, every malformed part named; undefined when any part is malformed. */
function parseClickDelivery(input: unknown, err: (path: string, message: string) => void): ClickDeliveryDocument | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    err('click_delivery', 'click_delivery must be an object or null.')
    return undefined
  }
  const raw = input as Record<string, unknown>
  let ok = true
  const routes: ClickRoute[] = []
  if (!Array.isArray(raw.routes)) {
    err('click_delivery.routes', 'routes must be a list.')
    ok = false
  } else {
    raw.routes.forEach((r, i) => {
      const row = (r ?? {}) as Record<string, unknown>
      const path = `click_delivery.routes[${i}]`
      let rowOk = true
      if (typeof row.name !== 'string') { err(`${path}.name`, 'name must be text.'); rowOk = false }
      if (typeof row.url !== 'string') { err(`${path}.url`, 'url must be text.'); rowOk = false }
      if (!Array.isArray(row.states) || row.states.some((s) => typeof s !== 'string')) { err(`${path}.states`, 'states must be a list of state codes.'); rowOk = false }
      if (rowOk) routes.push({ name: row.name as string, url: row.url as string, states: [...(row.states as string[])] })
      else ok = false
    })
  }
  if (typeof raw.success_pattern !== 'string') {
    err('click_delivery.success_pattern', 'success_pattern must be text.')
    ok = false
  }
  return ok ? { routes, success_pattern: raw.success_pattern as string } : undefined
}

/** The evaluator's shape from a document. Numeric strings from Postgres become numbers; notes are dropped. */
export function documentToProfile(doc: BuyerProfileDocument): BuyerProfile {
  const n = (v: unknown): number | null => {
    const parsed = num(v)
    return parsed === undefined ? null : parsed
  }
  return {
    partnerId: doc.partner_id ?? '',
    soldOn: doc.sold_on ?? null,
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
    // Only when the document speaks about it, so a document from before #1639 maps as it always did.
    ...(doc.click_delivery === undefined ? {} : { clickDelivery: doc.click_delivery === null ? null : clickDeliveryFromDocument(doc.click_delivery) }),
    // Shown only, never judged; carried so validateProfile can refuse a value outside the list.
    ...(doc.display_time_zone === undefined ? {} : { displayTimeZone: doc.display_time_zone }),
    // Absent maps to no key, which the box reads as no cap, like null.
    ...(doc.collections_max_percent === undefined ? {} : { collectionsMaxPercent: n(doc.collections_max_percent) }),
  }
}
