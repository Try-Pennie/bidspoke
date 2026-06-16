/**
 * Partner Bid node — PRD Section 5.3
 * Tests: cap enforcement, circuit breaker, formula evaluation, API call, skips.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executePartnerBidNode, evaluateFormula, recordBreakerOutcome } from '../partner-bid'
import { PartnerApiError } from '../../partner-bid-error'
import type { NodeDefinition, ExecutionContext } from '../../../types'
import type { Env } from '../../../index'
import type { PartnerBidOutput } from '../partner-bid'

// No module-level mocks — we mock the DO stubs via makeEnv() instead

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(config: Record<string, unknown> = {}): NodeDefinition {
  return { id: 'n1', namespace: 'tripoint_bid', type: 'partner_bid', config }
}

function makeCtx(payload: Record<string, unknown> = {}): ExecutionContext {
  return {
    trigger: { payload, source: 'test', workflow_id: 'wf-1', org_id: '', trace_id: 'trace-1' },
    steps: {},
    env: {},
  }
}

function makePartner(overrides: Record<string, unknown> = {}) {
  return {
    id: 'partner-1',
    slug: 'tripoint',
    api_endpoint: null,
    cf_secret_key: null,
    daily_cap: null,
    min_bid: null,
    bid_formula: 'debt_amount * 0.65',
    dedup_endpoint: null,
    circuit_error_threshold: 5,
    circuit_window_seconds: 60,
    circuit_cooldown_seconds: 300,
    circuit_enabled: true,
    is_active: true,
    ...overrides,
  }
}

function makeSupabase(partner: ReturnType<typeof makePartner> | null) {
  const chain: unknown = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'single') return () =>
        partner
          ? Promise.resolve({ data: partner, error: null })
          : Promise.resolve({ data: null, error: { message: 'not found' } })
      return () => chain
    },
  })
  return { from: () => chain }
}

function makeCbStub(allowed: boolean, state = allowed ? 'closed' : 'open') {
  return {
    fetch: vi.fn().mockImplementation((url: string) => {
      const path = new URL(url).pathname
      if (path === '/check') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ allowed, state }),
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
    }),
  }
}

function makeCapStub(allowed: boolean, count = allowed ? 1 : 100) {
  return {
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ allowed, count, cap: 100 }),
    }),
  }
}

// A cap stub whose fetch records every path, so refund (#68) can be asserted.
function capStubSpy(allowed = true, count = 1) {
  return {
    fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed, count, cap: 100 }) }),
  }
}
function envWithCap(capStub: { fetch: ReturnType<typeof vi.fn> }) {
  return makeEnv({ DAILY_CAP: { idFromName: vi.fn().mockReturnValue('do-id'), get: vi.fn().mockReturnValue(capStub) } })
}
function capPaths(capStub: { fetch: ReturnType<typeof vi.fn> }): string[] {
  return capStub.fetch.mock.calls.map((c) => String(c[0]))
}

function makeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  const cbStub = makeCbStub(true)
  const capStub = makeCapStub(true)
  return {
    DAILY_CAP: {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue(capStub),
    },
    CIRCUIT_BREAKER: {
      idFromName: vi.fn().mockReturnValue('cb-id'),
      get: vi.fn().mockReturnValue(cbStub),
    },
    ...overrides,
  } as unknown as Env
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executePartnerBidNode', () => {
  beforeEach(() => vi.clearAllMocks())

  // #66: a step-level timeout must cancel the partner dedup call. A pre-aborted
  // parent signal makes the dedup fetch's signal aborted via linkAbort.
  it('cancels the dedup fetch when the step-level signal aborts (#66)', async () => {
    let captured: AbortSignal | undefined
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      captured = init?.signal ?? undefined
      return Promise.resolve({ ok: true, json: async () => ({ duplicate: false }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const parent = new AbortController()
    parent.abort()
    await executePartnerBidNode(
      makeNode({ partner_id: 'p1' }),
      makeCtx({ debt_amount: 10000 }),
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase(makePartner({ dedup_endpoint: 'https://dedup.example' })) as any,
      parent.signal
    )
    expect(captured?.aborted).toBe(true)
    vi.unstubAllGlobals()
  })

  // #68: a reserved cap slot is refunded when the lead wasn't really submitted
  // (duplicate / error), kept on a real partner response (accept/below-min/reject).
  describe('daily cap refund (#68)', () => {
    it('refunds the slot on a duplicate', async () => {
      const capStub = capStubSpy()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ duplicate: true }) }))
      await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }), makeCtx({ debt_amount: 10000 }), envWithCap(capStub),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ daily_cap: 100, dedup_endpoint: 'https://dedup.example' })) as any
      )
      const paths = capPaths(capStub)
      expect(paths.some((p) => p.includes('/check-and-increment'))).toBe(true)
      expect(paths.some((p) => p.includes('/decrement'))).toBe(true)
      vi.unstubAllGlobals()
    })

    it('refunds the slot when the partner call errors', async () => {
      const capStub = capStubSpy()
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
      await expect(executePartnerBidNode(
        makeNode({ partner_id: 'p1' }), makeCtx({ debt_amount: 10000 }), envWithCap(capStub),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ daily_cap: 100, bid_resolver_type: 'api', api_endpoint: 'https://partner.example/bid' })) as any
      )).rejects.toBeDefined()
      expect(capPaths(capStub).some((p) => p.includes('/decrement'))).toBe(true)
      vi.unstubAllGlobals()
    })

    it('keeps the slot on an accepted bid (no refund)', async () => {
      const capStub = capStubSpy()
      await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }), makeCtx({ debt_amount: 10000 }), envWithCap(capStub),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ daily_cap: 100 })) as any
      )
      const paths = capPaths(capStub)
      expect(paths.some((p) => p.includes('/check-and-increment'))).toBe(true)
      expect(paths.some((p) => p.includes('/decrement'))).toBe(false)
    })
  })

  describe('config validation', () => {
    it('throws when partner_id is missing', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(executePartnerBidNode(makeNode(), makeCtx(), makeEnv(), makeSupabase(null) as any))
        .rejects.toThrow(/partner_id/)
    })

    it('throws when partner config is not found in Supabase', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(executePartnerBidNode(makeNode({ partner_id: 'bad-id' }), makeCtx(), makeEnv(), makeSupabase(null) as any))
        .rejects.toThrow(/not found/)
    })
  })

  describe('partner inactive', () => {
    it('skips without hitting circuit breaker or cap when partner is inactive', async () => {
      const cbStub = makeCbStub(true)
      const env = makeEnv({
        CIRCUIT_BREAKER: {
          idFromName: vi.fn().mockReturnValue('cb-id'),
          get: vi.fn().mockReturnValue(cbStub),
        },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await executePartnerBidNode(makeNode({ partner_id: 'p1' }), makeCtx(), env, makeSupabase(makePartner({ is_active: false })) as any)
      const output = result.output as PartnerBidOutput
      expect(output.skipped).toBe(true)
      expect(output.skip_reason).toBe('partner_inactive')
      expect(cbStub.fetch).not.toHaveBeenCalled()
    })
  })

  describe('circuit breaker', () => {
    it('skips when circuit is open', async () => {
      const cbStub = makeCbStub(false, 'open')
      const env = makeEnv({
        CIRCUIT_BREAKER: {
          idFromName: vi.fn().mockReturnValue('cb-id'),
          get: vi.fn().mockReturnValue(cbStub),
        },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await executePartnerBidNode(makeNode({ partner_id: 'p1' }), makeCtx(), env, makeSupabase(makePartner()) as any)
      const output = result.output as PartnerBidOutput
      expect(output.skipped).toBe(true)
      expect(output.skip_reason).toBe('circuit_open')
    })

    it('does not check circuit when circuit_enabled is false', async () => {
      const cbGet = vi.fn()
      const env = makeEnv({
        CIRCUIT_BREAKER: {
          idFromName: vi.fn().mockReturnValue('cb-id'),
          get: cbGet,
        },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await executePartnerBidNode(makeNode({ partner_id: 'p1' }), makeCtx({ debt_amount: 1000 }), env, makeSupabase(makePartner({ circuit_enabled: false })) as any)
      const output = result.output as PartnerBidOutput
      expect(cbGet).not.toHaveBeenCalled()
      expect(output.skipped).toBe(false)
    })

    it('records success on successful bid', async () => {
      const cbStub = makeCbStub(true)
      const env = makeEnv({
        CIRCUIT_BREAKER: {
          idFromName: vi.fn().mockReturnValue('cb-id'),
          get: vi.fn().mockReturnValue(cbStub),
        },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await executePartnerBidNode(makeNode({ partner_id: 'p1' }), makeCtx({ debt_amount: 10000 }), env, makeSupabase(makePartner()) as any)
      // recordSuccess is fire-and-forget — check it was called eventually
      await vi.waitFor(() => expect(cbStub.fetch).toHaveBeenCalledWith(
        expect.stringContaining('record-success'),
        expect.objectContaining({ method: 'POST' })
      ), { timeout: 200 })
    })
  })

  describe('daily cap enforcement', () => {
    it('skips when cap is exceeded', async () => {
      const capDoStub = makeCapStub(false, 100)
      const env = makeEnv({
        DAILY_CAP: {
          idFromName: vi.fn().mockReturnValue('do-id'),
          get: vi.fn().mockReturnValue(capDoStub),
        },
      })

      const result = await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }),
        makeCtx({ debt_amount: 1000 }),
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ daily_cap: 100 })) as any
      )
      const output = result.output as PartnerBidOutput
      expect(output.skipped).toBe(true)
      expect(output.skip_reason).toBe('cap_exceeded')
    })

    it('does not check cap when daily_cap is null (unlimited)', async () => {
      const env = makeEnv()
      const { DAILY_CAP } = env as unknown as { DAILY_CAP: { get: ReturnType<typeof vi.fn> } }

      await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }),
        makeCtx({ debt_amount: 1000 }),
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ daily_cap: null })) as any
      )
      expect(DAILY_CAP.get).not.toHaveBeenCalled()
    })

    it('passes the correct DO key (cap-{slug}-{date})', async () => {
      const idFromName = vi.fn().mockReturnValue('do-id')
      const env = makeEnv({
        DAILY_CAP: { idFromName, get: vi.fn().mockReturnValue(makeCapStub(true)) },
      })

      await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }),
        makeCtx({ debt_amount: 1000 }),
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ daily_cap: 200 })) as any
      )

      const today = new Date().toISOString().slice(0, 10)
      expect(idFromName).toHaveBeenCalledWith(`cap-tripoint-${today}`)
    })
  })

  describe('formula-only bid', () => {
    it('evaluates the bid formula and returns the computed bid', async () => {
      const result = await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }),
        makeCtx({ debt_amount: 10000 }),
        makeEnv(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ bid_formula: 'debt_amount * 0.65' })) as any
      )
      const output = result.output as PartnerBidOutput
      expect(output.bid).toBe(6500)
      expect(output.accepted).toBe(true)
      expect(output.skipped).toBe(false)
      expect(output.partner).toBe('tripoint')
    })

    it('skips (bid=null) when formula produces null', async () => {
      const result = await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }),
        makeCtx({}),  // debt_amount missing → formula returns null
        makeEnv(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ bid_formula: 'debt_amount * 0.65' })) as any
      )
      const output = result.output as PartnerBidOutput
      expect(output.bid).toBeNull()
      expect(output.accepted).toBe(false)
    })

    it('skips when bid is below min_bid', async () => {
      const result = await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }),
        makeCtx({ debt_amount: 100 }),
        makeEnv(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ bid_formula: 'debt_amount * 0.65', min_bid: 500 })) as any
      )
      const output = result.output as PartnerBidOutput
      expect(output.skipped).toBe(true)
      expect(output.skip_reason).toBe('bid_below_min')
    })
  })

  describe('API bid — output status key', () => {
    it('exposes the partner API HTTP status as output.status (not http_status)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ bid: 12.5 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      const result = await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }),
        makeCtx({ debt_amount: 1000 }),
        makeEnv(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ bid_resolver_type: 'api', api_endpoint: 'https://partner.example/bid', bid_formula: null })) as any
      )
      const output = result.output as PartnerBidOutput
      expect(output.bid).toBe(12.5)
      expect(output.accepted).toBe(true)
      expect(output.status).toBe(200)
      expect(output).not.toHaveProperty('http_status')
    })
  })

  // Issue #53: a partner API error with no response_classification override is
  // a plain Error with `.status` attached. The catch must classify it by that
  // status (permanent 4xx) instead of hardcoding transient, so the wrapped
  // PartnerApiError carries the right errorType for the retry logic.
  describe('API error classification (#53)', () => {
    afterEach(() => vi.restoreAllMocks())

    async function bidAgainstStatus(status: number) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream error', { status }))
      try {
        await executePartnerBidNode(
          makeNode({ partner_id: 'p1' }),
          makeCtx({ debt_amount: 1000 }),
          makeEnv(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          makeSupabase(makePartner({ api_endpoint: 'https://partner.example/bid' })) as any
        )
        return null
      } catch (err) {
        return err
      }
    }

    it('classifies a permanent 400 as permanent', async () => {
      const err = await bidAgainstStatus(400)
      expect(err).toBeInstanceOf(PartnerApiError)
      expect((err as PartnerApiError).errorType).toBe('permanent')
    })

    it('classifies a 403 as permanent', async () => {
      const err = await bidAgainstStatus(403)
      expect((err as PartnerApiError).errorType).toBe('permanent')
    })

    it('classifies a transient 503 as transient', async () => {
      const err = await bidAgainstStatus(503)
      expect((err as PartnerApiError).errorType).toBe('transient')
    })
  })

  // Issue #75: a failing dedup endpoint must fail open AND be logged (a silent
  // down dedup endpoint re-submits every duplicate with no signal).
  describe('dedup failure observability (#75)', () => {
    afterEach(() => vi.restoreAllMocks())

    function loggedEvents(spy: ReturnType<typeof vi.spyOn>): string[] {
      return spy.mock.calls.map((c: unknown[]) => String(c[0]))
    }

    it('fails open and logs dedup_check_failed on a non-2xx dedup response', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }))

      const result = await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }),
        makeCtx({ debt_amount: 1000 }),
        makeEnv(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ dedup_endpoint: 'https://dedup.example' })) as any
      )

      // Fail open — the lead is NOT skipped as a duplicate, so the bid proceeds.
      const output = result.output as PartnerBidOutput
      expect(output.skip_reason).not.toBe('duplicate')
      // Observability — a dedup_check_failed line was emitted.
      expect(loggedEvents(logSpy).some((l) => l.includes('dedup_check_failed') && l.includes('non_2xx'))).toBe(true)
    })

    it('fails open and logs dedup_check_failed when the dedup endpoint errors', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

      const result = await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }),
        makeCtx({ debt_amount: 1000 }),
        makeEnv(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ dedup_endpoint: 'https://dedup.example' })) as any
      )

      const output = result.output as PartnerBidOutput
      expect(output.skip_reason).not.toBe('duplicate')
      const lines = loggedEvents(logSpy)
      expect(lines.some((l) => l.includes('dedup_check_failed') && l.includes('"reason":"error"'))).toBe(true)
      expect(lines.some((l) => l.includes('ECONNREFUSED'))).toBe(true)
    })

    it('a positive duplicate response still skips the bid (no false fail-open)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ duplicate: true }), { status: 200 }))
      const result = await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }),
        makeCtx({ debt_amount: 1000 }),
        makeEnv(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ dedup_endpoint: 'https://dedup.example' })) as any
      )
      expect((result.output as PartnerBidOutput).skip_reason).toBe('duplicate')
    })
  })

  // Issue #52: a lead that claims the half-open probe must always report back,
  // or the partner is excluded from all bidding until the lease expires / a
  // manual reset. cap/dedup skips release the probe (partner not called);
  // a business rejection records success (partner answered healthily).
  describe('circuit breaker probe reporting (#52)', () => {
    afterEach(() => vi.restoreAllMocks())

    function cbUrls(cbStub: { fetch: ReturnType<typeof vi.fn> }): string[] {
      return cbStub.fetch.mock.calls.map((c) => String(c[0]))
    }

    function halfOpenEnv() {
      const cbStub = makeCbStub(true, 'half_open')
      const env = makeEnv({
        CIRCUIT_BREAKER: { idFromName: vi.fn().mockReturnValue('cb-id'), get: vi.fn().mockReturnValue(cbStub) },
      })
      return { cbStub, env }
    }

    it('releases the probe when the lead is skipped by the daily cap', async () => {
      const { cbStub, env } = halfOpenEnv()
      env.DAILY_CAP = { idFromName: vi.fn().mockReturnValue('do-id'), get: vi.fn().mockReturnValue(makeCapStub(false, 100)) } as unknown as typeof env.DAILY_CAP

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await executePartnerBidNode(makeNode({ partner_id: 'p1' }), makeCtx({ debt_amount: 1000 }), env, makeSupabase(makePartner({ daily_cap: 100 })) as any)

      expect(cbUrls(cbStub).some((u) => u.includes('release-probe'))).toBe(true)
    })

    it('releases the probe when the lead is a duplicate', async () => {
      const { cbStub, env } = halfOpenEnv()
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ duplicate: true }), { status: 200 }))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await executePartnerBidNode(makeNode({ partner_id: 'p1' }), makeCtx({ debt_amount: 1000 }), env, makeSupabase(makePartner({ dedup_endpoint: 'https://dedup.example' })) as any)

      expect(cbUrls(cbStub).some((u) => u.includes('release-probe'))).toBe(true)
    })

    it('does NOT release the probe when the breaker was closed (no probe claimed)', async () => {
      const cbStub = makeCbStub(true, 'closed')
      const env = makeEnv({
        CIRCUIT_BREAKER: { idFromName: vi.fn().mockReturnValue('cb-id'), get: vi.fn().mockReturnValue(cbStub) },
        DAILY_CAP: { idFromName: vi.fn().mockReturnValue('do-id'), get: vi.fn().mockReturnValue(makeCapStub(false, 100)) },
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await executePartnerBidNode(makeNode({ partner_id: 'p1' }), makeCtx({ debt_amount: 1000 }), env, makeSupabase(makePartner({ daily_cap: 100 })) as any)

      expect(cbUrls(cbStub).some((u) => u.includes('release-probe'))).toBe(false)
    })

    it('records success on a business rejection (healthy partner response)', async () => {
      const { cbStub, env } = halfOpenEnv()
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'rejected' }), { status: 200 }))

      await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }),
        makeCtx({ debt_amount: 1000 }),
        env,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({
          api_endpoint: 'https://partner.example/bid',
          response_classification: { rejection_signals: [{ field: 'status', equals: 'rejected' }] },
        })) as any
      )

      // recordSuccess is fire-and-forget.
      await vi.waitFor(() => expect(cbUrls(cbStub).some((u) => u.includes('record-success'))).toBe(true), { timeout: 200 })
      expect(cbUrls(cbStub).some((u) => u.includes('release-probe'))).toBe(false)
    })
  })
})

// ── Formula evaluator unit tests ──────────────────────────────────────────────

describe('evaluateFormula', () => {
  function ctx(payload: Record<string, unknown>): ExecutionContext {
    return {
      trigger: { payload, source: 'test', workflow_id: 'wf', org_id: '', trace_id: 't' },
      steps: {}, env: {},
    }
  }

  it('multiplies a field by a constant', () => {
    expect(evaluateFormula('debt_amount * 0.65', ctx({ debt_amount: 10000 }))).toBe(6500)
  })

  it('supports addition', () => {
    expect(evaluateFormula('base + bonus', ctx({ base: 100, bonus: 50 }))).toBe(150)
  })

  it('supports Math.floor', () => {
    expect(evaluateFormula('Math.floor(debt_amount * 0.65)', ctx({ debt_amount: 1001 }))).toBe(650)
  })

  it('returns null when a referenced field is missing', () => {
    expect(evaluateFormula('debt_amount * 0.65', ctx({}))).toBeNull()
  })

  it('returns null for an empty formula', () => {
    expect(evaluateFormula('', ctx({ x: 1 }))).toBeNull()
  })

  it('returns null for a formula that produces Infinity', () => {
    expect(evaluateFormula('1 / 0', ctx({}))).toBeNull()
  })

  // Issue #74: dotted bare payload references must resolve, not silently no-bid.
  it('resolves a dotted bare payload reference', () => {
    expect(evaluateFormula('loanInformation.loanAmount * 0.1', ctx({ loanInformation: { loanAmount: 10000 } })))
      .toBe(1000)
  })

  it('resolves multiple dotted references in one formula', () => {
    const payload = { financialInformation: { debt: 20000, income: 5000 } }
    expect(evaluateFormula('financialInformation.debt - financialInformation.income', ctx(payload)))
      .toBe(15000)
  })

  it('mixes a dotted reference with a non-dotted one', () => {
    expect(evaluateFormula('loanInformation.loanAmount * rate', ctx({ loanInformation: { loanAmount: 1000 }, rate: 0.5 })))
      .toBe(500)
  })

  it('still supports Math with a dotted reference', () => {
    expect(evaluateFormula('Math.floor(loanInformation.loanAmount * 0.333)', ctx({ loanInformation: { loanAmount: 1000 } })))
      .toBe(333)
  })

  it('returns null when a dotted reference does not resolve to a number', () => {
    expect(evaluateFormula('loanInformation.missing * 2', ctx({ loanInformation: {} }))).toBeNull()
  })
})

// ── recordBreakerOutcome — retry + visibility on a failed DO write (#129) ──────

describe('recordBreakerOutcome (#129)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { logSpy = vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { logSpy.mockRestore() })

  const loggedFailures = (): Record<string, unknown>[] =>
    logSpy.mock.calls
      .map((c: unknown[]) => { try { return JSON.parse(c[0] as string) as Record<string, unknown> } catch { return {} } })
      .filter((o: Record<string, unknown>) => o.event === 'circuit_breaker_record_failed')

  it('records on the first try and does not retry or log a failure', async () => {
    const call = vi.fn().mockResolvedValue(undefined)
    await recordBreakerOutcome(makeCtx(), 'tripoint', 'error', call)
    expect(call).toHaveBeenCalledTimes(1)
    expect(loggedFailures()).toHaveLength(0)
  })

  it('retries a transient blip and succeeds without logging a failure', async () => {
    const call = vi.fn()
      .mockRejectedValueOnce(new Error('DO blip'))
      .mockRejectedValueOnce(new Error('DO blip'))
      .mockResolvedValue(undefined)
    await recordBreakerOutcome(makeCtx(), 'tripoint', 'error', call)
    expect(call).toHaveBeenCalledTimes(3)
    expect(loggedFailures()).toHaveLength(0)
  })

  it('logs a visible failure event (and does not throw) when every attempt fails', async () => {
    const call = vi.fn().mockRejectedValue(new Error('DO down'))
    await expect(
      recordBreakerOutcome(makeCtx(), 'tripoint', 'error', call)
    ).resolves.toBeUndefined()
    expect(call).toHaveBeenCalledTimes(3)
    const failures = loggedFailures()
    expect(failures).toHaveLength(1)
    expect(failures[0].kind).toBe('error')
    expect(failures[0].partner_id).toBe('tripoint')
    expect(String(failures[0].error_message)).toContain('DO down')
  })
})
