/**
 * Partner Bid node — PRD Section 5.3
 * Tests: cap enforcement, circuit breaker, formula evaluation, API call, skips.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executePartnerBidNode, evaluateFormula, recordBreakerOutcome, meetsBidFloor } from '../partner-bid'
import { PartnerApiError } from '../../partner-bid-error'
import { retirePartnerLastGood } from '../../../lib/partner-last-good'
import { STORED_COPY_MAX_AGE_MS, STORED_COPY_RECONFIRM_AFTER_MS, StoredCopyRefusedError } from '../../../lib/stored-copy-age'
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

    it('skips with cap_check_error (not cap_exceeded) when the cap DO returns a non-ok response (#413)', async () => {
      const capDoStub = {
        fetch: vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
      }
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
      // A DO error must NOT masquerade as a normal cap hit.
      expect(output.skip_reason).toBe('cap_check_error')
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

    // The cap day is the EASTERN day (lib/daily-cap-name.ts, #1410). This test used
    // to derive its expectation from the UTC date off the real clock, so it went red
    // every night between 20:00 and 24:00 Eastern, when the two calendars disagree,
    // and was red in CI at 01:38 UTC on 2026-09-24 (#1519). The clock is pinned to
    // exactly such an instant and the key is written out, so the test asserts the
    // calendar the cap actually follows rather than whichever one the runner is in.
    it('passes the correct DO key (cap-{slug}-{date}), on the Eastern day', async () => {
      vi.useFakeTimers()
      // 01:35 UTC on the 24th is 21:35 Eastern on the 23rd.
      vi.setSystemTime(new Date('2026-09-24T01:35:00.000Z'))
      try {
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

        expect(idFromName).toHaveBeenCalledWith('cap-tripoint-2026-09-23')
      } finally {
        vi.useRealTimers()
      }
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

    // #109: a $0 bid is accepted by default; a partner declines $0 by setting a
    // positive min_bid. Negative bids are always rejected.
    it('accepts a $0 bid by default (no min_bid)', async () => {
      const result = await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }),
        makeCtx({ debt_amount: 0 }), // formula → 0
        makeEnv(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ bid_formula: 'debt_amount * 0.65', min_bid: null })) as any
      )
      const output = result.output as PartnerBidOutput
      expect(output.bid).toBe(0)
      expect(output.accepted).toBe(true)
      expect(output.skipped).toBe(false)
    })

    it('declines a $0 bid when a positive min_bid is set', async () => {
      const result = await executePartnerBidNode(
        makeNode({ partner_id: 'p1' }),
        makeCtx({ debt_amount: 0 }), // formula → 0
        makeEnv(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase(makePartner({ bid_formula: 'debt_amount * 0.65', min_bid: 1 })) as any
      )
      const output = result.output as PartnerBidOutput
      expect(output.accepted).toBe(false)
      expect(output.skipped).toBe(true)
      expect(output.skip_reason).toBe('bid_below_min')
    })
  })

  describe('meetsBidFloor (#109)', () => {
    it('accepts $0 by default but rejects negatives when no min_bid is set', () => {
      expect(meetsBidFloor(0, null)).toBe(true)
      expect(meetsBidFloor(0, undefined)).toBe(true)
      expect(meetsBidFloor(-1, null)).toBe(false)
      expect(meetsBidFloor(50, null)).toBe(true)
    })
    it('honors an explicit positive min_bid (declines $0 and anything below it)', () => {
      expect(meetsBidFloor(0, 1)).toBe(false)
      expect(meetsBidFloor(2.99, 3)).toBe(false)
      expect(meetsBidFloor(3, 3)).toBe(true)
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

// The partner config is read from the database on every attempt, so a database
// outage failed every bid even when the lead had reached the bid step (#1296).
// A last-good copy in KV, written when the row changes, is served when the
// read fails; a read that fails with no copy still refuses.
describe('partner config last-good fallback during a DB outage (#1296)', () => {
  function makeDbDownSupabase() {
    const chain: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'single') return () => Promise.resolve({ data: null, error: { code: '57P01', message: 'db connection lost' } })
        return () => chain
      },
    })
    return { from: () => chain }
  }
  // A seed is a bare value (a copy written before #1847, with no confirmation)
  // or a value with the metadata its put carried.
  type Seed = string | { value: string; metadata: unknown }
  function recordingKv(seed: Record<string, Seed> = {}) {
    const store = new Map<string, { value: string; metadata: unknown }>(
      Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? { value: v, metadata: null } : v]),
    )
    const puts: { key: string; value: string; opts?: { expirationTtl?: number; metadata?: unknown } }[] = []
    return {
      puts,
      kv: {
        get: async (k: string) => store.get(k)?.value ?? null,
        getWithMetadata: async (k: string) => store.get(k) ?? { value: null, metadata: null },
        put: async (k: string, v: string, opts?: { expirationTtl?: number; metadata?: unknown }) => { store.set(k, { value: v, metadata: opts?.metadata ?? null }); puts.push({ key: k, value: v, opts }) },
        delete: async (k: string) => { store.delete(k) },
      },
    }
  }
  const partner = makePartner({ updated_at: '2026-09-10T20:00:00Z' })
  /** The copy as a healthy read `ageMs` ago left it. */
  const confirmedCopy = (ageMs = 0, value: unknown = partner): Seed => ({ value: JSON.stringify(value), metadata: { confirmed_at: new Date(Date.now() - ageMs).toISOString() } })

  it('bids from the last-good copy when the partner_configs read fails', async () => {
    const { kv } = recordingKv({ 'partner-lastgood:partner-1': confirmedCopy(60_000) })
    const result = await executePartnerBidNode(
      makeNode({ partner_id: 'partner-1' }),
      makeCtx({ debt_amount: 10000 }),
      makeEnv({ WORKFLOW_CACHE: kv }),
      makeDbDownSupabase() as never,
    )
    const out = result.output as PartnerBidOutput
    expect(out.partner).toBe('tripoint')
    expect(out.bid).toBe(6500)
  })

  // #1847: served for at most thirty minutes after a healthy read or the sweep
  // last confirmed it; past that, or with no readable confirmation, refused by name.
  it.each([
    ['last confirmed more than thirty minutes ago', () => confirmedCopy(STORED_COPY_MAX_AGE_MS + 1_000), 'copy_too_old'],
    ['written before copies carried a confirmation time', () => JSON.stringify(partner), 'copy_age_unknown'],
  ] as const)('refuses a copy %s, with its own reason', async (_label, seed, reason) => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { kv } = recordingKv({ 'partner-lastgood:partner-1': seed() })
    const run = executePartnerBidNode(makeNode({ partner_id: 'partner-1' }), makeCtx({ debt_amount: 10000 }), makeEnv({ WORKFLOW_CACHE: kv }), makeDbDownSupabase() as never)
    await expect(run).rejects.toBeInstanceOf(StoredCopyRefusedError)
    await expect(run).rejects.toMatchObject({ reason, copy: 'partner_config' })
    errSpy.mockRestore()
  })

  it('stamps every copy it writes with the time the read confirmed it', async () => {
    const { kv, puts } = recordingKv()
    await executePartnerBidNode(makeNode({ partner_id: 'partner-stamp' }), makeCtx({ debt_amount: 10000 }), makeEnv({ WORKFLOW_CACHE: kv }), makeSupabase(makePartner({ id: 'partner-stamp' })) as never)
    const [write] = puts.filter((p) => p.key === 'partner-lastgood:partner-stamp')
    const stamp = Date.parse((write.opts?.metadata as { confirmed_at?: string }).confirmed_at ?? '')
    expect(Math.abs(Date.now() - stamp)).toBeLessThan(5_000)
  })

  it('confirms an unchanged copy again once this isolate last wrote it the reconfirm interval ago, and not before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = Date.parse('2026-10-07T12:00:00Z')
      vi.setSystemTime(start)
      const { kv, puts } = recordingKv()
      const env = makeEnv({ WORKFLOW_CACHE: kv })
      const steady = makePartner({ id: 'partner-reconfirm', updated_at: '2026-10-07T11:00:00Z' })
      const bid = () => executePartnerBidNode(makeNode({ partner_id: 'partner-reconfirm' }), makeCtx({ debt_amount: 10000 }), env, makeSupabase(steady) as never)
      await bid()
      vi.setSystemTime(start + STORED_COPY_RECONFIRM_AFTER_MS - 1)
      await bid()
      expect(puts.filter((p) => p.key === 'partner-lastgood:partner-reconfirm')).toHaveLength(1)
      vi.setSystemTime(start + STORED_COPY_RECONFIRM_AFTER_MS)
      await bid()
      const writes = puts.filter((p) => p.key === 'partner-lastgood:partner-reconfirm')
      expect(writes).toHaveLength(2)
      expect((writes[1].opts?.metadata as { confirmed_at: string }).confirmed_at).toBe(new Date(start + STORED_COPY_RECONFIRM_AFTER_MS).toISOString())
    } finally {
      vi.useRealTimers()
    }
  })

  it('still refuses when the read fails and there is no last-good copy, saying it could not be read rather than not found', async () => {
    const { kv } = recordingKv()
    await expect(executePartnerBidNode(
      makeNode({ partner_id: 'partner-1' }),
      makeCtx({ debt_amount: 10000 }),
      makeEnv({ WORKFLOW_CACHE: kv }),
      makeDbDownSupabase() as never,
    )).rejects.toThrow(/partner config partner-1 could not be read .*and there is no stored copy to use/)
  })

  it('writes the last-good copy when the row changes, and not again while it is unchanged', async () => {
    const { kv, puts } = recordingKv()
    const env = makeEnv({ WORKFLOW_CACHE: kv })
    await executePartnerBidNode(makeNode({ partner_id: 'partner-1' }), makeCtx({ debt_amount: 10000 }), env, makeSupabase(partner) as never)
    await executePartnerBidNode(makeNode({ partner_id: 'partner-1' }), makeCtx({ debt_amount: 10000 }), env, makeSupabase(partner) as never)
    const writes = puts.filter((p) => p.key === 'partner-lastgood:partner-1')
    expect(writes).toHaveLength(1)
    expect(writes[0].opts?.expirationTtl).toBeUndefined()
    expect(JSON.parse(writes[0].value)).toMatchObject({ id: 'partner-1', slug: 'tripoint' })

    const edited = makePartner({ updated_at: '2026-09-10T21:00:00Z', bid_formula: 'debt_amount * 0.5' })
    await executePartnerBidNode(makeNode({ partner_id: 'partner-1' }), makeCtx({ debt_amount: 10000 }), env, makeSupabase(edited) as never)
    expect(puts.filter((p) => p.key === 'partner-lastgood:partner-1')).toHaveLength(2)
  })

  // #1846. A partner route retires the copy when it changes or removes the
  // partner. The isolate's record of what it already wrote is keyed on
  // updated_at, so if retiring left that record in place, a later read of a row
  // whose updated_at had not moved would skip the write and leave no copy at all.
  it('writes the copy again after it is retired, even when updated_at has not moved', async () => {
    const { kv, puts } = recordingKv()
    const env = makeEnv({ WORKFLOW_CACHE: kv })
    const steady = makePartner({ id: 'partner-retire', updated_at: '2026-10-07T12:00:00Z' })
    await executePartnerBidNode(makeNode({ partner_id: 'partner-retire' }), makeCtx({ debt_amount: 10000 }), env, makeSupabase(steady) as never)
    await retirePartnerLastGood(kv as unknown as KVNamespace, 'partner-retire')
    expect(await kv.get('partner-lastgood:partner-retire')).toBeNull()
    await executePartnerBidNode(makeNode({ partner_id: 'partner-retire' }), makeCtx({ debt_amount: 10000 }), env, makeSupabase(steady) as never)
    expect(puts.filter((p) => p.key === 'partner-lastgood:partner-retire')).toHaveLength(2)
    expect(await kv.get('partner-lastgood:partner-retire')).not.toBeNull()
  })

  // A route retires the copy after its write lands, but a lead that read the row
  // just BEFORE the delete can write the copy just AFTER the retire. The first
  // read that finds the partner gone removes that copy, so it cannot outlive it.
  it('a read that finds the partner gone removes a copy that is still there', async () => {
    const { kv } = recordingKv({ 'partner-lastgood:partner-1': JSON.stringify(partner) })
    const notFound: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'single') return () => Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
        return () => notFound
      },
    })
    await expect(executePartnerBidNode(
      makeNode({ partner_id: 'partner-1' }),
      makeCtx({ debt_amount: 10000 }),
      makeEnv({ WORKFLOW_CACHE: kv }),
      { from: () => notFound } as never,
    )).rejects.toThrow('Partner config not found')
    expect(await kv.get('partner-lastgood:partner-1')).toBeNull()
  })

  // The removal is a tidy up beside the refusal: KV failing there must not
  // replace "Partner config not found" with a KV error, and is logged.
  it('a KV failure while removing a missing partner copy keeps the named refusal and is logged', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = {
      get: async () => JSON.stringify(partner),
      put: async () => {},
      delete: async () => { throw new Error('kv unavailable') },
    }
    const notFound: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'single') return () => Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
        return () => notFound
      },
    })
    await expect(executePartnerBidNode(
      makeNode({ partner_id: 'partner-1' }),
      makeCtx({ debt_amount: 10000 }),
      makeEnv({ WORKFLOW_CACHE: kv }),
      { from: () => notFound } as never,
    )).rejects.toThrow('Partner config not found: partner-1')
    expect(errSpy.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining('could not remove the last-good copy of missing partner partner-1'))
    errSpy.mockRestore()
  })
})
