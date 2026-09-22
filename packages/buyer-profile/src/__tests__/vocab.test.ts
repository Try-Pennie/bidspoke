import { describe, expect, it } from 'vitest'
import {
  BUYER_SELECT_MODES,
  DAYS_OF_WEEK,
  LEDGER_KINDS,
  MULTIPLIER_CEILING,
  NODE_REASONS,
  NODE_REASON_LABELS,
  OUT_REASONS,
  OUT_REASON_LABELS,
  PAYLOAD_NORMALISERS,
  POPULATIONS,
  PRIORITY_DIRECTION,
  SALE_STATUSES,
  SIGNAL_OPERATORS,
  SIGNAL_OPERATOR_LABELS,
  US_STATES,
  WIRED_POPULATIONS,
} from '../vocab'

const noDashOrEmoji = /^[^\u{2013}\u{2014}\u{1F300}-\u{1FAFF}]*$/u

describe('populations', () => {
  it('names the three lead populations', () => {
    expect([...POPULATIONS]).toEqual(['engine', 'main_flow', 'lead_economy'])
  })
  it('wires only Engine at this rollout, and every wired population is a population (L46)', () => {
    expect([...WIRED_POPULATIONS]).toEqual(['engine'])
    for (const p of WIRED_POPULATIONS) expect(POPULATIONS).toContain(p)
  })
})

describe('US states', () => {
  it('holds the 50 states plus DC, each a distinct two letter upper case code', () => {
    expect(US_STATES).toHaveLength(51)
    expect(new Set(US_STATES).size).toBe(51)
    for (const s of US_STATES) expect(s).toMatch(/^[A-Z]{2}$/)
    expect(US_STATES).toContain('DC')
    expect(US_STATES).toContain('NY')
    expect(US_STATES).toContain('CA')
  })
  it('carries no territories', () => {
    for (const t of ['PR', 'GU', 'VI', 'AS', 'MP']) expect(US_STATES).not.toContain(t)
  })
})

describe('out reasons', () => {
  it('has every reason the plan names', () => {
    const expected = [
      'inactive', 'profile_disabled', 'no_pricing_for_population', 'missing_lead_field',
      'state_not_allowed', 'closed', 'blackout', 'debt_below_min', 'debt_above_max',
      'loan_amount_below_min', 'no_price_for_debt', 'circuit_open', 'hourly_lead_cap',
      'daily_lead_cap', 'hourly_spend_cap', 'daily_spend_cap', 'cap_check_error',
      'already_sold', 'sale_in_flight', 'live_percent_unset', 'declined_by_buyer',
      'buyer_error', 'outcome_unknown', 'not_reached',
    ]
    expect([...OUT_REASONS].sort()).toEqual(expected.sort())
  })
  it('labels every reason, in plain words with no dash or emoji (L113)', () => {
    for (const r of OUT_REASONS) {
      const label = OUT_REASON_LABELS[r]
      expect(label, r).toBeTruthy()
      expect(label).toMatch(noDashOrEmoji)
      expect(label).not.toContain('_')
    }
    expect(Object.keys(OUT_REASON_LABELS).sort()).toEqual([...OUT_REASONS].sort())
  })
})

describe('the rest of the vocabulary', () => {
  it('days of week start at Sunday as 0, matching Postgres dow', () => {
    expect(DAYS_OF_WEEK).toHaveLength(7)
    expect(DAYS_OF_WEEK[0]).toEqual({ index: 0, label: 'Sunday' })
    expect(DAYS_OF_WEEK[6]).toEqual({ index: 6, label: 'Saturday' })
  })
  it('names the ledger kinds live and rehearsal, never shadow (L118)', () => {
    expect([...LEDGER_KINDS]).toEqual(['live', 'rehearsal'])
  })
  it('names the sale statuses', () => {
    expect([...SALE_STATUSES]).toEqual(['reserved', 'accepted', 'declined', 'released', 'unresolved'])
  })
  it('names the signal operators, the existing five plus the two array operators', () => {
    expect([...SIGNAL_OPERATORS]).toEqual([
      'present', 'equals', 'contains', 'in', 'not_in', 'any_item_contains', 'any_item_word_prefix_ci',
    ])
  })
  it('labels every signal operator once, for both rule editors to read (#1463)', () => {
    expect(Object.keys(SIGNAL_OPERATOR_LABELS)).toEqual([...SIGNAL_OPERATORS])
    for (const op of SIGNAL_OPERATORS) expect(SIGNAL_OPERATOR_LABELS[op].length).toBeGreaterThan(0)
  })
  it('names one payload normaliser', () => {
    expect([...PAYLOAD_NORMALISERS]).toEqual(['ssn_digits_9'])
  })
  it('states the priority direction once and caps the multiplier at 1', () => {
    expect(PRIORITY_DIRECTION).toBe('1 is offered the lead first. A lower number outranks a higher one.')
    expect(MULTIPLIER_CEILING).toBe(1)
  })
})

describe('buyer_select node vocabulary (#1411)', () => {
  it('names the two modes, decide only first because it is the safe one', () => {
    expect([...BUYER_SELECT_MODES]).toEqual(['decide_only', 'live'])
  })
  it('names every node level reason the executor can route on, disjoint from the per buyer out reasons', () => {
    const expected = [
      'sold', 'sell_off_false', 'bid_not_positive', 'sell_off_unresolved', 'lead_key_empty', 'mode_invalid',
      'payload_invalid', 'profiles_unavailable', 'no_eligible_buyer', 'canary_out', 'report_only',
      'decide_only', 'rehearsal_caps_invalid', 'rehearsal_deadline', 'buyer_select_handle_unwired',
    ]
    expect([...NODE_REASONS].sort()).toEqual(expected.sort())
    for (const r of NODE_REASONS) expect(OUT_REASONS as readonly string[]).not.toContain(r)
  })
  it('labels every node level reason in plain words with no dash or emoji (L113)', () => {
    for (const r of NODE_REASONS) {
      const label = NODE_REASON_LABELS[r]
      expect(label, r).toBeTruthy()
      expect(label).toMatch(noDashOrEmoji)
      expect(label).not.toContain('_')
    }
    expect(Object.keys(NODE_REASON_LABELS).sort()).toEqual([...NODE_REASONS].sort())
  })
})
