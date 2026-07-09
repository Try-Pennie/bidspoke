/**
 * Bid resolver — dispatch tests for formula / api / matrix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveBid, evaluateFormula, BidResolverConfigError } from '../bid-resolver'
import { PartnerApiError } from '../partner-bid-error'
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

  it('api resolver: cancels the bid POST when the step-level signal aborts (#66)', async () => {
    let captured: AbortSignal | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      captured = (init as RequestInit | undefined)?.signal ?? undefined
      return Promise.resolve(new Response('{"bid":1}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    })
    const partner = makePartner({ bid_resolver_type: 'api', api_endpoint: 'https://partner.example/bid' })
    const parent = new AbortController()
    parent.abort()
    await resolveBid(partner, makeCtx({ debt: 5000 }), env, undefined, parent.signal)
    expect(captured).toBeDefined()
    expect(captured!.aborted).toBe(true)
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
    expect(result.status).toBe(200)
    expect(result).not.toHaveProperty('http_status')
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://partner.example/bid')
    expect((init as RequestInit).method).toBe('POST')
  })

  it('api resolver: throws a distinct permanent credential error and skips the call when cf_secret_key is set but blank (#411)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://partner.example/bid',
      cf_secret_key: 'PARTNER_SECRET', // declared, but `env` has no such value
    })
    const err = await resolveBid(partner, makeCtx({ debt: 5000 }), env).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PartnerApiError)
    expect((err as PartnerApiError).errorType).toBe('permanent')
    expect((err as Error).message).toContain('PARTNER_SECRET')
    // Never send an unauthenticated request that would just 401.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('api resolver: sends the Authorization header when cf_secret_key resolves to a value', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ bid: 7 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://partner.example/bid',
      cf_secret_key: 'PARTNER_SECRET',
    })
    const envWithSecret = { PARTNER_SECRET: 'sk-live-123' } as unknown as Env
    await resolveBid(partner, makeCtx({ debt: 5000 }), envWithSecret)
    const [, init] = fetchSpy.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-live-123' })
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
    expect(result.status).toBe(200)
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

  it('rejection still extracts extras (Tripoint Duplicate keeps leadId)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, data: { createLead: { id: 'dup-lead-123', resultCode: 1003 } } }),
        { status: 200 }
      )
    )
    const partner = makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://tripoint',
      bid_comparison_source: 'formula',
      bid_resolver_config: { pricing_mode: 'tiered_multiplier', source_field: 'context.finalDebt', tiers: [{ above: 12499, multiplier: 0.0013 }], default_multiplier: 0.0009 },
      extra_extraction: {
        leadId: 'data.createLead.id',
        result: { classifier: 'tripoint_result' },
      },
      response_classification: {
        rejection_signals: [
          { field: 'data.createLead.resultCode', not_in: [1000, 1001, 1013, 1014, 1015, 1016, 1017] },
        ],
      },
    })
    const result = await resolveBid(partner, makeCtx(), env)
    expect(result.rejected).toBe(true)
    expect(result.bid).toBeNull()
    expect(result.extra).toEqual({ leadId: 'dup-lead-123', result: 'Duplicate' })
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

// Issue #506 (AUD-043): the default top-level bid scan accepted anything
// parseFloat would chew on, including non-finite values. JSON.parse('1e999')
// yields Infinity as a genuine number, and parseFloat('Infinity') yields
// Infinity too. An infinite bid beats every honest bid, so a partner whose
// response shape drifts silently hijacks the auction and writes a non-finite
// bid_cents. The bid_path branch already routed through coerceNumeric and was
// never affected; only the default scan was.
describe('api resolver: non-finite bids are rejected (#506)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function apiPartner(overrides: Partial<PartnerForResolver> = {}) {
    return makePartner({
      bid_resolver_type: 'api',
      api_endpoint: 'https://partner.example/bid',
      ...overrides,
    })
  }

  function mockBody(body: string) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
  }

  it('rejects a numeric overflow literal that JSON.parse turns into Infinity', async () => {
    mockBody('{"bid":1e999}')
    const result = await resolveBid(apiPartner(), makeCtx({ debt: 5000 }), env)
    expect(result.bid).toBeNull()
    expect(result.bid_reason).toBe('no recognized bid field in response')
  })

  it('rejects the string "Infinity", which parseFloat happily accepts', async () => {
    mockBody('{"bid":"Infinity"}')
    expect((await resolveBid(apiPartner(), makeCtx(), env)).bid).toBeNull()
  })

  it('rejects a string overflow literal', async () => {
    mockBody('{"bid":"1e999"}')
    expect((await resolveBid(apiPartner(), makeCtx(), env)).bid).toBeNull()
  })

  it('rejects -Infinity rather than treating it as a real (losing) bid', async () => {
    mockBody('{"bid":"-Infinity"}')
    expect((await resolveBid(apiPartner(), makeCtx(), env)).bid).toBeNull()
  })

  it('rejects a NaN-valued number field instead of returning NaN as a bid', async () => {
    mockBody('{"bid":"not-a-number","price":"NaN"}')
    expect((await resolveBid(apiPartner(), makeCtx(), env)).bid).toBeNull()
  })

  it('still accepts an ordinary finite bid, as a number or a numeric string', async () => {
    mockBody('{"bid":42}')
    expect((await resolveBid(apiPartner(), makeCtx(), env)).bid).toBe(42)
    vi.restoreAllMocks()
    mockBody('{"bid":"42.5"}')
    expect((await resolveBid(apiPartner(), makeCtx(), env)).bid).toBe(42.5)
  })

  it('still accepts a legitimate zero bid (a decline, not a missing field)', async () => {
    mockBody('{"bid":0}')
    expect((await resolveBid(apiPartner(), makeCtx(), env)).bid).toBe(0)
  })

  it('falls through to the next candidate field when the first is non-finite, matching the existing unparseable-value behavior', async () => {
    mockBody('{"bid":"Infinity","amount":25}')
    expect((await resolveBid(apiPartner(), makeCtx(), env)).bid).toBe(25)
  })

  it('leaves the bid_path branch alone: it already rejected non-finite values', async () => {
    mockBody('{"data":{"bid":1e999}}')
    const partner = apiPartner({ bid_resolver_config: { bid_path: 'data.bid' } })
    const result = await resolveBid(partner, makeCtx(), env)
    expect(result.bid).toBeNull()
    expect(result.bid_reason).toContain("bid_path 'data.bid'")
  })
})
