/**
 * The minute drain (#1413): the ledger is the outbox for buyer_sales. Every
 * entry the inline mirror failed to copy, or whose state changed since it was
 * copied, is delivered here through the same write the node uses, so a database
 * outage never loses a row and never stops selling (L33, L258). A backlog older
 * than five ticks pages, naming the buyer (L13); a ledger that cannot be read
 * is reported as unmeasured, never as an empty outbox (L98, L215).
 */
import { describe, expect, it, vi } from 'vitest'
import type { EntryKey, LedgerEntry } from '../../durable-objects/buyer-ledger'
import { buyerSaleRowId } from '../buyer-sale-mirror'
import { BUYER_SALE_DRAIN_JOB, EXISTING_ROWS_PER_READ, OUTBOX_BACKLOG_MS, numericOrNull, productionDrainDeps, readExistingBuyerSaleRows, runBuyerSaleDrain, type DrainDeps, type DrainLedger } from '../buyer-sale-drain'
import { isTransientExportError } from '../export-error-hints'
import { DeadlineError } from '@bidspoke/buyer-profile'
import type { Env } from '../../index'
import { profilesTableDouble } from './_profiles-table-double'

const NOW = Date.UTC(2027, 8, 20, 15, 40)
const PARTNER = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    lead_key: 'lead-1', population: 'engine', kind: 'live', payout_cents: 2190, status: 'accepted',
    et_day: '2027-09-20', hour_bucket: 505_935, reserved_at: NOW - 30_000, resolved_at: NOW - 28_000,
    mirrored: false, execution_id: '0192a4f0-0000-7000-8000-000000000001',
    outcome: { buyer_reference: 'L-1', result_code: '1000', http_status: 200, payout_cents: 2190 },
    resolution_source: 'buyer', resolved_by: null,
    ...over,
  }
}

/** An in memory ledger: unmirrored lists what is not yet marked, markMirrored marks it. */
function fakeLedger(entries: LedgerEntry[], opts: { unreadable?: string } = {}): DrainLedger & { marked: EntryKey[] } {
  const marked: EntryKey[] = []
  return {
    marked,
    async unmirrored() {
      if (opts.unreadable) throw new Error(opts.unreadable)
      const pending = entries.filter((e) => !marked.some((k) => k.lead_key === e.lead_key && k.population === e.population && k.kind === e.kind))
      const oldest = pending[0]
      return { entries: pending, oldest_age_ms: oldest ? NOW - oldest.reserved_at : null }
    },
    async markMirrored(keys) {
      marked.push(...keys)
      return keys.length
    },
  }
}

function deps(over: Partial<DrainDeps> = {}): DrainDeps & { rpc: ReturnType<typeof vi.fn>; lines: string[] } {
  const rpc = vi.fn(async (_fn: string, args: { p_row: { id: string; status: string } }) => ({ data: { id: args.p_row.id, status: args.p_row.status }, error: null }))
  const notify = vi.fn(async (_lines: string[]) => {})
  const lines: string[] = []
  return {
    rpc,
    notify,
    lines,
    listBuyers: async () => [{ partner_id: PARTNER, organization_id: ORG, slug: 'tripoint' }],
    ledger: () => fakeLedger([entry()]),
    readExistingRows: async () => new Map(),
    supabase: { rpc } as never,
    now: () => NOW,
    localDev: false,
    log: (line: string) => lines.push(line),
    ...over,
  }
}

describe('runBuyerSaleDrain', () => {
  it('delivers each unmirrored entry through record_buyer_sale and marks it mirrored, with nulls for what no row already holds', async () => {
    const ledger = fakeLedger([entry()])
    const d = deps({ ledger: () => ledger })
    const summary = await runBuyerSaleDrain(d)
    expect(d.rpc).toHaveBeenCalledTimes(1)
    const [fn, args] = d.rpc.mock.calls[0] as [string, { p_row: Record<string, unknown> }]
    expect(fn).toBe('record_buyer_sale')
    expect(args.p_row).toMatchObject({ id: await buyerSaleRowId(PARTNER, entry()), partner_id: PARTNER, organization_id: ORG, status: 'accepted', debt: null, multiplier: null, workflow_id: null, trace_id: null })
    expect(ledger.marked).toEqual([{ lead_key: 'lead-1', population: 'engine', kind: 'live' }])
    expect(summary.buyers[0]).toMatchObject({ slug: 'tripoint', pending: 1, delivered: 1, failed: 0 })
    expect(d.notify).toHaveBeenCalledWith([])
  })

  it('carries the pricing and provenance an earlier copy of the row already holds, so a re-delivered row is not blanked', async () => {
    const id = await buyerSaleRowId(PARTNER, entry())
    const d = deps({
      readExistingRows: async (ids) => {
        expect(ids).toEqual([id])
        return new Map([[id, { workflow_id: '33333333-3333-4333-8333-333333333333', trace_id: 'trace-1', debt: 18250, multiplier: 0.0012, live_percent_in_force: 100, caps_in_force: null }]])
      },
    })
    await runBuyerSaleDrain(d)
    const [, args] = d.rpc.mock.calls[0] as [string, { p_row: Record<string, unknown> }]
    expect(args.p_row).toMatchObject({ workflow_id: '33333333-3333-4333-8333-333333333333', trace_id: 'trace-1', debt: 18250, multiplier: 0.0012, live_percent_in_force: 100 })
  })

  it('a mirror failure leaves the entry unmirrored and counted, and the next tick delivers it (L33)', async () => {
    const ledger = fakeLedger([entry(), entry({ lead_key: 'lead-2' })])
    let failOnce = true
    const rpc = vi.fn(async (_fn: string, args: { p_row: { id: string; status: string; lead_key: string } }) => {
      if (failOnce && args.p_row.lead_key === 'lead-1') { failOnce = false; return { data: null, error: { message: 'connection reset' } } }
      return { data: { id: args.p_row.id, status: args.p_row.status }, error: null }
    })
    const d = deps({ ledger: () => ledger, supabase: { rpc } as never })
    const first = await runBuyerSaleDrain(d)
    expect(first.buyers[0]).toMatchObject({ pending: 2, delivered: 1, failed: 1 })
    expect(first.errors.join(' ')).toMatch(/lead-1.*connection reset/)
    expect(ledger.marked).toHaveLength(1)
    const second = await runBuyerSaleDrain(d)
    expect(second.buyers[0]).toMatchObject({ pending: 1, delivered: 1, failed: 0 })
    expect(ledger.marked).toHaveLength(2)
  })

  it('pages, naming the buyer, when the oldest uncopied entry is older than five ticks, and clears when the backlog is younger', async () => {
    const old = entry({ reserved_at: NOW - OUTBOX_BACKLOG_MS - 1000 })
    const rpcFailing = vi.fn(async () => ({ data: null, error: { message: 'db down' } }))
    const d = deps({ ledger: () => fakeLedger([old]), supabase: { rpc: rpcFailing } as never })
    await runBuyerSaleDrain(d)
    const lines = vi.mocked(d.notify).mock.calls[0][0] as string[]
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/tripoint/)
    expect(lines[0]).toMatch(/1 (entry|entries) not yet copied/)
    expect(lines[0]).toMatch(/db down/)
    // Young backlog, even one that failed this tick, does not page yet.
    const young = deps({ ledger: () => fakeLedger([entry()]), supabase: { rpc: rpcFailing } as never })
    await runBuyerSaleDrain(young)
    expect(young.notify).toHaveBeenCalledWith([])
  })

  it('a partial delivery pages on the age of what is LEFT: an old entry delivered and a young one failed is a young backlog', async () => {
    const old = entry({ lead_key: 'lead-old', reserved_at: NOW - OUTBOX_BACKLOG_MS - 1000 })
    const young = entry({ lead_key: 'lead-young', reserved_at: NOW - 30_000 })
    const rpc = vi.fn(async (_fn: string, args: { p_row: { id: string; status: string; lead_key: string } }) =>
      args.p_row.lead_key === 'lead-young' ? { data: null, error: { message: 'db down' } } : { data: { id: args.p_row.id, status: args.p_row.status }, error: null })
    const d = deps({ ledger: () => fakeLedger([old, young]), supabase: { rpc } as never })
    const summary = await runBuyerSaleDrain(d)
    expect(summary.buyers[0]).toMatchObject({ pending: 2, delivered: 1, failed: 1, remaining_oldest_age_ms: 30_000 })
    expect(d.notify).toHaveBeenCalledWith([])
  })

  it('an old backlog that this tick delivers in full does not page: the age was measured before the delivery, the alert is about what is left', async () => {
    const old = entry({ reserved_at: NOW - OUTBOX_BACKLOG_MS - 1000 })
    const d = deps({ ledger: () => fakeLedger([old]) })
    const summary = await runBuyerSaleDrain(d)
    expect(summary.buyers[0]).toMatchObject({ pending: 1, delivered: 1, failed: 0 })
    expect(d.notify).toHaveBeenCalledWith([])
  })

  it('a ledger that only missed its deadline pages a line the alerter holds for one minute, not one it pages at once', async () => {
    const slow: DrainLedger = { unmirrored: async () => { throw new DeadlineError('buyer ledger unmirrored', 5000) }, markMirrored: async () => 0 }
    const d = deps({ ledger: () => slow })
    await runBuyerSaleDrain(d)
    const lines = vi.mocked(d.notify).mock.calls[0][0] as string[]
    expect(lines).toHaveLength(1)
    expect(isTransientExportError(lines[0])).toBe(true)
  })

  it('a ledger that cannot be read is reported unmeasured for that buyer and pages, while the other buyers still drain (L98)', async () => {
    const ok = fakeLedger([entry()])
    const d = deps({
      listBuyers: async () => [
        { partner_id: PARTNER, organization_id: ORG, slug: 'tripoint' },
        { partner_id: '44444444-4444-4444-8444-444444444444', organization_id: ORG, slug: 'acme' },
      ],
      ledger: (partnerId) => (partnerId === PARTNER ? ok : fakeLedger([], { unreadable: 'buyer ledger unmirrored answered 500: boom' })),
    })
    const summary = await runBuyerSaleDrain(d)
    expect(summary.buyers.find((b) => b.slug === 'acme')).toMatchObject({ unmeasured: expect.stringMatching(/answered 500/) })
    expect(summary.buyers.find((b) => b.slug === 'tripoint')).toMatchObject({ delivered: 1 })
    const lines = vi.mocked(d.notify).mock.calls[0][0] as string[]
    expect(lines.join(' ')).toMatch(/acme.*could not be read/)
  })

  it('a buyer list that cannot be read is a failed run that pages, never an empty run that clears the alert (L215)', async () => {
    const d = deps({ listBuyers: async () => { throw new Error('partner_configs unreadable') } })
    const summary = await runBuyerSaleDrain(d)
    expect(summary.unmeasured).toMatch(/partner_configs unreadable/)
    expect(summary.buyers).toEqual([])
    const lines = vi.mocked(d.notify).mock.calls[0][0] as string[]
    expect(lines.join(' ')).toMatch(/partner_configs unreadable/)
  })

  it('does nothing in local dev, and says so, because the write would go to production (#669)', async () => {
    const d = deps({ localDev: true })
    const summary = await runBuyerSaleDrain(d)
    expect(summary.skipped).toBe('local_dev')
    expect(d.rpc).not.toHaveBeenCalled()
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('a stored numeric that does not parse becomes null, never NaN (L50)', () => {
    expect(numericOrNull('18250.00')).toBe(18250)
    expect(numericOrNull(0.0012)).toBe(0.0012)
    expect(numericOrNull(null)).toBeNull()
    expect(numericOrNull('not a number')).toBeNull()
  })

  it('names its job for the heartbeat registry and the mute keys', () => {
    expect(BUYER_SALE_DRAIN_JOB).toBe('buyer-sale-drain')
    expect(OUTBOX_BACKLOG_MS).toBe(5 * 60 * 1000)
  })
  describe('readExistingBuyerSaleRows: a backlog past one request', () => {
    // A stand in for PostgREST: every id sits in the query string, so a request
    // naming more than URL_ID_LIMIT ids is refused as too long, and a response
    // is capped at 1,000 rows. A day long outage leaves thousands uncopied.
    const URL_ID_LIMIT = 400
    function fakeSales(stored: string[]) {
      const requests: number[] = []
      const supabase = {
        from: (table: string) => ({
          select: () => ({
            in: async (_col: string, ids: string[]) => {
              expect(table).toBe('buyer_sales')
              requests.push(ids.length)
              if (ids.length > URL_ID_LIMIT) return { data: null, error: { message: '414 URI Too Long' } }
              const rows = ids.filter((id) => stored.includes(id)).slice(0, 1_000)
              return { data: rows.map((id) => ({ id, workflow_id: 'wf', trace_id: 't', debt: '18250.00', multiplier: 0.0012, live_percent_in_force: 100, caps_in_force: null })), error: null }
            },
          }),
        }),
      }
      return { supabase: supabase as never, requests }
    }
    const idsOf = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)

    it('reads a 2,500 entry backlog in bounded requests and returns every stored row', async () => {
      const ids = idsOf(2_500)
      const { supabase, requests } = fakeSales(ids)
      const out = await readExistingBuyerSaleRows(supabase, ids)
      expect(out.size).toBe(2_500)
      expect(out.get(ids[2_499])).toEqual({ workflow_id: 'wf', trace_id: 't', debt: 18250, multiplier: 0.0012, live_percent_in_force: 100, caps_in_force: null })
      expect(Math.max(...requests)).toBeLessThanOrEqual(EXISTING_ROWS_PER_READ)
      expect(requests.reduce((a, b) => a + b, 0)).toBe(2_500)
    })

    it('makes no request for an empty backlog', async () => {
      const { supabase, requests } = fakeSales([])
      expect((await readExistingBuyerSaleRows(supabase, [])).size).toBe(0)
      expect(requests).toEqual([])
    })

    it('a batch that fails throws with the database message, so the tick waits rather than writing a first copy without its pricing', async () => {
      const supabase = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: 'statement timeout' } }) }) }) } as never
      await expect(readExistingBuyerSaleRows(supabase, idsOf(3))).rejects.toThrow('buyer_sales: statement timeout')
    })

    it('the batch fits both the URL and the row cap', () => {
      expect(EXISTING_ROWS_PER_READ).toBeGreaterThan(0)
      expect(EXISTING_ROWS_PER_READ).toBeLessThanOrEqual(Math.min(URL_ID_LIMIT, 1_000))
    })
  })
})

// #1541: a click sold buyer never reserves in the buyer ledger, so the drain
// has no outbox of its to deliver; only offer buyers are listed.
describe('productionDrainDeps lists offer buyers only', () => {
  it('leaves a click sold buyer out of the drain, enabled or not', async () => {
    const supabase = profilesTableDouble([
      { partner_id: 'p-offer', sold_on: 'offer', is_enabled: false, partner_configs: { organization_id: ORG, slug: 'tripoint' } },
      { partner_id: 'p-click', sold_on: 'click', is_enabled: true, partner_configs: { organization_id: ORG, slug: 'liberty1' } },
    ])
    const buyers = await productionDrainDeps(supabase, {} as unknown as Env).listBuyers()
    expect(buyers).toEqual([{ partner_id: 'p-offer', organization_id: ORG, slug: 'tripoint' }])
  })
})
