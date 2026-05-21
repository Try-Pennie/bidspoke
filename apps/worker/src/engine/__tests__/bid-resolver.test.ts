/**
 * Bid resolver — dispatch tests for formula / api / matrix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveBid, evaluateFormula, BidResolverConfigError } from '../bid-resolver'
import type { PartnerForResolver } from '../bid-resolver'
import type { ExecutionContext } from '../../types'
import type { Env } from '../../index'

function makeCtx(payload: Record<string, unknown> = {}): ExecutionContext {
  return {
    trigger: { payload, source: 'test', workflow_id: 'wf-1', org_id: '', trace_id: 'trace-1' },
    steps: {},
    env: {},
  }
}

function makePartner(overrides: Partial<PartnerForResolver> = {}): PartnerForResolver {
  return {
    id: 'p-1',
    slug: 'test-partner',
    api_endpoint: null,
    cf_secret_key: null,
    bid_formula: null,
    bid_resolver_type: null,
    bid_resolver_config: null,
    response_classification: null,
    alert_config: null,
    ...overrides,
  }
}

const env = {} as Env

describe('resolveBid — dispatch by bid_resolver_type', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('formula resolver: reads bid_resolver_config.formula', async () => {
    const partner = makePartner({
      bid_resolver_type: 'formula',
      bid_resolver_config: { formula: 'debt_amount * 0.5' },
    })
    const result = await resolveBid(partner, makeCtx({ debt_amount: 1000 }), env)
    expect(result.bid).toBe(500)
    expect(result.raw).toBeNull()
  })

  it('formula resolver: falls back to legacy bid_formula when config missing', async () => {
    const partner = makePartner({
      bid_resolver_type: 'formula',
      bid_resolver_config: null,
      bid_formula: 'debt_amount * 0.65',
    })
    const result = await resolveBid(partner, makeCtx({ debt_amount: 100 }), env)
    expect(result.bid).toBe(65)
  })

  it('api resolver: POSTs to api_endpoint and reads bid', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ bid: 42 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://partner.example/bid',
    })
    const result = await resolveBid(partner, makeCtx({ debt: 5000 }), env)
    expect(result.bid).toBe(42)
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://partner.example/bid')
    expect((init as RequestInit).method).toBe('POST')
  })

  it('matrix resolver: requires a Supabase client', async () => {
    const partner = makePartner({
      bid_resolver_type: 'matrix',
      bid_resolver_config: { bid_config_id: 'abc' },
    })
    await expect(resolveBid(partner, makeCtx(), env)).rejects.toThrow(BidResolverConfigError)
  })

  it('matrix resolver: errors when bid_config_id is missing', async () => {
    const partner = makePartner({
      bid_resolver_type: 'matrix',
      bid_resolver_config: {},
    })
    const fakeSupabase = { from: () => ({}) } as never
    await expect(resolveBid(partner, makeCtx(), env, fakeSupabase)).rejects.toThrow(/bid_config_id/)
  })

  it('legacy fallback: api_endpoint set + no resolver_type -> api', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ bid: 99 }), { status: 200 })
    )
    const partner = makePartner({
      bid_resolver_type: null,
      api_endpoint: 'https://x',
      bid_formula: 'debt_amount * 1', // ignored because api_endpoint wins
    })
    const result = await resolveBid(partner, makeCtx({ debt_amount: 1 }), env)
    expect(result.bid).toBe(99)
  })

  it('legacy fallback: bid_formula set + no api -> formula', async () => {
    const partner = makePartner({
      bid_resolver_type: null,
      api_endpoint: null,
      bid_formula: 'debt_amount * 2',
    })
    const result = await resolveBid(partner, makeCtx({ debt_amount: 50 }), env)
    expect(result.bid).toBe(100)
  })

  it('formula resolver: empty formula returns null bid', async () => {
    const partner = makePartner({
      bid_resolver_type: 'formula',
      bid_resolver_config: { formula: '   ' },
    })
    const result = await resolveBid(partner, makeCtx({ debt_amount: 100 }), env)
    expect(result.bid).toBeNull()
  })

  it('api resolver: rejection signal returns rejected:true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'rejected' }), { status: 200 })
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://x',
      response_classification: {
        rejection_signals: [{ field: 'status', equals: 'rejected' }],
      },
    })
    const result = await resolveBid(partner, makeCtx(), env)
    expect(result.rejected).toBe(true)
    expect(result.bid).toBeNull()
  })

  it('extra_extraction: dot-path values land on result.extra', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { ClickThrough_url: 'https://amone/x', bid: 17 } }), {
        status: 200,
      })
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://am-one',
      bid_resolver_config: { bid_path: 'data.bid' },
      extra_extraction: { clickUrl: 'data.ClickThrough_url' },
    })
    const result = await resolveBid(partner, makeCtx(), env)
    expect(result.bid).toBe(17)
    expect(result.extra).toEqual({ clickUrl: 'https://amone/x' })
  })

  it('bid_path: numeric string is coerced', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { bid: '42.50' } }), { status: 200 })
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://am-one',
      bid_resolver_config: { bid_path: 'data.bid' },
    })
    const result = await resolveBid(partner, makeCtx(), env)
    expect(result.bid).toBe(42.5)
  })

  it('extra_extraction: classifier produces tripoint result label', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, data: { createLead: { id: 'lead-1', resultCode: 1013 } } }),
        { status: 200 }
      )
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://tripoint',
      extra_extraction: {
        leadId: 'data.createLead.id',
        result: { classifier: 'tripoint_result' },
      },
    })
    const result = await resolveBid(partner, makeCtx(), env)
    expect(result.extra).toEqual({ leadId: 'lead-1', result: 'Success' })
  })

  it('extra_extraction: tripoint duplicate code maps to "Duplicate"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, data: { createLead: { id: 'lead-2', resultCode: 1003 } } }),
        { status: 200 }
      )
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://tripoint',
      extra_extraction: { result: { classifier: 'tripoint_result' } },
    })
    const result = await resolveBid(partner, makeCtx(), env)
    expect((result.extra as { result: string }).result).toBe('Duplicate')
  })

  it('bid_comparison_source=formula: API for eligibility, formula for comparison bid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        // Note: API returns bid=99 — must be ignored when comparison_source=formula
        JSON.stringify({ ok: true, data: { createLead: { id: 'lead-3', resultCode: 1013, bidValue: 99 } } }),
        { status: 200 }
      )
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://tripoint',
      bid_comparison_source: 'formula',
      bid_resolver_config: { formula: 'finalDebt * 0.10' },
      extra_extraction: { leadId: 'data.createLead.id' },
    })
    const ctx = makeCtx({ finalDebt: 12000 })
    const result = await resolveBid(partner, ctx, env)
    expect(result.bid).toBe(1200)
    expect((result.extra as { leadId: string }).leadId).toBe('lead-3')
  })

  it('tiered_multiplier: low-tier debt uses default multiplier', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { createLead: { id: 'lead-low', resultCode: 1013 } } }), { status: 200 })
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://tripoint',
      bid_comparison_source: 'formula',
      bid_resolver_config: {
        pricing_mode: 'tiered_multiplier',
        source_field: 'trigger.payload.finalDebt',
        tiers: [{ above: 12499, multiplier: 0.13 }],
        default_multiplier: 0.10,
      },
    })
    const ctx = makeCtx({ finalDebt: 10000 })
    const result = await resolveBid(partner, ctx, env)
    expect(result.bid).toBeCloseTo(1000, 5)
  })

  it('tiered_multiplier: high-tier debt uses tier multiplier', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { createLead: { id: 'lead-high', resultCode: 1013 } } }), { status: 200 })
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://tripoint',
      bid_comparison_source: 'formula',
      bid_resolver_config: {
        pricing_mode: 'tiered_multiplier',
        source_field: 'trigger.payload.finalDebt',
        tiers: [{ above: 12499, multiplier: 0.13 }],
        default_multiplier: 0.10,
      },
    })
    const ctx = makeCtx({ finalDebt: 20000 })
    const result = await resolveBid(partner, ctx, env)
    expect(result.bid).toBeCloseTo(2600, 5)
  })

  it('tiered_multiplier: source_field resolves a steps.X.output.Y path', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://tripoint',
      bid_comparison_source: 'formula',
      bid_resolver_config: {
        pricing_mode: 'tiered_multiplier',
        source_field: 'steps.eligibility.output.final',
        tiers: [{ above: 12499, multiplier: 0.13 }],
        default_multiplier: 0.10,
      },
    })
    const ctx: ExecutionContext = {
      trigger: { payload: {}, source: 't', workflow_id: '', org_id: '', trace_id: '' },
      steps: { eligibility: { status: 'completed', output: { final: 15000 } } },
      env: {},
    }
    const result = await resolveBid(partner, ctx, env)
    expect(result.bid).toBeCloseTo(15000 * 0.13, 5)
  })

  it('tiered_multiplier: missing source value returns null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://tripoint',
      bid_comparison_source: 'formula',
      bid_resolver_config: {
        pricing_mode: 'tiered_multiplier',
        source_field: 'steps.eligibility.output.final',
        tiers: [{ above: 12499, multiplier: 0.13 }],
        default_multiplier: 0.10,
      },
    })
    const result = await resolveBid(partner, makeCtx(), env)
    expect(result.bid).toBeNull()
  })

  it('tiered_multiplier: tiers evaluated highest-first', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://tripoint',
      bid_comparison_source: 'formula',
      bid_resolver_config: {
        pricing_mode: 'tiered_multiplier',
        source_field: 'trigger.payload.finalDebt',
        // Note: order intentionally scrambled; resolver should sort highest-first.
        tiers: [
          { above: 5000, multiplier: 0.12 },
          { above: 12499, multiplier: 0.13 },
          { above: 25000, multiplier: 0.15 },
        ],
        default_multiplier: 0.10,
      },
    })
    // 30000 -> hits the 25000 tier (highest match)
    const ctx = makeCtx({ finalDebt: 30000 })
    const result = await resolveBid(partner, ctx, env)
    expect(result.bid).toBeCloseTo(30000 * 0.15, 5)
  })
})

describe('evaluateFormula', () => {
  it('arithmetic with payload field', () => {
    expect(evaluateFormula('debt_amount * 0.65', makeCtx({ debt_amount: 10000 }))).toBe(6500)
  })

  it('resolves steps.X.output.Y references', () => {
    const ctx: ExecutionContext = {
      trigger: { payload: { finalDebt: 12000 }, source: 't', workflow_id: '', org_id: '', trace_id: '' },
      steps: {
        constants: { status: 'completed', output: { tripointMultiplierLow: 0.10, tripointMultiplierHigh: 0.13 } },
      },
      env: {},
    }
    expect(
      evaluateFormula(
        'finalDebt > 12499 ? finalDebt * steps.constants.output.tripointMultiplierHigh : finalDebt * steps.constants.output.tripointMultiplierLow',
        ctx
      )
    ).toBeCloseTo(1200, 5)
  })

  it('high-debt branch uses tripointMultiplierHigh', () => {
    const ctx: ExecutionContext = {
      trigger: { payload: { finalDebt: 20000 }, source: 't', workflow_id: '', org_id: '', trace_id: '' },
      steps: {
        constants: { status: 'completed', output: { tripointMultiplierLow: 0.10, tripointMultiplierHigh: 0.13 } },
      },
      env: {},
    }
    expect(
      evaluateFormula(
        'finalDebt > 12499 ? finalDebt * steps.constants.output.tripointMultiplierHigh : finalDebt * steps.constants.output.tripointMultiplierLow',
        ctx
      )
    ).toBeCloseTo(2600, 5)
  })

  it('resolves env.X references', () => {
    const ctx: ExecutionContext = {
      trigger: { payload: {}, source: 't', workflow_id: '', org_id: '', trace_id: '' },
      steps: {},
      env: { FACTOR: '0.5' },
    }
    expect(evaluateFormula('env.FACTOR * 200', ctx)).toBe(100)
  })

  it('Math.floor', () => {
    expect(evaluateFormula('Math.floor(debt_amount / 100)', makeCtx({ debt_amount: 12345 }))).toBe(123)
  })

  it('missing field -> NaN -> null', () => {
    expect(evaluateFormula('missing * 2', makeCtx({}))).toBeNull()
  })

  it('whitespace-only formula returns null', () => {
    expect(evaluateFormula('   ', makeCtx({}))).toBeNull()
  })

  it('string number coerced', () => {
    expect(evaluateFormula('debt * 2', makeCtx({ debt: '50' }))).toBe(100)
  })

  it('invalid expression returns null instead of throwing', () => {
    expect(evaluateFormula('this is not js', makeCtx({}))).toBeNull()
  })

  it('resolves context.X via ctx.bidGroupContext (BidGroup-scoped values)', () => {
    const ctx: ExecutionContext = {
      trigger: { payload: {}, source: 't', workflow_id: '', org_id: '', trace_id: '' },
      steps: {},
      env: {},
      bidGroupContext: { finalDebt: 15000 },
    }
    expect(evaluateFormula('context.finalDebt * 0.13', ctx)).toBeCloseTo(1950, 5)
  })

  it('context.X is undefined when bidGroupContext not set (returns null bid)', () => {
    const ctx: ExecutionContext = {
      trigger: { payload: {}, source: 't', workflow_id: '', org_id: '', trace_id: '' },
      steps: {},
      env: {},
    }
    expect(evaluateFormula('context.finalDebt * 0.13', ctx)).toBeNull()
  })

  it('tiered_multiplier: source_field reads from context.finalDebt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { createLead: { id: 'lead-1', resultCode: 1013 } } }), { status: 200 })
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://tripoint',
      bid_comparison_source: 'formula',
      bid_resolver_config: {
        pricing_mode: 'tiered_multiplier',
        source_field: 'context.finalDebt',
        tiers: [{ above: 12499, multiplier: 0.0013 }],
        default_multiplier: 0.0009,
      },
    })
    const ctx: ExecutionContext = {
      trigger: { payload: {}, source: 't', workflow_id: '', org_id: '', trace_id: '' },
      steps: {},
      env: {},
      bidGroupContext: { finalDebt: 40000 },
    }
    const result = await resolveBid(partner, ctx, env)
    expect(result.bid).toBeCloseTo(40000 * 0.0013, 5)  // 52.0
  })
})
