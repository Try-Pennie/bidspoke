/**
 * The scheduled half of the Tripoint pricing comparison (#1166).
 *
 * Drives the real check against a recording Supabase double and a fake formula
 * reader, so it sees the alert messages actually sent. Salesforce is a seam, not
 * a mock of the check's own logic: the formula text the fake returns is the real
 * one read from the org on 2026-09-06 (L48).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../export-alerts', () => ({ notifyExportFailure: vi.fn().mockResolvedValue(undefined) }))

import { checkTripointPricing, TRIPOINT_PRICING_JOB } from '../tripoint-pricing-check'
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

    await checkTripointPricing(env, db.client, { readFormula: async () => LEAD_FORMULA })

    const remedy = vi.mocked(notifyExportFailure).mock.calls[0][4] as { consequence: string; fixHint: string } | undefined
    expect(remedy).toBeDefined()
    expect(remedy?.consequence).not.toMatch(/exported|Snowflake/i)
    expect(remedy?.fixHint).toMatch(/Partners/)
    expect(remedy?.fixHint).toMatch(/Tripoint/)
    expect(remedy?.fixHint).not.toMatch(/Snowflake availability|export credentials/i)
  })

  it('is silent, and still reports a clean run to the alerter, when both rules agree', async () => {
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0012) } })

    const r = await checkTripointPricing(env, db.client, { readFormula: async () => LEAD_FORMULA })

    expect(db.slugs).toEqual(['partner_configs:tripoint'])
    expect(r.differences).toEqual([])
    expect(r.alerted).toBe(false)
    // An empty list is the recovery signal that clears a previous alert.
    expect(vi.mocked(notifyExportFailure)).toHaveBeenCalledTimes(1)
    expect(alerted()).toEqual([])
    // The standing note is carried in the result, never sent.
    expect(r.notes.map((n) => n.code)).toEqual(['floor-not-modelled'])
  })

  it('alerts the one figure that drifted, naming both numbers', async () => {
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0013) } })

    const r = await checkTripointPricing(env, db.client, { readFormula: async () => LEAD_FORMULA })

    expect(r.differences.map((d) => d.code)).toEqual(['high-multiplier-disagrees'])
    expect(r.alerted).toBe(true)
    expect(alerted().join(' ')).toMatch(/0\.0013.*0\.0012/)
  })

  it('treats a formula it cannot read from Salesforce as its own finding, never as agreement', async () => {
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0012) } })

    const r = await checkTripointPricing(env, db.client, {
      readFormula: async () => {
        throw new Error('Tooling API answered 403 INSUFFICIENT_ACCESS')
      },
    })

    expect(r.differences.map((d) => d.code)).toEqual(['formula-unreadable'])
    expect(alerted().join(' ')).toMatch(/could not be read.*403 INSUFFICIENT_ACCESS/)
  })

  it('treats a formula of an unfamiliar shape as its own finding, quoting what it saw', async () => {
    const db = supabaseDouble({ data: { bid_resolver_config: config(0.0012) } })

    const r = await checkTripointPricing(env, db.client, {
      readFormula: async () => 'IF(ExternalPartnerName__c = "Tripoint", ExternalDebtAmount__c * 0.002, 0)',
    })

    expect(r.differences.map((d) => d.code)).toEqual(['formula-unrecognised'])
    expect(alerted().join(' ')).toContain('ExternalDebtAmount__c * 0.002')
  })

  it('reports a missing or unreadable partner row rather than comparing against nothing', async () => {
    const missing = supabaseDouble({ data: null })
    const r1 = await checkTripointPricing(env, missing.client, { readFormula: async () => LEAD_FORMULA })
    expect(r1.differences.map((d) => d.code)).toEqual(['config-missing'])

    const broken = supabaseDouble({ error: { message: 'connection reset' } })
    const r2 = await checkTripointPricing(env, broken.client, { readFormula: async () => LEAD_FORMULA })
    expect(r2.differences.map((d) => d.code)).toEqual(['config-unreadable'])
    expect(alerted().join(' ')).toContain('connection reset')
  })

  it('never throws: an unexpected failure is alerted as the check failing', async () => {
    const db = {
      from: () => {
        throw new TypeError('from is not a function')
      },
    } as unknown as SupabaseClient

    const r = await checkTripointPricing(env, db, { readFormula: async () => LEAD_FORMULA })

    expect(r.differences.map((d) => d.code)).toEqual(['failed'])
    expect(r.alerted).toBe(true)
    expect(alerted().join(' ')).toContain('from is not a function')
  })
})
