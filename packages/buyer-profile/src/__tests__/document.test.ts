/**
 * The profile DOCUMENT is the wire shape the API and the form exchange and the
 * shape save_buyer_profile returns (snake_case, windows and blackouts with
 * notes, tiers). BuyerProfile is the evaluator's shape. One mapping between
 * them here (#1412), so the form's worked example, the API's validation and
 * the engine cannot disagree about a field (L83).
 */
import { describe, expect, it } from 'vitest'
import { documentToProfile, parseProfileDocument, type BuyerProfileDocument } from '../document'

const doc: BuyerProfileDocument = {
  partner_id: '33333333-3333-4333-8333-333333333331',
  version: 3,
  sold_on: 'offer',
  is_enabled: true,
  priority: 1,
  allowed_states: ['TX', 'FL'],
  debt_min: 15000,
  debt_max: null,
  loan_amount_min: null,
  hourly_lead_cap: 50,
  daily_lead_cap: 500,
  hourly_spend_cap_cents: null,
  daily_spend_cap_cents: 1_000_000,
  windows: [{ day_of_week: 1, opens_minute: 540, closes_minute: 1080 }],
  blackout_dates: [{ date: '2027-12-25', note: 'Christmas' }],
  tiers: [{ population: 'engine', debt_from: 15000, debt_to: null, multiplier: 0.0012 }],
}

describe('documentToProfile', () => {
  it('maps every field the evaluator reads, keeping numbers numeric', () => {
    expect(documentToProfile(doc)).toEqual({
      partnerId: doc.partner_id,
      soldOn: 'offer',
      isEnabled: true,
      priority: 1,
      allowedStates: ['TX', 'FL'],
      debtMin: 15000,
      debtMax: null,
      loanAmountMin: null,
      hourlyLeadCap: 50,
      dailyLeadCap: 500,
      hourlySpendCapCents: null,
      dailySpendCapCents: 1_000_000,
      windows: [{ dayOfWeek: 1, opensMinute: 540, closesMinute: 1080 }],
      blackoutDates: ['2027-12-25'],
      tiers: [{ population: 'engine', debtFrom: 15000, debtTo: null, multiplier: 0.0012 }],
    })
  })

  it('accepts the numeric strings Postgres returns for numeric columns', () => {
    const fromSql = { ...doc, debt_min: '15000.00', tiers: [{ population: 'engine', debt_from: '15000.00', debt_to: '25000.50', multiplier: '0.001200' }] } as unknown as BuyerProfileDocument
    const p = documentToProfile(fromSql)
    expect(p.debtMin).toBe(15000)
    expect(p.tiers[0]).toEqual({ population: 'engine', debtFrom: 15000, debtTo: 25000.5, multiplier: 0.0012 })
  })
})

describe('parseProfileDocument', () => {
  it('accepts a well formed document and returns it typed', () => {
    const r = parseProfileDocument(doc)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.document.tiers).toHaveLength(1)
  })

  it('names every field that is missing or of the wrong type, not only the first (L688)', () => {
    const r = parseProfileDocument({ ...doc, priority: 'one', allowed_states: 'TX', windows: [{ day_of_week: 'monday' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.map((e) => e.path).sort()).toEqual(['allowed_states', 'priority', 'windows[0].closes_minute', 'windows[0].day_of_week', 'windows[0].opens_minute'])
    }
  })

  it('refuses a non object, a null and an array', () => {
    for (const bad of [null, 'doc', 42, []]) {
      const r = parseProfileDocument(bad)
      expect(r.ok, String(bad)).toBe(false)
    }
  })

  it('tolerates the fields the database owns being absent on a NEW document (partner_id and version)', () => {
    const { partner_id: _p, version: _v, ...fresh } = doc
    const r = parseProfileDocument(fresh)
    expect(r.ok).toBe(true)
  })
})

describe('sold_on on the document (#1541)', () => {
  it('carries a click kind through the parse and into the evaluator shape', () => {
    const r = parseProfileDocument({ ...doc, sold_on: 'click' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.document.sold_on).toBe('click')
      expect(documentToProfile(r.document).soldOn).toBe('click')
    }
  })

  it('reads an absent or null kind as not chosen yet, which the validator refuses, never as offer', () => {
    const { sold_on: _s, ...absent } = doc
    for (const input of [absent, { ...doc, sold_on: null }]) {
      const r = parseProfileDocument(input)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.document.sold_on).toBeNull()
    }
  })

  it('refuses a kind outside the vocabulary by name', () => {
    const r = parseProfileDocument({ ...doc, sold_on: 'phone' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.path)).toEqual(['sold_on'])
  })
})
