/**
 * Partner Bid node — PRD Section 5.3
 * Tests: cap enforcement, circuit breaker, formula evaluation, API call, skips.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executePartnerBidNode, evaluateFormula } from '../partner-bid'
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
})
