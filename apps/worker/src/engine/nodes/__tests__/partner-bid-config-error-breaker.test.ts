/**
 * #417: a blank partner credential is OUR configuration fault, not an upstream
 * outage, so it must not count toward the circuit breaker's error threshold.
 *
 * #411 gave the blank-credential case a distinct permanent error that names the
 * missing key. But that throw still flowed through the partner-bid catch, which
 * records a breaker error before rethrowing, so after `circuit_error_threshold`
 * such failures the breaker opened and every later lead skipped the partner as
 * 'circuit_open' — re-burying the precise reason #411 surfaced.
 *
 * The discriminating condition is "the fault is in our config", not "the error is
 * permanent": a permanent 4xx from the partner is still a real upstream signal and
 * must keep counting (L615, write the restriction's condition as the reason for
 * restricting). Both halves are asserted here, in one fixture, so the negative
 * case cannot pass merely because the fixture could never have recorded anything
 * (L159).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../lib/slack', () => ({ sendCircuitAlert: vi.fn() }))

import { executePartnerBidNode } from '../partner-bid'
import { sendCircuitAlert } from '../../../lib/slack'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { Env } from '../../../index'

/** Records every Durable Object path the node hits, so we can assert on /record-error. */
function breakerRecording(paths: string[]) {
  return {
    idFromName: vi.fn().mockReturnValue('cb'),
    get: vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation((url: string) => {
        const path = new URL(url).pathname
        paths.push(path)
        if (path === '/check') return Promise.resolve({ ok: true, json: async () => ({ allowed: true, state: 'closed' }) })
        if (path === '/record-error') return Promise.resolve({ ok: true, json: async () => ({ ok: true, state: 'open', tripped: true }) })
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
      }),
    }),
  }
}

function envWith(paths: string[]): Env {
  return {
    CIRCUIT_BREAKER: breakerRecording(paths),
    DAILY_CAP: {
      idFromName: vi.fn().mockReturnValue('cap'),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: true, count: 1, cap: 100 }) }),
      }),
    },
    // Deliberately NO PARTNER_SECRET: that is the blank-credential condition.
  } as unknown as Env
}

const basePartner = {
  id: 'partner-1',
  slug: 'sofi',
  api_endpoint: 'https://partner.example/bid',
  cf_secret_key: null as string | null,
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

function supabaseWithPartner(partner: typeof basePartner) {
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
const ctx = (): ExecutionContext => ({
  trigger: { payload: { debt_amount: 10000 }, source: 'test', workflow_id: 'wf-1', org_id: 'org-1', trace_id: 'trace-1' },
  steps: {},
  env: {},
} as unknown as ExecutionContext)

describe('partner bid: a config error must not trip the circuit breaker (#417)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(sendCircuitAlert).mockResolvedValue(undefined)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('POSITIVE CONTROL: a real upstream outage still records a breaker error', async () => {
    // Same fixture, same breaker, same env. Only the failure differs.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('partner down')))
    const paths: string[] = []
    await expect(
      executePartnerBidNode(node, ctx(), envWith(paths), supabaseWithPartner({ ...basePartner }) as never),
    ).rejects.toThrow()
    expect(paths).toContain('/record-error')
  })

  it('POSITIVE CONTROL: a permanent 4xx from the partner still records a breaker error', async () => {
    // A permanent partner rejection is genuine upstream signal — it must keep counting.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('nope', { status: 403, headers: { 'Content-Type': 'text/plain' } }),
    ))
    const paths: string[] = []
    await expect(
      executePartnerBidNode(node, ctx(), envWith(paths), supabaseWithPartner({ ...basePartner }) as never),
    ).rejects.toThrow()
    expect(paths).toContain('/record-error')
  })

  it('a blank declared credential does NOT record a breaker error', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const paths: string[] = []
    const partner = { ...basePartner, cf_secret_key: 'PARTNER_SECRET' } // declared; env has no such value

    await expect(
      executePartnerBidNode(node, ctx(), envWith(paths), supabaseWithPartner(partner) as never),
    ).rejects.toThrow(/PARTNER_SECRET/)

    // The doomed call is still skipped (#411) ...
    expect(fetchSpy).not.toHaveBeenCalled()
    // ... and the breaker was consulted but never charged for our own misconfiguration.
    expect(paths).toContain('/check')
    expect(paths).not.toContain('/record-error')
  })

  it('a blank declared credential does not page Slack with a circuit trip', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const paths: string[] = []
    const partner = { ...basePartner, cf_secret_key: 'PARTNER_SECRET' }
    await expect(
      executePartnerBidNode(node, ctx(), envWith(paths), supabaseWithPartner(partner) as never),
    ).rejects.toThrow()
    expect(vi.mocked(sendCircuitAlert)).not.toHaveBeenCalled()
  })
})
