/**
 * The scheduled half of the Tripoint pricing comparison (#1166).
 *
 * Drives the real check against a recording Supabase double and a fake formula
 * reader, so it sees the alert messages actually sent. Salesforce is a seam, not
 * a mock of the check's own logic: the formula text the fake returns is the real
 * one read from the org on 2026-09-06 (L48).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({
  notifyExportFailure: vi.fn().mockResolvedValue(undefined),
  notifyExportRecovery: vi.fn().mockResolvedValue(undefined),
}))

import { checkTripointPricing, TRIPOINT_PRICING_JOB, type TripointPricingDeps } from '../tripoint-pricing-check'
import { notifyExportFailure } from '../export-alerts'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

const env = { IDEMPOTENCY: undefined } as unknown as Env

const LEAD_FORMULA =
  'IF(ISPICKVAL(External_Exchange_Status__c, "Completed"), IF(ExternalPartnerName__c = "Engine", TotalPayout__c, ' +
  'IF(ExternalPartnerName__c = "Tripoint", IF(AND(ExternalDebtAmount__c >= 10000, ExternalDebtAmount__c <= 12499), ' +
  'ExternalDebtAmount__c * 0.0009, IF(ExternalDebtAmount__c >= 12500, ExternalDebtAmount__c * 0.0012, 0)), ' +
  'IF(ExternalPartnerName__c = "AmOne", AmOneBid__c, 0))), 0)'

function config(highMultiplier: number) {
  return {
    pricing_mode: 'tiered_multiplier',
    source_field: 'context.finalDebt',
    tiers: [{ above: 12499, multiplier: highMultiplier }],
    default_multiplier: 0.0009,
  }
}

/** Answers the one partner_configs read and records the slug it was asked for. */
function supabaseDouble(answer: { data?: unknown; error?: unknown }) {
  const slugs: string[] = []
  const client = {
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, slug: string) => {
          slugs.push(`${table}:${slug}`)
          return {
            maybeSingle: () => Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null }),
          }
        },
      }),
    }),
  } as unknown as SupabaseClient
  return { client, slugs }
}

const GEOFF_TIERS = [
  { population: 'engine', debtFrom: 12500, debtTo: 15000, multiplier: 0.0012 },
  { population: 'engine', debtFrom: 15000, debtTo: null, multiplier: 0.0013 },
]

/** The seams, with the Engine tiers read answering "no enabled profile" unless a test says otherwise. */
function seams(over: Partial<TripointPricingDeps> = {}): TripointPricingDeps {
  return { readFormula: async () => LEAD_FORMULA, readEngineTiers: async () => null, readFormulaChange: async () => null, ...over }
}

type SentRemedy = { title?: string; context?: string; fixHint?: string }

function sentRemedy(): SentRemedy | undefined {
  const call = vi.mocked(notifyExportFailure).mock.calls.find((c) => c[1] === TRIPOINT_PRICING_JOB)
  return call?.[4] as SentRemedy | undefined
}

function alerted(): string[] {
  return vi
    .mocked(notifyExportFailure)
    .mock.calls.filter((c) => c[1] === TRIPOINT_PRICING_JOB)
    .flatMap((c) => c[2] as string[])
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
})

describe('checkTripointPricing', () => {
  it('tells the reader what to do about a pricing disagreement, not to check Snowflake', async () => {
    // The shared alerter's default wording is written for the export jobs. A
    // pricing alert that ends "check Snowflake availability and the export
    // credentials" sends whoever reads it to the wrong product (L399).
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0013) } })

    await checkTripointPricing(env, db.client, seams())

    const remedy = sentRemedy()
    expect(remedy).toBeDefined()
    expect(remedy?.title).toBe("Tripoint rates don't match Salesforce")
    expect(remedy?.fixHint).toMatch(/Partners/)
    expect(remedy?.fixHint).toMatch(/Tripoint/)
    expect(remedy?.fixHint).not.toMatch(/Snowflake availability|export credentials/i)
  })

  it('is silent, and still reports a clean run to the alerter, when both rules agree', async () => {
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0012) } })

    const r = await checkTripointPricing(env, db.client, seams())

    expect(db.slugs).toEqual(['partner_configs:tripoint'])
    expect(r.differences).toEqual([])
    expect(r.alerted).toBe(false)
    // An empty list is the recovery signal that clears a previous alert.
    expect(vi.mocked(notifyExportFailure)).toHaveBeenCalledTimes(1)
    expect(alerted()).toEqual([])
    // The standing note is carried in the result, never sent.
    expect(r.notes.map((n) => n.code)).toEqual(['floor-not-modelled', 'engine-tiers-none'])
  })

  it('alerts the one figure that drifted, naming both numbers', async () => {
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0013) } })

    const r = await checkTripointPricing(env, db.client, seams())

    expect(r.differences.map((d) => d.code)).toEqual(['high-multiplier-disagrees'])
    expect(r.alerted).toBe(true)
    expect(alerted()).toEqual(['For Main Flow leads with $12,500 or more of debt, Bidspoke pays Tripoint 0.13% of the debt, but Salesforce books 0.12%.'])
  })

  it('says who last changed the Salesforce formula and when, in Eastern time', async () => {
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0013) } })

    await checkTripointPricing(env, db.client, seams({
      // 00:30 UTC on Oct 1 is still Sep 30 in New York, which is the day a
      // reader in Pennie's office would call it.
      readFormulaChange: async () => ({ at: '2026-10-01T00:30:00.000+0000', by: 'Daniel Wright' }),
    }))

    expect(sentRemedy()?.context).toBe('The Salesforce formula was last changed Sep 30 by Daniel Wright.')
  })

  it('still alerts the mismatch when who changed the formula cannot be read, saying only what it knows', async () => {
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0013) } })

    await checkTripointPricing(env, db.client, seams({
      readFormulaChange: async () => ({ at: '2026-09-30T17:32:20.000+0000', by: null }),
    }))
    expect(sentRemedy()?.context).toBe('The Salesforce formula was last changed Sep 30.')

    vi.mocked(notifyExportFailure).mockClear()
    await checkTripointPricing(env, db.client, seams({
      readFormulaChange: async () => {
        throw new Error('Tooling 500')
      },
    }))
    expect(alerted()).toEqual(['For Main Flow leads with $12,500 or more of debt, Bidspoke pays Tripoint 0.13% of the debt, but Salesforce books 0.12%.'])
    expect(sentRemedy()?.context).toBeUndefined()
  })

  it('a check that could not compare is titled as not having run, with no mismatch fix', async () => {
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0012) } })

    await checkTripointPricing(env, db.client, seams({
      readFormula: async () => {
        throw new Error('403 INSUFFICIENT_ACCESS')
      },
    }))

    expect(sentRemedy()?.title).toBe("Tripoint rate check couldn't run")
    expect(sentRemedy()?.fixHint).toBeUndefined()
  })

  it('treats a formula it cannot read from Salesforce as its own finding, never as agreement', async () => {
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0012) } })

    const r = await checkTripointPricing(env, db.client, seams({
      readFormula: async () => {
        throw new Error('Tooling API answered 403 INSUFFICIENT_ACCESS')
      },
    }))

    expect(r.differences.map((d) => d.code)).toEqual(['formula-unreadable'])
    expect(alerted()).toEqual(["The check couldn't read the Salesforce formula: Tooling API answered 403 INSUFFICIENT_ACCESS"])
  })

  it('treats a formula of an unfamiliar shape as its own finding, quoting what it saw', async () => {
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0012) } })

    const r = await checkTripointPricing(env, db.client, seams({
      readFormula: async () => 'IF(ExternalPartnerName__c = "Tripoint", ExternalDebtAmount__c * 0.002, 0)',
    }))

    expect(r.differences.map((d) => d.code)).toEqual(['formula-unrecognised'])
    expect(alerted().join(' ')).toContain('ExternalDebtAmount__c * 0.002')
  })

  it('reports a missing or unreadable partner row rather than comparing against nothing', async () => {
    const missing = supabaseDouble({ data: null })
    const r1 = await checkTripointPricing(env, missing.client, seams())
    expect(r1.differences.map((d) => d.code)).toEqual(['config-missing'])

    const broken = supabaseDouble({ error: { message: 'connection reset' } })
    const r2 = await checkTripointPricing(env, broken.client, seams())
    expect(r2.differences.map((d) => d.code)).toEqual(['config-unreadable'])
    expect(alerted().join(' ')).toContain('connection reset')
  })

  it('never throws: an unexpected failure is alerted as the check failing', async () => {
    const db = {
      from: () => {
        throw new TypeError('from is not a function')
      },
    } as unknown as SupabaseClient

    const r = await checkTripointPricing(env, db, seams())

    expect(r.differences.map((d) => d.code)).toEqual(['failed'])
    expect(r.alerted).toBe(true)
    expect(alerted().join(' ')).toContain('from is not a function')
  })

  it('every note names its population, so a reader never takes the Main Flow rule for the Engine one (ADR 0010)', async () => {
    // The alert lines carry no population: only the Main Flow rule is ever
    // compared, and the alert's title says what it is about.
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0013) } })
    const r = await checkTripointPricing(env, db.client, seams())
    expect(r.notes.map((n) => n.message)).toEqual(expect.arrayContaining([expect.stringMatching(/^Main Flow: /), expect.stringMatching(/^Engine: /)]))
  })

  it('reports the Engine tiers under their population name as a note, never as a difference against the Lead formula', async () => {
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0012) } })
    const r = await checkTripointPricing(env, db.client, seams({ readEngineTiers: async () => GEOFF_TIERS }))
    expect(r.differences).toEqual([])
    expect(r.engine_tiers).toEqual(GEOFF_TIERS)
    const engine = r.notes.find((n) => n.code === 'engine-tiers')
    expect(engine?.message).toMatch(/0\.0012.*0\.0013/)
    expect(alerted()).toEqual([])
  })

  it('treats Engine tiers it cannot read as its own finding, never as there being none (L98)', async () => {
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0012) } })
    const r = await checkTripointPricing(env, db.client, seams({
      readEngineTiers: async () => {
        throw new Error('buyer profiles read failed for org x: timeout')
      },
    }))
    expect(r.differences.map((d) => d.code)).toEqual(['engine-tiers-unreadable'])
    expect(r.engine_tiers).toBeNull()
    expect(r.notes.map((n) => n.code)).not.toContain('engine-tiers-none')
    expect(alerted()).toEqual(["The check couldn't read Tripoint's Engine rates: buyer profiles read failed for org x: timeout"])
  })
})
