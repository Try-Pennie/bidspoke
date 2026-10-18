import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { filterUnhandledBigTables, runBigTableGuard } from '../big-table-guard'
import { alertRowsAnswer } from '../../__tests__/helpers/slack-alert-read'

describe('filterUnhandledBigTables', () => {
  it('drops known/handled tables (including sf_bid_matrix_audit) and keeps unexpected growers', () => {
    const rows = [
      { table_name: 'persons', est_rows: 900000 },
      // sf_bid_matrix_audit is a non-partitioned BIG_TABLE — must be excluded, or
      // the daily check false-alerts on it (the bug this list fixes).
      { table_name: 'sf_bid_matrix_audit', est_rows: 1230 },
      { table_name: 'audit_log', est_rows: 50000 },
      { table_name: 'some_new_table', est_rows: 4000 },
    ]
    const out = filterUnhandledBigTables(rows)
    expect(out.map((r) => r.table_name)).toEqual(['some_new_table'])
  })

  it('drops cron_tick_deliveries, the table the 2026-10-18 growth alert named (#2390)', () => {
    // About 1,900 rows a day kept 7 days by design (#2284), and its one reader
    // pages with an order, so the daily check must not keep alerting on it.
    const out = filterUnhandledBigTables([{ table_name: 'cron_tick_deliveries', est_rows: 1264 }])
    expect(out).toEqual([])
  })
})

// Supabase mock: rpc -> table estimates; from('service_connections') list; and
// getSlackConnection's alert row read, ending in limit (slack config).
function makeSupabase(rpcRows: { table_name: string; est_rows: number }[]) {
  const chain: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'select') return () => chain
      if (prop === 'eq') return () => chain
      if (prop === 'limit') return alertRowsAnswer(async () => ({ data: { config: { bot_token: 'xoxb', default_channel: '#a' } }, error: null }))
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: [{ organization_id: 'org-1' }], error: null })
      return () => chain
    },
  })
  return {
    rpc: vi.fn().mockResolvedValue({ data: rpcRows, error: null }),
    from: () => chain,
  }
}

function makeKv(cooldownSet = false) {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (k: string) => (cooldownSet ? '1' : store.get(k) ?? null)),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
  } as unknown as KVNamespace & { put: ReturnType<typeof vi.fn> }
}

describe('runBigTableGuard', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.2' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('does nothing when only known tables are over the threshold', async () => {
    const sb = makeSupabase([{ table_name: 'persons', est_rows: 900000 }])
    const res = await runBigTableGuard(sb as never, makeKv())
    expect(res.offenders).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('alerts and records the offender set when an unknown table is over the threshold', async () => {
    const sb = makeSupabase([{ table_name: 'new_big', est_rows: 4000 }])
    const kv = makeKv()
    const res = await runBigTableGuard(sb as never, kv)
    expect(res.offenders).toEqual(['new_big'])
    expect(res.alerted).toBe(true)
    expect(fetchMock).toHaveBeenCalled()
    expect((kv as unknown as { put: ReturnType<typeof vi.fn> }).put).toHaveBeenCalledWith('bigtbl:alerted:new_big', '1', expect.anything())
  })

  it('stays quiet when the same offender set was already alerted (cooldown)', async () => {
    const sb = makeSupabase([{ table_name: 'new_big', est_rows: 4000 }])
    const res = await runBigTableGuard(sb as never, makeKv(true))
    expect(res.alerted).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
