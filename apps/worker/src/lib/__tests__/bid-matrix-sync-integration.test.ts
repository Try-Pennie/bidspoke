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
  sendMatrixSyncFailureAlert: vi.fn().mockResolvedValue(true),
}))

import { syncBidConfig, syncAllSalesforceConfigs } from '../bid-matrix-sync'
import { sendMatrixValidationAlert } from '../slack'
import { BID_RANGE_ROW_DESCRIBE } from './fixtures/bid-range-row-describe'

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

// The config the Supabase double serves; a test may swap it.
let servedConfig: Record<string, unknown> = CONFIG

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
      if (prop === 'single') return async () => ({ data: servedConfig, error: null })
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
      if (prop === 'single') return async () => ({ data: servedConfig, error: null })
      return () => listChain
    },
  }
  listChain = new Proxy(function () {}, listHandler)

  return { from: () => proxy } as never
}

// The credentials are resolved through the org env store now, with the Worker env
// as a per-value fallback (#1174), so the double carries the cache binding that
// resolution reads. The store lookup returns nothing here and the fallback
// supplies all three, which is what this test was always exercising: note that
// production has only CLIENT_SECRET on the Worker env, so an ENV double carrying
// all three describes a configuration that does not exist.
const ENV = {
  SALESFORCE_INSTANCE_URL: 'https://sf.example',
  SALESFORCE_CLIENT_ID: 'id',
  SALESFORCE_CLIENT_SECRET: 'secret',
  // Real base64 of 32 bytes: the loader ENCRYPTS what it caches, so a
  // placeholder string fails inside crypto rather than in the code under test.
  SECRET_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  WORKFLOW_CACHE: { get: async () => null, put: async () => undefined },
} as never

describe('#182 sync integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    servedConfig = CONFIG
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

  // #1864: the default matrix is every row no partner claims, and the list of
  // partners grew in Salesforce after it was hard coded here.
  it('syncBidConfig asks Salesforce for its partner list before querying the default matrix', async () => {
    servedConfig = { ...CONFIG, slug: 'default', sf_filters: {}, sf_object: 'OtherMatrix__c' }
    const fetchMock = vi.fn(async (url: string) => (
      url.endsWith('/sobjects/OtherMatrix__c/describe')
        ? { ok: true, json: async () => BID_RANGE_ROW_DESCRIBE }
        : { ok: true, json: async () => ({ records: SF_RECORDS, done: true }) }
    ))
    vi.stubGlobal('fetch', fetchMock)
    await syncBidConfig('cfg-1', ENV, makeSupabase())
    const query = decodeURIComponent(fetchMock.mock.calls.map((c) => c[0]).find((u) => u.includes('/query?q='))!)
    expect(query).toContain('IsBorrowBetter__c = FALSE')
    expect(query).toContain('Is_Lead_Economy__c = FALSE')
    expect(query).toContain('IsSoFi__c = FALSE')
  })
})

// #2141: History credits a Sync now press to the person who pressed it, and the
// hourly run to the job. syncBidConfig carries the actor into writeHistory,
// which is the only writer of bid_config_history.
describe('#2141 who a sync is credited to', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    servedConfig = CONFIG
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ records: SF_RECORDS, done: true }),
    }))
  })

  function recordingSupabase(historyError: { message: string } | null = null) {
    const inserts: Array<{ table: string; row: unknown }> = []
    const base = makeSupabase() as unknown as { from: (t: string) => unknown }
    const client = {
      from: (table: string) => {
        const chain = base.from(table) as object
        return new Proxy(chain, {
          get(target, prop) {
            if (prop === 'insert') {
              return (row: unknown) => {
                inserts.push({ table, row })
                return Promise.resolve({ data: null, error: table === 'bid_config_history' ? historyError : null })
              }
            }
            return Reflect.get(target, prop)
          },
        })
      },
    }
    return { inserts, client: client as never }
  }

  const historyRows = (inserts: Array<{ table: string; row: unknown }>) =>
    inserts.filter((i) => i.table === 'bid_config_history').map((i) => i.row as Record<string, unknown>)

  it('a Sync now press writes the person into changed_by', async () => {
    const { inserts, client } = recordingSupabase()
    await syncBidConfig('cfg-1', ENV, client, 'user-7')
    const rows = historyRows(inserts)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ config_id: 'cfg-1', source: 'salesforce_sync', changed_by: 'user-7' })
  })

  it('the hourly run writes no person', async () => {
    const { inserts, client } = recordingSupabase()
    await syncAllSalesforceConfigs(ENV, client)
    const rows = historyRows(inserts)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ config_id: 'cfg-1', source: 'salesforce_sync', changed_by: null })
  })

  it('a history row that does not land is logged, never silent', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = recordingSupabase({ message: 'insert or update on table violates foreign key constraint' })
    await syncBidConfig('cfg-1', ENV, client, 'user-7')
    expect(errors.mock.calls.some((c) => String(c[0]).includes('[bid-matrix-sync] history write failed'))).toBe(true)
  })
})
