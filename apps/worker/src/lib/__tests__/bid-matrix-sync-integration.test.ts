/**
 * Integration coverage for the #182 wiring inside the two top-level sync
 * functions: syncBidConfig must fetch the config's dimensions, run the
 * validator on the just-synced rows, and surface problems on its result; and
 * syncAllSalesforceConfigs must hand those results to the problem notifier.
 * Salesforce (token + query) and the Slack send are mocked; Supabase is a
 * thenable chain stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../engine/nodes/salesforce', () => ({
  getSalesforceToken: vi.fn().mockResolvedValue('sf-token'),
}))
vi.mock('../slack', () => ({
  sendMatrixChangeAlert: vi.fn().mockResolvedValue(true),
  sendMatrixValidationAlert: vi.fn().mockResolvedValue(true),
}))

import { syncBidConfig, syncAllSalesforceConfigs } from '../bid-matrix-sync'
import { sendMatrixValidationAlert } from '../slack'

const CONFIG = {
  id: 'cfg-1',
  slug: 'sofi',
  name: 'SoFi default',
  organization_id: 'org-1',
  sf_object: 'BidRangeRow__c',
  sf_filters: { partner_flag: 'IsSoFi__c' },
  sync_source: 'salesforce',
  is_active: true,
  dimensions: [{ column: 'row', payload_field: 'credit_score' }],
}

// A malformed matrix: a row-band gap between 659 and 700 (and bounded edges).
const SF_RECORDS = [
  { Id: 'r1', RowId__c: 'a', RowLow__c: null, RowHigh__c: 659, RangeLow__c: null, RangeHigh__c: null, RangeValue__c: 40, IsSellOff__c: false },
  { Id: 'r2', RowId__c: 'b', RowLow__c: 700, RowHigh__c: null, RangeLow__c: null, RangeHigh__c: null, RangeValue__c: 60, IsSellOff__c: false },
]

// Minimal thenable Supabase chain: every method chains; awaiting resolves to an
// empty result; .single() returns the config row; .eq() in a list context
// (syncAllSalesforceConfigs' config listing) resolves to the config id list.
function makeSupabase() {
  let proxy: unknown
  const handler: ProxyHandler<() => void> = {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
      if (prop === 'single') return async () => ({ data: CONFIG, error: null })
      if (prop === 'select') {
        // The config-list query in syncAllSalesforceConfigs awaits select().eq().eq().
        return () => listChain
      }
      return () => proxy
    },
  }
  proxy = new Proxy(function () {}, handler)

  // A separate chain whose awaited value is the active-config id list.
  let listChain: unknown
  const listHandler: ProxyHandler<() => void> = {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: [{ id: 'cfg-1' }], error: null })
      if (prop === 'single') return async () => ({ data: CONFIG, error: null })
      return () => listChain
    },
  }
  listChain = new Proxy(function () {}, listHandler)

  return { from: () => proxy } as never
}

const ENV = {
  SALESFORCE_INSTANCE_URL: 'https://sf.example',
  SALESFORCE_CLIENT_ID: 'id',
  SALESFORCE_CLIENT_SECRET: 'secret',
} as never

describe('#182 sync integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ records: SF_RECORDS, done: true }),
    }))
  })

  it('syncBidConfig validates synced rows and surfaces problems on the result', async () => {
    const result = await syncBidConfig('cfg-1', ENV, makeSupabase())
    expect(result.problems.length).toBeGreaterThan(0)
    const gap = result.problems.find((p) => p.kind === 'gap' && p.axis === 'row')
    expect(gap).toBeDefined()
    expect(gap!.detail).toContain('credit_score')
    expect(gap!.detail).toContain('between 659 and 700')
  })

  it('syncAllSalesforceConfigs forwards problem results to the validation alert', async () => {
    await syncAllSalesforceConfigs(ENV, makeSupabase())
    expect(vi.mocked(sendMatrixValidationAlert)).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(sendMatrixValidationAlert).mock.calls[0][3]
    expect(payload.configs[0].partner_slug).toBe('sofi')
    expect(payload.configs[0].problems.length).toBeGreaterThan(0)
  })
})
