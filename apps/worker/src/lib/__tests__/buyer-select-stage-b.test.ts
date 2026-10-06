/**
 * The Stage B daily report (#1809): beside each Stage A parity row, what the
 * canary arm (buyer_select selling live) and the legacy arm (tripoint_ping) did
 * that day, so each live percent step is judged from one stored row rather than
 * a few dozen hand queries over tables that are purged within a week.
 *
 * Read from the rows the parity refresh already reads, plus Tripoint's bid rows
 * for the one per execution criterion. Those drain within about a day of
 * export, so a day whose bid rows are gone is unmeasured, never a count of zero
 * missing (L98, L90); an execution too recent for its bid row to have landed is
 * settling, never missing.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PAGE_SIZE } from '../paginate'
import type { ParityExecution } from '../buyer-select-parity'
import { productionStageBBidDeps, readStageBBids, summariseStageB, type StageBBidReadDeps } from '../buyer-select-stage-b'

const T0 = '2027-09-20T15:30:00.000Z'
const SETTLED = Date.parse('2027-09-21T00:00:00.000Z')

/** A canary execution: buyer_select sold or declined live and no legacy step ran. */
function canary(id: string, o: { accepted: boolean; code: string | null; duration: number; call?: number; percent?: number; started?: string }): ParityExecution {
  return {
    execution_id: id,
    started_at: o.started ?? T0,
    node: {
      _route: o.accepted ? 'sold' : 'no_sale',
      reason: o.accepted ? 'sold' : 'declined_by_buyer',
      mode_effective: 'live',
      live_percent_in_force: o.percent ?? 1,
      sale: { skipped: false, accepted: o.accepted, result_code: o.code },
      ...(o.call === undefined ? {} : { buyer_call_ms: o.call }),
    },
    node_duration_ms: o.duration,
    incumbent: null,
  }
}

/** A legacy execution: the node deferred the lead (outside the share) and tripoint_ping sold it or not. */
function legacy(id: string, o: { qualified: boolean; code: number | null; duration: number; started?: string }): ParityExecution {
  return {
    execution_id: id,
    started_at: o.started ?? T0,
    node: { _route: 'deferred', reason: 'canary_out', mode_effective: 'live', live_percent_in_force: 1, sale: { skipped: true, accepted: false, result_code: null } },
    node_duration_ms: 0,
    incumbent: { skipped: false, qualified: o.qualified, resultCode: o.code },
    incumbent_duration_ms: o.duration,
  }
}

const notForSale = (id: string): ParityExecution => ({
  execution_id: id,
  started_at: T0,
  node: { _route: 'not_applicable', reason: 'bid_not_positive', mode_effective: 'live', live_percent_in_force: null, sale: { skipped: true, accepted: false, result_code: null } },
  node_duration_ms: 0,
  incumbent: { skipped: true, qualified: null, resultCode: null },
  incumbent_duration_ms: 3,
})

const oneEach = (execs: ParityExecution[]) => ({ rows: new Map(execs.map((e) => [e.execution_id, 1])) })

describe('summariseStageB', () => {
  it('counts each arm\'s attempts, accepts and answer codes, and leaves out a lead neither arm tried to sell', () => {
    const execs = [
      canary('c1', { accepted: true, code: '1001', duration: 3400, call: 3100 }),
      canary('c2', { accepted: false, code: '1003', duration: 3800, call: 3500 }),
      legacy('l1', { qualified: true, code: 1001, duration: 2800 }),
      legacy('l2', { qualified: true, code: 1001, duration: 2700 }),
      legacy('l3', { qualified: false, code: 1003, duration: 2900 }),
      notForSale('n1'),
    ]
    const s = summariseStageB(execs, oneEach(execs), SETTLED, true)
    expect(s.canary).toMatchObject({ attempts: 2, accepted: 1, result_codes: { '1001': 1, '1003': 1 } })
    expect(s.legacy).toMatchObject({ attempts: 3, accepted: 2, result_codes: { '1001': 2, '1003': 1 } })
    expect(s.live_percent_seen).toEqual([1])
  })

  it('splits the canary time into the buyer call and the node\'s own time, and states the added time against the legacy step at p50 and p95', () => {
    const execs = [
      canary('c1', { accepted: true, code: '1001', duration: 3400, call: 3100 }),
      canary('c2', { accepted: false, code: '1003', duration: 3800, call: 3500 }),
      legacy('l1', { qualified: true, code: 1001, duration: 2800 }),
      legacy('l2', { qualified: false, code: 1003, duration: 3000 }),
    ]
    const s = summariseStageB(execs, oneEach(execs), SETTLED, true)
    expect(s.canary).toMatchObject({ duration_p50_ms: 3400, duration_p95_ms: 3800, buyer_call_p50_ms: 3100, buyer_call_p95_ms: 3500, own_p50_ms: 300, own_p95_ms: 300, buyer_call_unmeasured: 0 })
    expect(s.legacy).toMatchObject({ duration_p50_ms: 2800, duration_p95_ms: 3000 })
    expect(s).toMatchObject({ added_p50_ms: 600, added_p95_ms: 800 })
  })

  it('a canary row written before the call was timed counts as an attempt, adds nothing to the call or own figures, and is counted as unmeasured (L90)', () => {
    const execs = [canary('c1', { accepted: true, code: '1001', duration: 3400 })]
    const s = summariseStageB(execs, oneEach(execs), SETTLED, true)
    expect(s.canary).toMatchObject({ attempts: 1, duration_p50_ms: 3400, buyer_call_p50_ms: null, own_p50_ms: null, buyer_call_unmeasured: 1 })
  })

  it('a day with no canary attempts has null percentiles and no added time, never zero', () => {
    const execs = [legacy('l1', { qualified: true, code: 1001, duration: 2800 })]
    const s = summariseStageB(execs, oneEach(execs), SETTLED, true)
    expect(s.canary).toMatchObject({ attempts: 0, duration_p50_ms: null, buyer_call_p50_ms: null })
    expect(s).toMatchObject({ added_p50_ms: null, added_p95_ms: null })
  })

  it('counts an answer with no code under none, so an unknown outcome is visible in the mix rather than dropped', () => {
    const execs = [canary('c1', { accepted: false, code: null, duration: 20000 }), legacy('l1', { qualified: false, code: null, duration: 8000 })]
    const s = summariseStageB(execs, oneEach(execs), SETTLED, true)
    expect(s.canary.result_codes).toEqual({ none: 1 })
    expect(s.legacy.result_codes).toEqual({ none: 1 })
  })

  it('checks one Tripoint bid row per attempted execution on each arm, naming missing and doubled rows separately', () => {
    const execs = [
      canary('c1', { accepted: true, code: '1001', duration: 3400 }),
      canary('c2', { accepted: true, code: '1001', duration: 3400 }),
      legacy('l1', { qualified: true, code: 1001, duration: 2800 }),
      legacy('l2', { qualified: true, code: 1001, duration: 2800 }),
      notForSale('n1'),
    ]
    const rows = new Map([['c1', 1], ['l1', 2]])
    const s = summariseStageB(execs, { rows }, SETTLED, true)
    expect(s.bid_rows).toEqual({ canary_missing: 1, canary_multiple: 0, legacy_missing: 1, legacy_multiple: 1, settling: 0, window_complete: true })
  })

  it('an execution too recent for its bid row to have landed is settling, never missing', () => {
    const execs = [canary('c1', { accepted: true, code: '1001', duration: 3400, started: '2027-09-21T00:05:00.000Z' })]
    const s = summariseStageB(execs, { rows: new Map() }, SETTLED, true)
    expect(s.bid_rows).toEqual({ canary_missing: 0, canary_multiple: 0, legacy_missing: 0, legacy_multiple: 0, settling: 1, window_complete: true })
  })

  it('bid rows that are gone or unreadable make the check unmeasured, with the reason, and leave every other figure standing', () => {
    const execs = [canary('c1', { accepted: true, code: '1001', duration: 3400 })]
    const s = summariseStageB(execs, { unmeasured: 'the bid rows for this day have already been exported and removed' }, SETTLED, true)
    expect(s.bid_rows).toEqual({ unmeasured: 'the bid rows for this day have already been exported and removed' })
    expect(s.canary.attempts).toBe(1)
  })

  it('a check taken while the day is still running says so, so a partial day is never read as the whole of it', () => {
    const execs = [canary('c1', { accepted: true, code: '1001', duration: 3400 })]
    expect(summariseStageB(execs, oneEach(execs), SETTLED, false).bid_rows).toMatchObject({ window_complete: false })
  })

  it('lists every live percent seen that day, so a day that changed step is visible', () => {
    const execs = [canary('c1', { accepted: true, code: '1001', duration: 3400, percent: 1 }), canary('c2', { accepted: true, code: '1001', duration: 3400, percent: 5 })]
    expect(summariseStageB(execs, oneEach(execs), SETTLED, true).live_percent_seen).toEqual([1, 5])
  })
})

describe('readStageBBids', () => {
  const DAY = '2027-09-20'
  // The Eastern day 2027-09-20 runs from 04:00Z to 2027-09-21T04:00Z.
  const deps = (over: Partial<StageBBidReadDeps> = {}): StageBBidReadDeps => ({
    earliestBidRowIso: async () => '2027-09-19T09:00:00.000Z',
    listBidExecutions: async () => ['c1', 'l1', 'l1'],
    ...over,
  })

  it('counts the bid rows per execution over the day plus a margin, so a call made seconds after midnight still counts', async () => {
    let asked: [string, string] | null = null
    const r = await readStageBBids(deps({ listBidExecutions: async (from, to) => { asked = [from, to]; return ['c1', 'l1', 'l1'] } }), DAY)
    expect(asked).toEqual(['2027-09-20T04:00:00.000Z', '2027-09-21T04:10:00.000Z'])
    expect(r).toEqual({ rows: new Map([['c1', 1], ['l1', 2]]) })
  })

  it('is unmeasured when the oldest bid row still held is later than the day\'s start: part of the day has drained', async () => {
    const r = await readStageBBids(deps({ earliestBidRowIso: async () => '2027-09-20T09:00:00.000Z' }), DAY)
    expect(r).toEqual({ unmeasured: expect.stringMatching(/exported and removed/) })
  })

  it('is unmeasured when no bid row is held at all', async () => {
    const r = await readStageBBids(deps({ earliestBidRowIso: async () => null }), DAY)
    expect(r).toEqual({ unmeasured: expect.stringMatching(/no Tripoint bid row/) })
  })
})

describe('productionStageBBidDeps', () => {
  it('an oldest row whose time cannot be read is an error, never reported as no row held (L11)', async () => {
    const client = {
      from() {
        const chain: Record<string, unknown> = {
          select() { return chain }, eq() { return chain }, order() { return chain }, limit() { return chain },
          then(res: (v: unknown) => unknown) { return Promise.resolve({ data: [{ attempted_at_utc: 'not a time' }], error: null }).then(res) },
        }
        return chain
      },
    } as unknown as SupabaseClient
    await expect(productionStageBBidDeps(client).earliestBidRowIso()).rejects.toThrow(/could not be read as a time/)
  })

  it('reads the oldest bid row once per set of deps, since every day of one refresh asks the same question (#1809)', async () => {
    let reads = 0
    const client = {
      from() {
        reads += 1
        const chain: Record<string, unknown> = {
          select() { return chain }, eq() { return chain }, order() { return chain }, limit() { return chain },
          then(res: (v: unknown) => unknown) { return Promise.resolve({ data: [{ attempted_at_utc: '2027-09-19 09:00:00' }], error: null }).then(res) },
        }
        return chain
      },
    } as unknown as SupabaseClient
    const deps = productionStageBBidDeps(client)
    await deps.earliestBidRowIso()
    await deps.earliestBidRowIso()
    expect(reads).toBe(1)
  })

  /** Records the filters each query applied, and answers pages of execution ids. */
  function double(total: number) {
    const calls: Array<Record<string, unknown>> = []
    const client = {
      from(table: string) {
        const q: Record<string, unknown> = { table, filters: [] as string[] }
        calls.push(q)
        const chain: Record<string, unknown> = {
          select(cols: string) { q.select = cols; return chain },
          eq(col: string, v: unknown) { (q.filters as string[]).push(`${col}=${String(v)}`); return chain },
          is(col: string, v: unknown) { (q.filters as string[]).push(`${col} is ${String(v)}`); return chain },
          not(col: string, op: string, v: unknown) { (q.filters as string[]).push(`${col} not ${op} ${String(v)}`); return chain },
          gte(col: string, v: unknown) { (q.filters as string[]).push(`${col}>=${String(v)}`); return chain },
          lt(col: string, v: unknown) { (q.filters as string[]).push(`${col}<${String(v)}`); return chain },
          order(col: string) { q.order = [...((q.order as string[]) ?? []), col]; return chain },
          limit(n: number) { q.limit = n; return chain },
          range(from: number, to: number) {
            q.range = [from, to]
            const n = Math.max(0, Math.min(to + 1, total) - from)
            return Promise.resolve({ data: Array.from({ length: n }, (_, i) => ({ execution_id: `e${from + i}` })), error: null })
          },
          then(res: (v: unknown) => unknown) {
            return Promise.resolve({ data: [{ attempted_at_utc: '2027-09-19 09:00:00.123' }], error: null }).then(res)
          },
        }
        return chain
      },
    } as unknown as SupabaseClient
    return { client, calls }
  }

  /**
   * "Attempted" is a row with a classification. Measured on production 2026-10-06 (Tripoint rows,
   * 04:00 to 16:00 UTC): the bail rows are classification null with skip_reason 'skipped' (11,150);
   * every attempt carries a classification, accept (806), decline (714) or unknown (2), and the
   * legacy arm's declines ALSO carry a skip_reason, 'duplicate' (614) or 'rejected' (95). Keying on
   * skip_reason being null counted those 709 declines as missing bid rows.
   */
  it('reads only Tripoint rows that were really attempted (a classification, whatever the skip reason), outside test runs, inside the window, every page in a stable order', async () => {
    const db = double(PAGE_SIZE + 5)
    const ids = await productionStageBBidDeps(db.client).listBidExecutions('2027-09-20T04:00:00.000Z', '2027-09-21T04:10:00.000Z')
    expect(ids).toHaveLength(PAGE_SIZE + 5)
    const first = db.calls[0]
    expect(first.table).toBe('lead_sighting_bids')
    expect(first.filters).toEqual(expect.arrayContaining(['partner_slug=tripoint', 'classification not is null', 'is_test not is true', 'attempted_at_utc>=2027-09-20T04:00:00.000Z', 'attempted_at_utc<2027-09-21T04:10:00.000Z']))
    expect(first.filters).not.toContain('skip_reason is null')
    expect(first.order).toEqual(['attempted_at_utc', 'id'])
  })

  it('reads the oldest Tripoint bid row held as a UTC instant, since the column carries no zone', async () => {
    const db = double(0)
    expect(await productionStageBBidDeps(db.client).earliestBidRowIso()).toBe('2027-09-19T09:00:00.123Z')
    expect(db.calls[0].filters).toEqual(expect.arrayContaining(['partner_slug=tripoint']))
    expect(db.calls[0].limit).toBe(1)
  })
})
