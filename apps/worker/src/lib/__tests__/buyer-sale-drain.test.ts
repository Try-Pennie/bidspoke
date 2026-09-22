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
import { BUYER_SALE_DRAIN_JOB, OUTBOX_BACKLOG_MS, numericOrNull, runBuyerSaleDrain, type DrainDeps, type DrainLedger } from '../buyer-sale-drain'

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

  it('an old backlog that this tick delivers in full does not page: the age was measured before the delivery, the alert is about what is left', async () => {
    const old = entry({ reserved_at: NOW - OUTBOX_BACKLOG_MS - 1000 })
    const d = deps({ ledger: () => fakeLedger([old]) })
    const summary = await runBuyerSaleDrain(d)
    expect(summary.buyers[0]).toMatchObject({ pending: 1, delivered: 1, failed: 0 })
    expect(d.notify).toHaveBeenCalledWith([])
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
})
