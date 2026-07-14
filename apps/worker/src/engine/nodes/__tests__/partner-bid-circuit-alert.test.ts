/**
 * Circuit-breaker trip alerting (audit finding 1.2): when a partner's breaker
 * trips on a real outage, ops must get a Slack page. Previously `sendCircuitAlert`
 * had zero callers and `recordBreakerOutcome` discarded the `tripped` flag, so a
 * partner could be excluded from all bidding for hours with no signal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../lib/slack', () => ({ sendCircuitAlert: vi.fn() }))

import { recordBreakerOutcome, alertIfTripped, executePartnerBidNode } from '../partner-bid'
import { sendCircuitAlert } from '../../../lib/slack'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { Env } from '../../../index'

const ctx = { trigger: { trace_id: 't', workflow_id: 'wf', org_id: 'org-1' } } as unknown as ExecutionContext
const supabase = {} as never

describe('recordBreakerOutcome — returns the call result', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the value the breaker call resolves to (so the tripped flag survives)', async () => {
    const outcome = await recordBreakerOutcome(ctx, 'sofi', 'error', async () => ({ ok: true, state: 'open', tripped: true }))
    expect(outcome).toEqual({ ok: true, state: 'open', tripped: true })
  })

  it('returns undefined when every attempt throws (record dropped, not surfaced as tripped)', async () => {
    const outcome = await recordBreakerOutcome(ctx, 'sofi', 'error', async () => { throw new Error('DO down') })
    expect(outcome).toBeUndefined()
  })
})

describe('alertIfTripped', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(sendCircuitAlert).mockResolvedValue(undefined)
  })

  it('fires a circuit alert when the outcome tripped', async () => {
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', { ok: true, state: 'open', tripped: true })
    expect(alerted).toBe(true)
    expect(vi.mocked(sendCircuitAlert)).toHaveBeenCalledTimes(1)
    const [, orgId, channel, payload] = vi.mocked(sendCircuitAlert).mock.calls[0]
    expect(orgId).toBe('org-1')
    expect(channel).toBeNull()
    expect(payload).toMatchObject({ service_name: 'sofi', state: 'opened' })
  })

  it('does nothing when the outcome did not trip', async () => {
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', { ok: true, state: 'closed', tripped: false })
    expect(alerted).toBe(false)
    expect(vi.mocked(sendCircuitAlert)).not.toHaveBeenCalled()
  })

  it('does nothing when the breaker record was dropped (undefined outcome)', async () => {
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', undefined)
    expect(alerted).toBe(false)
    expect(vi.mocked(sendCircuitAlert)).not.toHaveBeenCalled()
  })

  it('never throws if the alert delivery fails (off the critical path)', async () => {
    vi.mocked(sendCircuitAlert).mockRejectedValueOnce(new Error('slack down'))
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', { ok: true, state: 'open', tripped: true })
    expect(alerted).toBe(true)
  })

  it('does not page Slack when running under local wrangler dev, even on a real trip (shares the real org Slack connection)', async () => {
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', { ok: true, state: 'open', tripped: true }, { isLocalDev: true })
    expect(alerted).toBe(false)
    expect(vi.mocked(sendCircuitAlert)).not.toHaveBeenCalled()
  })

  // #547: a Test Runner run against a live partner can genuinely trip the breaker,
  // and until now that paged the team exactly like a production incident. Every other
  // failure alert (execution failure, duration, dead-letter) already skips test runs.
  it('does not page Slack for a Test Runner run, even on a real trip', async () => {
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', { ok: true, state: 'open', tripped: true }, { isTest: true })
    expect(alerted).toBe(false)
    expect(vi.mocked(sendCircuitAlert)).not.toHaveBeenCalled()
  })

  it('still pages Slack on a real production trip (neither flag set)', async () => {
    const alerted = await alertIfTripped(supabase, 'org-1', 'sofi', { ok: true, state: 'open', tripped: true }, { isLocalDev: false, isTest: false })
    expect(alerted).toBe(true)
    expect(vi.mocked(sendCircuitAlert)).toHaveBeenCalledTimes(1)
  })
})

// The gate is only worth anything if the executor actually passes the flag, so drive
// the real failure path: a partner API that throws, a breaker that reports `tripped`,
// and assert on whether Slack was paged. This is the path a Test Runner run takes.
describe('executePartnerBidNode: circuit trip alerting on a test run (#547)', () => {
  const TRIPPING_BREAKER = () => ({
    fetch: vi.fn().mockImplementation((url: string) => {
      const path = new URL(url).pathname
      if (path === '/check') return Promise.resolve({ ok: true, json: async () => ({ allowed: true, state: 'closed' }) })
      if (path === '/record-error') return Promise.resolve({ ok: true, json: async () => ({ ok: true, state: 'open', tripped: true }) })
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
    }),
  })

  function envThatTrips(): Env {
    return {
      CIRCUIT_BREAKER: { idFromName: vi.fn().mockReturnValue('cb'), get: vi.fn().mockReturnValue(TRIPPING_BREAKER()) },
      DAILY_CAP: {
        idFromName: vi.fn().mockReturnValue('cap'),
        get: vi.fn().mockReturnValue({ fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: true, count: 1, cap: 100 }) }) }),
      },
    } as unknown as Env
  }

  const partner = {
    id: 'partner-1',
    slug: 'sofi',
    api_endpoint: 'https://partner.example/bid',
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
  }

  function supabaseWithPartner() {
    const chain: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'single') return () => Promise.resolve({ data: partner, error: null })
        return () => chain
      },
    })
    return { from: () => chain }
  }

  const node: NodeDefinition = { id: 'n1', namespace: 'sofi_bid', type: 'partner_bid', config: { partner_id: 'partner-1' } }
  const bidCtx = (isTest?: boolean): ExecutionContext => ({
    trigger: { payload: { debt_amount: 10000 }, source: 'test', workflow_id: 'wf-1', org_id: 'org-1', trace_id: 'trace-1' },
    steps: {},
    env: {},
    ...(isTest === undefined ? {} : { isTest }),
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(sendCircuitAlert).mockResolvedValue(undefined)
    // The partner API is down: this is what trips the breaker.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('partner down')))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('pages Slack when a production run trips the breaker', async () => {
    await expect(
      executePartnerBidNode(node, bidCtx(), envThatTrips(), supabaseWithPartner() as never),
    ).rejects.toThrow()
    expect(vi.mocked(sendCircuitAlert)).toHaveBeenCalledTimes(1)
  })

  it('does NOT page Slack when a Test Runner run trips the breaker', async () => {
    await expect(
      executePartnerBidNode(node, bidCtx(true), envThatTrips(), supabaseWithPartner() as never),
    ).rejects.toThrow()
    expect(vi.mocked(sendCircuitAlert)).not.toHaveBeenCalled()
  })
})
