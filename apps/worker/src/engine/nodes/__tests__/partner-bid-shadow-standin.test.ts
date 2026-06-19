import { describe, it, expect, vi } from 'vitest'
import { executePartnerBidNode } from '../partner-bid'
import type { ExecutionContext, NodeDefinition } from '../../../types'

// Stand-in shadow sub-mode (#232): unlike dry_run (which returns a skip so only
// the pre-bid path is exercised), stand_in resolves a deterministic bid WITHOUT
// the outbound submission, so downstream Bid Group / bid-evaluation / routing can
// be rehearsed. Formula/matrix resolve locally; api partners get a stand-in bid
// from min_bid. No partner API call, no cap increment, no dedup, no bid write.
function ctx(shadow_mode?: 'off' | 'dry_run' | 'stand_in'): ExecutionContext {
  return { trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

function supabaseReturningPartner(partner: Record<string, unknown>) {
  const single = vi.fn().mockResolvedValue({ data: partner, error: null })
  const eq = vi.fn(() => ({ single }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { from } as never
}

const node = { id: 'n1', type: 'partner_bid', namespace: 'bid_x', config: { partner_id: 'pid-1' } } as unknown as NodeDefinition

describe('executePartnerBidNode — shadow stand_in', () => {
  it('resolves a formula partner locally and returns an accepted bid, no API call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await executePartnerBidNode(
      node,
      ctx('stand_in'),
      {} as never,
      supabaseReturningPartner({ slug: 'tripoint', is_active: true, bid_resolver_type: 'formula', bid_formula: '50', min_bid: null }),
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.output).toMatchObject({ partner: 'tripoint', bid: 50, accepted: true, skipped: false })
    vi.unstubAllGlobals()
  })

  it('returns a deterministic stand-in bid (min_bid) for an api partner without calling it or the daily-cap DO', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // env has no DAILY_CAP binding; daily_cap is set. If stand_in wrongly ran the
    // cap check it would throw on env.DAILY_CAP — so reaching a clean return proves
    // the cap side effect is skipped.
    const res = await executePartnerBidNode(
      node,
      ctx('stand_in'),
      {} as never,
      supabaseReturningPartner({
        slug: 'm1',
        is_active: true,
        bid_resolver_type: 'api',
        api_endpoint: 'https://partner.example/bid',
        daily_cap: 5,
        min_bid: 12.5,
      }),
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.output).toMatchObject({ partner: 'm1', bid: 12.5, accepted: true, skipped: false })
    vi.unstubAllGlobals()
  })

  it('skips an inactive partner even in stand_in', async () => {
    const res = await executePartnerBidNode(
      node,
      ctx('stand_in'),
      {} as never,
      supabaseReturningPartner({ slug: 'off', is_active: false, bid_resolver_type: 'formula', bid_formula: '50' }),
    )
    expect(res.output).toMatchObject({ partner: 'off', skipped: true, skip_reason: 'partner_inactive' })
  })
})
