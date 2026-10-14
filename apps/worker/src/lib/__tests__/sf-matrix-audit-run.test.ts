import { describe, it, expect, vi, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BID_RANGE_ROW_DESCRIBE } from './fixtures/bid-range-row-describe'

vi.mock('../salesforce-creds', () => ({
  resolveSalesforceCredentialOrg: vi.fn().mockResolvedValue({ orgId: 'org-1', error: null }),
  requireSalesforceCreds: vi.fn().mockResolvedValue({ instanceUrl: 'https://x.my.salesforce.com', clientId: 'id', clientSecret: 'secret' }),
}))
vi.mock('../../engine/nodes/salesforce', () => ({ getSalesforceToken: vi.fn().mockResolvedValue('tok') }))

import { runMatrixAudit } from '../sf-matrix-audit'
import type { Env } from '../../index'

// Records every table touched and every write, and answers every read with no rows.
function recordingSupabase() {
  const writes: string[] = []
  const tables: string[] = []
  const chain = (table: string): unknown => new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      if (prop === 'upsert' || prop === 'delete' || prop === 'insert' || prop === 'update') writes.push(`${table}.${String(prop)}`)
      return () => chain(table)
    },
  })
  const client = { from: (t: string) => { tables.push(t); return chain(t) } } as unknown as SupabaseClient
  return { client, writes, tables }
}

afterEach(() => vi.restoreAllMocks())

describe('runMatrixAudit', () => {
  // An empty read is a failed read: the matrix holds about 1,500 rows. Rebuilding
  // the record from it would empty the comparison and post a notice claiming a
  // rebuild, so the run stops and the matrix audit watcher reports it.
  it('compares, rebuilds and posts nothing when Salesforce returns no rows', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/sobjects/BidRangeRow__c/describe')) return new Response(JSON.stringify(BID_RANGE_ROW_DESCRIBE), { status: 200 })
      if (url.includes('/query?q=')) return new Response(JSON.stringify({ records: [], done: true }), { status: 200 })
      throw new Error(`unexpected request to ${url}`)
    })
    const { client, writes, tables } = recordingSupabase()

    const result = await runMatrixAudit({} as Env, client)

    expect(result).toEqual({ rows_fetched: 0, rows_added: 0, rows_edited: 0, rows_removed: 0, matrices_changed: 0, baseline: false, alerted: false, snapshot_rows: 0 })
    expect(writes).toEqual([])
    expect(tables).not.toContain('service_connections')
    expect(fetchSpy.mock.calls.map((c) => String(c[0])).some((u) => u.includes('slack.com'))).toBe(false)
  })
})

// #835: a failure in our own database was reported in Salesforce's words. Each
// snapshot step now throws an error naming itself, so the alert can say which
// system refused and whether an edit was already reported.
describe('runMatrixAudit names the snapshot step that failed (#835)', () => {
  function failingSupabase(failOn: 'select' | 'upsert') {
    const chain = (op: string | null): unknown => new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') {
          const error = op === failOn ? { message: `${failOn} refused`, code: '42501' } : null
          return (res: (v: unknown) => unknown) => Promise.resolve({ data: error ? null : [], error }).then(res)
        }
        const next = ['select', 'upsert', 'delete'].includes(String(prop)) ? String(prop) : op
        return () => chain(next)
      },
    })
    return { from: () => chain(null) } as unknown as SupabaseClient
  }

  function salesforce(records: unknown[]) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/sobjects/BidRangeRow__c/describe')) return new Response(JSON.stringify(BID_RANGE_ROW_DESCRIBE), { status: 200 })
      if (url.includes('/query?q=')) return new Response(JSON.stringify({ records, done: true }), { status: 200 })
      throw new Error(`unexpected request to ${url}`)
    })
  }

  it('a snapshot read failure is the snapshot_read step', async () => {
    salesforce([])
    await expect(runMatrixAudit({} as Env, failingSupabase('select'))).rejects.toMatchObject({ step: 'snapshot_read' })
  })

  // The save that REBUILDS an untrustworthy copy runs before anything is reported,
  // unlike the save after a comparison, which runs after its alert. They are two
  // steps so the alert can say which (merge review of #2082).
  it('a failed save while rebuilding an empty copy is the baseline_write step', async () => {
    salesforce([{ Id: 'a1', RowId__c: 1, RangeLow__c: 600, RangeHigh__c: 650, BidAmount__c: 10 }])
    await expect(runMatrixAudit({} as Env, failingSupabase('upsert'))).rejects.toMatchObject({ step: 'baseline_write' })
  })
})
