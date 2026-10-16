/**
 * Constants node
 * Tests: static data merged with DB data, subAccountIdsMap, sell-off copy key
 * generation, click URL key generation, loader errors propagate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeConstantsNode, partnerConstantOutputKeys } from '../constants'
import type { NodeDefinition, ExecutionContext } from '../../../types'
import type { Env } from '../../../index'
import type { PartnerConstants } from '../../../lib/partner-constants-loader'

vi.mock('../../../lib/partner-constants-loader', () => ({
  loadPartnerConstants: vi.fn(),
}))

import { loadPartnerConstants } from '../../../lib/partner-constants-loader'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(data: Record<string, unknown> = {}): NodeDefinition {
  return { id: 'n1', namespace: 'constants', type: 'constants', config: { data } }
}

function makeCtx(): ExecutionContext {
  return {
    trigger: { payload: {}, source: 'test', workflow_id: 'wf-1', org_id: 'org-1', trace_id: 'tr-1' },
    steps: {},
    env: {},
  } as unknown as ExecutionContext
}

const mockEnv = {} as Env
const mockSupabase = {} as never

function makeConstants(overrides: Partial<PartnerConstants> = {}): PartnerConstants {
  return {
    subAccountIdsMap: {},
    sellOff: {},
    clickUrls: {},
    activeBidding: {},
    subAccountMinBids: {},
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeConstantsNode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadPartnerConstants).mockResolvedValue(makeConstants())
  })

  it('includes subAccountIdsMap at top level of output', async () => {
    const map = { 'uuid-1': 'sofI', 'uuid-2': 'nerdwallet' }
    vi.mocked(loadPartnerConstants).mockResolvedValue(makeConstants({ subAccountIdsMap: map }))

    const { output } = await executeConstantsNode(makeNode(), makeCtx(), mockEnv, mockSupabase)
    expect((output as Record<string, unknown>).subAccountIdsMap).toEqual(map)
  })

  it('includes activeBidding at top level of output for per-source toggles', async () => {
    const activeBidding = { sofi: true, nerdwallet: false, dot818: true }
    vi.mocked(loadPartnerConstants).mockResolvedValue(makeConstants({ activeBidding }))

    const { output } = await executeConstantsNode(makeNode(), makeCtx(), mockEnv, mockSupabase)
    expect((output as Record<string, unknown>).activeBidding).toEqual(activeBidding)
  })

  it('merges node.config.data static values into output', async () => {
    const node = makeNode({ offerName: 'Pennie', productType: 'installment_loan' })
    const { output } = await executeConstantsNode(node, makeCtx(), mockEnv, mockSupabase)
    const out = output as Record<string, unknown>
    expect(out.offerName).toBe('Pennie')
    expect(out.productType).toBe('installment_loan')
  })

  it('generates {Cap}SellOffOfferTitle and {Cap}SellOffOfferDetails from slug', async () => {
    vi.mocked(loadPartnerConstants).mockResolvedValue(makeConstants({
      sellOff: {
        sofi: { title: 'SoFi Sell Off Title', details: '<p>details</p>' },
        nerdwallet: { title: 'NW Title', details: '<p>nw</p>' },
      },
    }))

    const { output } = await executeConstantsNode(makeNode(), makeCtx(), mockEnv, mockSupabase)
    const out = output as Record<string, unknown>
    expect(out.SofiSellOffOfferTitle).toBe('SoFi Sell Off Title')
    expect(out.SofiSellOffOfferDetails).toBe('<p>details</p>')
    expect(out.NerdwalletSellOffOfferTitle).toBe('NW Title')
    expect(out.NerdwalletSellOffOfferDetails).toBe('<p>nw</p>')
  })

  it('generates {Cap}SubAccountMinBids from slug', async () => {
    vi.mocked(loadPartnerConstants).mockResolvedValue(makeConstants({
      subAccountMinBids: {
        lendswift: { 'uuid-a': 9.23, 'uuid-b': 3.85 },
      },
    }))

    const { output } = await executeConstantsNode(makeNode(), makeCtx(), mockEnv, mockSupabase)
    const out = output as Record<string, unknown>
    expect(out.LendswiftSubAccountMinBids).toEqual({ 'uuid-a': 9.23, 'uuid-b': 3.85 })
  })

  it('generates {Cap}ClickUrl from slug', async () => {
    vi.mocked(loadPartnerConstants).mockResolvedValue(makeConstants({
      clickUrls: {
        tripoint: 'https://trypennie.com/portal/tpl',
        sofi: 'https://trypennie.com/portal',
      },
    }))

    const { output } = await executeConstantsNode(makeNode(), makeCtx(), mockEnv, mockSupabase)
    const out = output as Record<string, unknown>
    expect(out.TripointClickUrl).toBe('https://trypennie.com/portal/tpl')
    expect(out.SofiClickUrl).toBe('https://trypennie.com/portal')
  })

  it('static config data does not overwrite DB-sourced keys', async () => {
    vi.mocked(loadPartnerConstants).mockResolvedValue(makeConstants({
      subAccountIdsMap: { 'uuid-1': 'real-slug' },
    }))
    // static data also has subAccountIdsMap — DB value should win (spread order)
    const node = makeNode({ subAccountIdsMap: { 'uuid-1': 'stale-value' } })
    const { output } = await executeConstantsNode(node, makeCtx(), mockEnv, mockSupabase)
    // DB value spreads after static data, so DB wins
    expect((output as Record<string, unknown>).subAccountIdsMap).toEqual({ 'uuid-1': 'real-slug' })
  })

  it('propagates loader errors without swallowing', async () => {
    vi.mocked(loadPartnerConstants).mockRejectedValue(new Error('KV read failed'))
    await expect(executeConstantsNode(makeNode(), makeCtx(), mockEnv, mockSupabase))
      .rejects.toThrow('KV read failed')
  })

  it('calls loadPartnerConstants with the org_id from the execution context', async () => {
    const ctx = makeCtx()
    ctx.trigger.org_id = 'org-specific'
    await executeConstantsNode(makeNode(), ctx, mockEnv, mockSupabase)
    const calls = vi.mocked(loadPartnerConstants).mock.calls
    expect(calls[calls.length - 1][0]).toBe('org-specific')
  })
})

// ── The partner derived keys (#2142) ──────────────────────────────────────────

describe('partnerConstantOutputKeys', () => {
  // Every kind of partner value present, for two partners, plus workflow data
  // whose names collide with none of them.
  const everyKind = makeConstants({
    subAccountIdsMap: { 'uuid-1': 'tripoint', 'uuid-2': 'sofi' },
    activeBidding: { tripoint: true, sofi: false },
    sellOff: { sofi: { title: 'T', details: 'D' } },
    clickUrls: { tripoint: 'https://trypennie.com/portal/tpl', sofi: 'https://trypennie.com/portal' },
    subAccountMinBids: { tripoint: { 'uuid-1': 5 } },
    slugsById: { 'p-1': 'tripoint', 'p-2': 'sofi' },
  })
  const data = { pennieClickUrl: 'https://trypennie.com', mainOfferTitle: 'Main', states: ['TX'] }

  beforeEach(() => {
    vi.mocked(loadPartnerConstants).mockResolvedValue(everyKind)
  })

  it('names exactly the partner derived keys the executor emits, the two maps included', async () => {
    const { output } = await executeConstantsNode(makeNode(data), makeCtx(), mockEnv, mockSupabase)
    const partnerDerived = Object.keys(output as Record<string, unknown>).filter((k) => !(k in data))
    expect([...partnerDerived].sort()).toEqual([...partnerConstantOutputKeys(everyKind)].sort())
    expect(partnerConstantOutputKeys(everyKind)).toEqual(expect.arrayContaining(['subAccountIdsMap', 'activeBidding']))
  })

  it('a partner with no value of a kind emits no name for it', () => {
    const keys = partnerConstantOutputKeys(everyKind)
    expect(keys).toContain('TripointClickUrl')
    expect(keys).not.toContain('TripointSellOffOfferTitle')
    expect(keys).not.toContain('SofiSubAccountMinBids')
  })

  it('the step log lists every partner derived key, the two maps included', async () => {
    const { resolvedInput } = await executeConstantsNode(makeNode(data), makeCtx(), mockEnv, mockSupabase)
    const resolved = resolvedInput?.resolved as { partner_constants_keys: string[] }
    expect(resolved.partner_constants_keys).toEqual(partnerConstantOutputKeys(everyKind))
  })
})
