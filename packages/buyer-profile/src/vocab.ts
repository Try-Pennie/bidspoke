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

/**
 * What each operator is called in a rule picker. Both the accept rules editor
 * and the response classification builder read this table, so a rule reads the
 * same in both places and an operator added above is labelled here or the
 * build fails (#1463, L113).
 */
export const SIGNAL_OPERATOR_LABELS: Record<SignalOperator, string> = {
  present: 'is present',
  equals: 'equals',
  contains: 'contains',
  in: 'is one of',
  not_in: 'is none of',
  any_item_contains: 'any item contains',
  any_item_word_prefix_ci: 'any item has a word starting with',
}

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
  not_reached: 'An earlier buyer took the lead',
}

/**
 * The buyer_select node's two modes (#1411). decide_only rehearses everything
 * but the buyer call; live sells. There is no default: a missing or unknown
 * mode is a named failure (L72).
 */
export const BUYER_SELECT_MODES = ['decide_only', 'live'] as const
export type BuyerSelectMode = (typeof BUYER_SELECT_MODES)[number]

/**
 * Why the node as a whole routed where it did, as distinct from why one buyer
 * was out (OUT_REASONS). The two sets are disjoint so a reason is never
 * ambiguous about which it describes.
 */
export const NODE_REASONS = [
  'sold',
  'sell_off_false',
  'bid_not_positive',
  'sell_off_unresolved',
  'lead_key_empty',
  'mode_invalid',
  'payload_invalid',
  'profiles_unavailable',
  'no_eligible_buyer',
  'canary_out',
  'report_only',
  'decide_only',
  'rehearsal_caps_invalid',
  'rehearsal_deadline',
  'buyer_select_handle_unwired',
] as const
export type NodeReason = (typeof NODE_REASONS)[number]

export const NODE_REASON_LABELS: Record<NodeReason, string> = {
  sold: 'Sold to the buyer',
  sell_off_false: 'Not a sell off lead',
  bid_not_positive: 'The bid was zero, so the lead was not for sale',
  sell_off_unresolved: 'The sell off flag could not be read, so the workflow decided',
  lead_key_empty: 'The lead key resolved to nothing',
  mode_invalid: 'The node has no valid mode',
  payload_invalid: 'The sale payload did not resolve to an object',
  profiles_unavailable: 'Buyer profiles could not be read and no earlier copy was held',
  no_eligible_buyer: 'No buyer was eligible for this lead',
  canary_out: 'Outside the live share, so the workflow decided',
  report_only: 'Evaluated and reported only: a test, shadow or local run',
  decide_only: 'Rehearsed without calling a buyer',
  rehearsal_caps_invalid: 'The rehearsal caps variable is not valid JSON caps',
  rehearsal_deadline: 'The rehearsal ran past its deadline',
  buyer_select_handle_unwired: 'The handle the node needed to take is not wired',
}

/**
 * What the buyer_select node records for each buyer it looked at, in the
 * output's `considered` list (#1411). Written by the engine, read by the
 * execution view, so the labels live beside the codes (L113).
 */
export const CONSIDERED_OUTCOMES = ['sold', 'rehearsed', 'declined_by_buyer', 'buyer_error', 'outcome_unknown', 'skipped', 'ineligible', 'eligible', 'not_reached'] as const
export type ConsideredOutcome = (typeof CONSIDERED_OUTCOMES)[number]

export const CONSIDERED_OUTCOME_LABELS: Record<ConsideredOutcome, string> = {
  sold: 'Sold',
  rehearsed: 'Would have been offered the lead',
  declined_by_buyer: 'Declined',
  buyer_error: 'Buyer call failed',
  outcome_unknown: 'Answer not classified',
  skipped: 'Skipped',
  ineligible: 'Not eligible',
  eligible: 'Eligible',
  not_reached: 'Not reached',
}

/** The mode the node actually ran in, which the configured mode plus the run's context decides. */
export const MODE_EFFECTIVE = ['live', 'decide_only', 'report_only'] as const
export type ModeEffective = (typeof MODE_EFFECTIVE)[number]

export const MODE_EFFECTIVE_LABELS: Record<ModeEffective, string> = {
  live: 'Live',
  decide_only: 'Rehearsed without calling a buyer',
  report_only: 'Evaluated and reported only',
}

/** Stated once here and once on the form (L118). */
export const PRIORITY_DIRECTION = '1 is offered the lead first. A lower number outranks a higher one.'

/** A multiplier is a share of the debt, so it can never exceed 1 (Dan, 2026-09-21). */
export const MULTIPLIER_CEILING = 1
