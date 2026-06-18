import { describe, it, expect, vi } from 'vitest'
import { executePartnerBidNode } from '../partner-bid'
import type { ExecutionContext, NodeDefinition } from '../../../types'

function ctx(shadow_mode?: 'off' | 'dry_run'): ExecutionContext {
  return { trigger: { payload: {}, source: 's', workflow_id: 'w', trace_id: 't', org_id: 'o' }, steps: {}, env: {}, shadow_mode }
}

// Minimal chainable Supabase mock: from().select().eq().single() resolves the
// partner config. The dry-run guard runs AFTER this read (a read is harmless),
// so the load must succeed; what it must NOT do is fetch the partner API or
// write a bid attempt.
function supabaseReturningPartner(partner: Record<string, unknown>) {
  const single = vi.fn().mockResolvedValue({ data: partner, error: null })
  const eq = vi.fn(() => ({ single }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return { from } as never
}

const node = { id: 'n1', type: 'partner_bid', namespace: 'bid_tripoint', config: { partner_id: 'pid-1' } } as unknown as NodeDefinition

describe('executePartnerBidNode — shadow dry_run', () => {
  it('returns a shadow skip carrying the slug, with no partner API call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await executePartnerBidNode(node, ctx('dry_run'), {} as never, supabaseReturningPartner({ slug: 'tripoint', is_active: true }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.output).toMatchObject({ partner: 'tripoint', skipped: true, skip_reason: 'shadow', bid: null, accepted: false })
    vi.unstubAllGlobals()
  })
})
