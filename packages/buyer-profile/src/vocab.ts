/**
 * The one vocabulary the form, the API and the engine all read (#1408).
 *
 * Every closed set a buyer profile or the buyer_select node uses lives here as a
 * const array, so a picker enumerates from the same list the server refuses
 * against (L611) and a label table is complete at compile time (L113).
 */

export const POPULATIONS = ['engine', 'main_flow', 'lead_economy'] as const
export type Population = (typeof POPULATIONS)[number]

/**
 * A population joins this list in the change that puts a buyer_select node on
 * that workflow (L46). Tiers for any other population are refused, so the form
 * cannot store pricing nothing reads.
 */
export const WIRED_POPULATIONS = ['engine'] as const satisfies readonly Population[]
export type WiredPopulation = (typeof WIRED_POPULATIONS)[number]

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL',
  'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const
export type UsState = (typeof US_STATES)[number]

/** Index matches Postgres `extract(dow ...)`: 0 is Sunday. */
export const DAYS_OF_WEEK = [
  { index: 0, label: 'Sunday' },
  { index: 1, label: 'Monday' },
  { index: 2, label: 'Tuesday' },
  { index: 3, label: 'Wednesday' },
  { index: 4, label: 'Thursday' },
  { index: 5, label: 'Friday' },
  { index: 6, label: 'Saturday' },
] as const
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number]['index']

/** `shadow` already names shadow_mode dry runs, which never reserve; the ledger kind that reserves without a call is `rehearsal` (L118). */
export const LEDGER_KINDS = ['live', 'rehearsal'] as const
export type LedgerKind = (typeof LEDGER_KINDS)[number]

export const SALE_STATUSES = ['reserved', 'accepted', 'declined', 'released', 'unresolved'] as const
export type SaleStatus = (typeof SALE_STATUSES)[number]

export const SIGNAL_OPERATORS = [
  'present',
  'equals',
  'contains',
  'in',
  'not_in',
  'any_item_contains',
  'any_item_word_prefix_ci',
] as const
export type SignalOperator = (typeof SIGNAL_OPERATORS)[number]

export const PAYLOAD_NORMALISERS = ['ssn_digits_9'] as const
export type PayloadNormaliser = (typeof PAYLOAD_NORMALISERS)[number]

export const OUT_REASONS = [
  'inactive',
  'profile_disabled',
  'no_pricing_for_population',
  'missing_lead_field',
  'state_not_allowed',
  'closed',
  'blackout',
  'debt_below_min',
  'debt_above_max',
  'loan_amount_below_min',
  'no_price_for_debt',
  'circuit_open',
  'hourly_lead_cap',
  'daily_lead_cap',
  'hourly_spend_cap',
  'daily_spend_cap',
  'cap_check_error',
  'already_sold',
  'sale_in_flight',
  'live_percent_unset',
  'declined_by_buyer',
  'buyer_error',
  'outcome_unknown',
  'not_reached',
] as const
export type OutReason = (typeof OUT_REASONS)[number]

/** Plain words for the execution view. The Record type makes a missing label a compile error (L113). */
export const OUT_REASON_LABELS: Record<OutReason, string> = {
  inactive: 'Partner is switched off',
  profile_disabled: 'Buyer profile is disabled',
  no_pricing_for_population: 'No pricing for this lead source',
  missing_lead_field: 'A lead field the profile needs is missing or unreadable',
  state_not_allowed: 'State not accepted',
  closed: 'Outside operating hours',
  blackout: 'Day off',
  debt_below_min: 'Debt below the minimum',
  debt_above_max: 'Debt above the maximum',
  loan_amount_below_min: 'Loan amount below the minimum',
  no_price_for_debt: 'No price tier covers this debt',
  circuit_open: 'Circuit breaker open',
  hourly_lead_cap: 'Hourly lead cap reached',
  daily_lead_cap: 'Daily lead cap reached',
  hourly_spend_cap: 'Hourly spend cap reached',
  daily_spend_cap: 'Daily spend cap reached',
  cap_check_error: 'Cap check could not be completed',
  already_sold: 'Lead already sold',
  sale_in_flight: 'Another sale of this lead is in progress',
  live_percent_unset: 'Live share variable is not set',
  declined_by_buyer: 'Declined by the buyer',
  buyer_error: 'Buyer call failed before the lead was processed',
  outcome_unknown: 'Buyer response could not be classified',
  not_reached: 'Not reached, an earlier buyer took the lead',
}

/** Stated once here and once on the form (L118). */
export const PRIORITY_DIRECTION = '1 is offered the lead first. A lower number outranks a higher one.'

/** A multiplier is a share of the debt, so it can never exceed 1 (Dan, 2026-09-21). */
export const MULTIPLIER_CEILING = 1
