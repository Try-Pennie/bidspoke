/**
 * The minute drain (#1413): the ledger is the outbox for buyer_sales. Every
 * entry the inline mirror failed to copy, or whose state changed since it was
 * copied, is delivered here through the same write the node uses, so a database
 * outage never loses a row and never stops selling (L33, L258). A backlog older
 * than five ticks pages, naming the buyer (L13); a ledger that cannot be read
 * is reported as unmeasured, never as an empty outbox (L98, L215).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EntryKey, LedgerEntry, MirroredStamp } from '../../durable-objects/buyer-ledger'
import { buyerSaleRowId } from '../buyer-sale-mirror'
import {
  BUYER_SALE_DRAIN_JOB,
  DRAIN_TICK_MS,
  EXISTING_ROWS_PER_READ,
  OUTBOX_BACKLOG_MS,
  BUYER_SALE_DRAIN_BACKLOG_REMEDY,
  BUYER_SALE_DRAIN_LEDGER_UNREADABLE_REMEDY,
  BUYER_SALE_DRAIN_MIXED_REMEDY,
  BUYER_SALE_DRAIN_SEVERAL_REMEDY,
  BUYER_SALE_DRAIN_UNLISTED_REMEDY,
  BUYER_SALE_DRAIN_UNMARKED_REMEDY,
  UNREADABLE_SINCE_KEY,
  drainRemedyFor,
  kvUnreadableSince,
  ledgerClientOptions,
  notifyBuyerSaleDrain,
  numericOrNull,
  productionDrainDeps,
  readExistingBuyerSaleRows,
  runBuyerSaleDrain,
  type DrainDeps,
  type DrainLedger,
  type LedgerOptions,
  type UnreadableSinceStore,
  type UnreadableStamps,
} from '../buyer-sale-drain'
import { isTransientExportError } from '../export-error-hints'
import { DeadlineError } from '@bidspoke/buyer-profile'
import { MEASURED_OBJECT_CALL_P99_MS, OBJECT_CALL_DEADLINE_MS, ObjectCallError, ObjectCallLostError } from '../buyer-object-clients'
import type { Env } from '../../index'
import { profilesTableDouble } from './_profiles-table-double'
import { sendExportFailureAlert } from '../slack'

// Only the Slack post is replaced; the drain's duration and time wording stay real.
vi.mock('../slack', async (importOriginal) => ({ ...(await importOriginal<typeof import('../slack')>()), sendExportFailureAlert: vi.fn(async () => true) }))

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
function fakeLedger(entries: LedgerEntry[], opts: { unreadable?: string; movedBeforeMark?: string[] } = {}): DrainLedger & { marked: EntryKey[]; stamps: MirroredStamp[] } {
  const marked: EntryKey[] = []
  const stamps: MirroredStamp[] = []
  return {
    marked,
    stamps,
    async unmirrored() {
      if (opts.unreadable) throw new Error(opts.unreadable)
      const pending = entries.filter((e) => !marked.some((k) => k.lead_key === e.lead_key && k.population === e.population && k.kind === e.kind))
      const oldest = pending[0]
      return { entries: pending, oldest_age_ms: oldest ? NOW - oldest.reserved_at : null }
    },
    // An entry named in movedBeforeMark changed state after the read, so the
    // ledger refuses its mark as the real one does (#2422).
    async markMirrored(given) {
      stamps.push(...given)
      let changed = 0
      for (const s of given) {
        if (opts.movedBeforeMark?.includes(s.lead_key)) changed += 1
        else marked.push({ lead_key: s.lead_key, population: s.population, kind: s.kind })
      }
      return { marked: given.length - changed, changed }
    },
  }
}

/** The record of when each ledger was first found unreadable, held in memory as the KV copy would hold it. */
function memoryStamps(initial: UnreadableStamps = {}): UnreadableSinceStore & { stored: UnreadableStamps | null; writes: number } {
  const store = {
    stored: { ...initial } as UnreadableStamps | null,
    writes: 0,
    async read() { return { ...(store.stored ?? {}) } },
    async write(stamps: UnreadableStamps) { store.writes += 1; store.stored = { ...stamps } },
  }
  return store
}

function deps(over: Partial<DrainDeps> = {}): DrainDeps & { rpc: ReturnType<typeof vi.fn>; lines: string[] } {
  const rpc = vi.fn(async (_fn: string, args: { p_row: { id: string; status: string } }) => ({ data: { id: args.p_row.id, status: args.p_row.status }, error: null }))
  const notify = vi.fn(async (_lines: string[]) => {})
  const lines: string[] = []
  return {
    rpc,
    notify,
    lines,
    unreadableSince: memoryStamps(),
    listBuyers: async () => [{ partner_id: PARTNER, organization_id: ORG, slug: 'tripoint' }],
    ledger: () => fakeLedger([entry()]),
    readExistingRows: async () => new Map(),
    supabase: { rpc } as never,
    recordRun: vi.fn(async () => {}),
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
    // The mark names the state this copy wrote, so the ledger can refuse it if the entry moved (#2422).
    expect(ledger.stamps).toEqual([{ lead_key: 'lead-1', population: 'engine', kind: 'live', status: 'accepted', resolved_at: NOW - 28_000 }])
    expect(summary.buyers[0]).toMatchObject({ slug: 'tripoint', pending: 1, delivered: 1, failed: 0 })
    expect(summary.buyers[0].changed_since_read).toBeUndefined()
    expect(d.notify).toHaveBeenCalledWith([])
  })

  it('an entry whose state changed between the read and the mark is counted as changed, neither delivered nor failed, and is copied again next tick (#2422)', async () => {
    // Old enough that a failure would page: a changed entry must not.
    const moved = entry({ lead_key: 'moved', status: 'reserved', resolved_at: null, outcome: null, resolution_source: null, reserved_at: NOW - OUTBOX_BACKLOG_MS - 60_000 })
    const kept = entry({ lead_key: 'kept' })
    const ledger = fakeLedger([moved, kept], { movedBeforeMark: ['moved'] })
    const d = deps({ ledger: () => ledger })
    const summary = await runBuyerSaleDrain(d)
    expect(d.rpc).toHaveBeenCalledTimes(2)
    expect(summary.buyers[0]).toMatchObject({ pending: 2, delivered: 1, failed: 0, changed_since_read: 1, remaining_oldest_age_ms: null })
    expect(summary.buyers[0].delivered_row_ids).toEqual([await buyerSaleRowId(PARTNER, kept)])
    expect(summary.paged).toEqual([])
    expect(summary.errors).toEqual([])
    expect(d.notify).toHaveBeenCalledWith([])
    // Still in the outbox for the next tick.
    expect((await ledger.unmirrored()).entries.map((e) => e.lead_key)).toEqual(['moved'])
  })

  it('a changed entry is not counted among the undelivered when another entry pages (#2422)', async () => {
    const stuck = entry({ lead_key: 'stuck', reserved_at: NOW - OUTBOX_BACKLOG_MS - 60_000 })
    const moved = entry({ lead_key: 'moved', status: 'reserved', resolved_at: null, outcome: null, resolution_source: null })
    const ledger = fakeLedger([stuck, moved], { movedBeforeMark: ['moved'] })
    const rpc = vi.fn(async (_fn: string, args: { p_row: { id: string; lead_key: string; status: string } }) =>
      args.p_row.lead_key === 'stuck' ? { data: null, error: { message: 'supabase down' } } : { data: { id: args.p_row.id, status: args.p_row.status }, error: null })
    const d = deps({ ledger: () => ledger, supabase: { rpc } as never })
    const summary = await runBuyerSaleDrain(d)
    expect(summary.buyers[0]).toMatchObject({ pending: 2, delivered: 0, failed: 1, changed_since_read: 1 })
    expect(summary.paged).toHaveLength(1)
    expect(summary.paged[0]).toMatch(/^tripoint has 1 ledger entry not yet copied to the sales table\./)
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
    expect(lines[0]).toMatch(/tripoint has 1 ledger entry not yet copied/)
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

  it('a ledger that cannot be read is reported unmeasured for that buyer and pages, while the other buyers still drain (L98)', async () => {
    const ok = fakeLedger([entry()])
    const d = deps({
      unreadableSince: memoryStamps({ '44444444-4444-4444-8444-444444444444': NOW - OUTBOX_BACKLOG_MS }),
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
    expect(lines.join(' ')).toMatch(/acme.*not been readable for 5 minutes/)
  })

  it('a buyer list that cannot be read is a failed run that pages, never an empty run that clears the alert (L215)', async () => {
    const d = deps({ listBuyers: async () => { throw new Error('partner_configs unreadable') } })
    const summary = await runBuyerSaleDrain(d)
    expect(summary.unmeasured).toMatch(/partner_configs unreadable/)
    expect(summary.buyers).toEqual([])
    const lines = vi.mocked(d.notify).mock.calls[0][0] as string[]
    expect(lines.join(' ')).toMatch(/partner_configs unreadable/)
  })

  // The drain runs every minute and its line carries the oldest entry's age and
  // the last error, both moving every tick, so each line names its problem for
  // the alerter: the buyer and what is wrong (#1768).
  it('names each paged line by its buyer and what is wrong, so a moving age or error is not a new problem', async () => {
    const old = entry({ reserved_at: NOW - OUTBOX_BACKLOG_MS - 1000 })
    const rpcFailing = vi.fn(async () => ({ data: null, error: { message: 'db down' } }))
    const d = deps({
      unreadableSince: memoryStamps({ '44444444-4444-4444-8444-444444444444': NOW - OUTBOX_BACKLOG_MS }),
      listBuyers: async () => [
        { partner_id: PARTNER, organization_id: ORG, slug: 'tripoint' },
        { partner_id: '44444444-4444-4444-8444-444444444444', organization_id: ORG, slug: 'acme' },
      ],
      ledger: (partnerId) => (partnerId === PARTNER ? fakeLedger([old]) : fakeLedger([], { unreadable: 'answered 500' })),
      supabase: { rpc: rpcFailing } as never,
    })
    await runBuyerSaleDrain(d)
    expect(vi.mocked(d.notify).mock.calls[0][1]).toEqual(['tripoint:backlog', 'acme:unmeasured'])

    const unlisted = deps({ listBuyers: async () => { throw new Error('partner_configs unreadable') } })
    await runBuyerSaleDrain(unlisted)
    expect(vi.mocked(unlisted.notify).mock.calls[0][1]).toEqual(['buyers-unlisted'])
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
      { partner_id: 'p-offer', sold_on: 'offer', is_enabled: false, organizations: { is_synthetic: false }, partner_configs: { organization_id: ORG, slug: 'tripoint' } },
      { partner_id: 'p-click', sold_on: 'click', is_enabled: true, organizations: { is_synthetic: false }, partner_configs: { organization_id: ORG, slug: 'liberty1' } },
    ])
    const buyers = await productionDrainDeps(supabase, {} as unknown as Env).listBuyers()
    expect(buyers).toEqual([{ partner_id: 'p-offer', organization_id: ORG, slug: 'tripoint' }])
  })

  // #2135: the partners page delivery monitor's organization is synthetic, and
  // no job that lists buyers across organizations may list one of it.
  it('never lists a buyer of a synthetic organization', async () => {
    const supabase = profilesTableDouble([
      { partner_id: 'p-real', sold_on: 'offer', organizations: { is_synthetic: false }, partner_configs: { organization_id: ORG, slug: 'tripoint' } },
      { partner_id: 'p-monitor', sold_on: 'offer', organizations: { is_synthetic: true }, partner_configs: { organization_id: 'org-monitor', slug: 'monitor-buyer' } },
    ])
    const buyers = await productionDrainDeps(supabase, {} as unknown as Env).listBuyers()
    expect(buyers.map((b) => b.partner_id)).toEqual(['p-real'])
  })
})

/**
 * The drain recorded nothing durable, so whether it wrote a row, and when, could
 * only be inferred (8 of the first 118 live rows, #1805). A tick that had work
 * now records one finished run naming the rows it delivered; a quiet tick
 * records nothing, because the job runs every minute (#1810).
 */
describe('the run record of a tick that had work (#1810)', () => {
  const recorded = (d: DrainDeps) => vi.mocked(d.recordRun).mock.calls

  it('records one ok run with each buyer\'s counts and the rows it delivered', async () => {
    const d = deps()
    await runBuyerSaleDrain(d)
    expect(recorded(d)).toHaveLength(1)
    const [startedAt, ending] = recorded(d)[0]
    expect(startedAt).toBe(NOW)
    expect(ending.outcome).toBe('ok')
    expect(ending.summary).toMatchObject({
      buyers: [{ slug: 'tripoint', pending: 1, delivered: 1, failed: 0, delivered_row_ids: [await buyerSaleRowId(PARTNER, entry())] }],
    })
  })

  it('a quiet tick, nothing pending anywhere, records nothing', async () => {
    const d = deps({ ledger: () => fakeLedger([]) })
    await runBuyerSaleDrain(d)
    expect(recorded(d)).toHaveLength(0)
  })

  it('a tick with a failed delivery records partial and names the error', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'db down' } }))
    const d = deps({ supabase: { rpc } as never })
    await runBuyerSaleDrain(d)
    const [, ending] = recorded(d)[0]
    expect(ending.outcome).toBe('partial')
    expect(ending.detail).toMatch(/lead-1.*db down/)
    expect(ending.summary).toMatchObject({ buyers: [{ pending: 1, delivered: 0, failed: 1, delivered_row_ids: [] }] })
  })

  it('a ledger that could not be read records unmeasured, never ok', async () => {
    const d = deps({ ledger: () => fakeLedger([], { unreadable: 'object gone' }) })
    await runBuyerSaleDrain(d)
    const [, ending] = recorded(d)[0]
    expect(ending.outcome).toBe('unmeasured')
    expect(ending.detail).toMatch(/object gone/)
  })

  it('a buyer list that could not be read records unmeasured', async () => {
    const d = deps({ listBuyers: async () => { throw new Error('profiles unreadable') } })
    await runBuyerSaleDrain(d)
    const [, ending] = recorded(d)[0]
    expect(ending.outcome).toBe('unmeasured')
    expect(ending.detail).toMatch(/profiles unreadable/)
  })

  it('caps the delivered ids it records and says how many there were', async () => {
    const many = Array.from({ length: 60 }, (_, i) => entry({ lead_key: `lead-${i}` }))
    const d = deps({ ledger: () => fakeLedger(many) })
    await runBuyerSaleDrain(d)
    const [, ending] = recorded(d)[0]
    const b = (ending.summary as { buyers: Array<{ delivered: number; delivered_row_ids: string[] }> }).buyers[0]
    expect(b.delivered).toBe(60)
    expect(b.delivered_row_ids).toHaveLength(50)
  })

  it('an alerter that throws cannot swallow the run record, because the record is written before the page', async () => {
    const d = deps({ notify: vi.fn(async () => { throw new Error('KV unavailable') }) })
    await expect(runBuyerSaleDrain(d)).rejects.toThrow(/KV unavailable/)
    expect(recorded(d)).toHaveLength(1)
    expect(recorded(d)[0][1].outcome).toBe('ok')
  })

  it('a buyer list failure whose page throws still records the tick as unmeasured', async () => {
    const d = deps({ listBuyers: async () => { throw new Error('profiles unreadable') }, notify: vi.fn(async () => { throw new Error('KV unavailable') }) })
    await expect(runBuyerSaleDrain(d)).rejects.toThrow(/KV unavailable/)
    expect(recorded(d)[0][1].outcome).toBe('unmeasured')
  })

  it('a run record that throws never fails the drain or skips its page', async () => {
    const d = deps({ recordRun: vi.fn(async () => { throw new Error('job_runs refused') }) })
    await expect(runBuyerSaleDrain(d)).resolves.toMatchObject({ buyers: [{ delivered: 1 }] })
    expect(d.notify).toHaveBeenCalledWith([])
  })
})

/**
 * #1895. On 2026-10-08 two runs 24 seconds apart each lost one call to the
 * tripoint ledger, which answered every lead call in the same seconds and the
 * drain's own next run in 10 ms, and the drain paged because the rule was two
 * failed runs in a row while the cron was firing twice a minute. A lost or slow
 * read is now asked once more on a fresh stub, and an unreadable ledger pages on
 * how long it has been unreadable, never on how many runs saw it.
 */
describe('a lost or slow ledger read (#1895)', () => {
  beforeEach(() => vi.mocked(sendExportFailureAlert).mockClear())

  const slow = (): DrainLedger => ({ unmirrored: async () => { throw new DeadlineError('buyer ledger unmirrored', OBJECT_CALL_DEADLINE_MS) }, markMirrored: async () => ({ marked: 0, changed: 0 }) })
  const lost = (): DrainLedger => ({ unmirrored: async () => { throw new ObjectCallLostError(new Error('Network connection lost.')) }, markMirrored: async () => ({ marked: 0, changed: 0 }) })

  /** Hands out the given ledgers in order, one per client the drain makes, and records what each was given. */
  function sequence(...ledgers: DrainLedger[]) {
    const asked: Array<{ partnerId: string; opts: LedgerOptions | undefined }> = []
    return {
      asked,
      ledger: (partnerId: string, opts?: LedgerOptions): DrainLedger => {
        asked.push({ partnerId, opts })
        const next = ledgers.shift()
        if (!next) throw new Error('the test ran out of ledgers')
        return next
      },
    }
  }

  it('(a) asks once more on a fresh client when the first read misses its deadline, and a good second read drains as usual', async () => {
    const good = fakeLedger([entry()])
    const seq = sequence(slow(), good)
    const stamps = memoryStamps()
    const d = deps({ ledger: seq.ledger, unreadableSince: stamps })
    const summary = await runBuyerSaleDrain(d)
    expect(seq.asked).toEqual([
      { partnerId: PARTNER, opts: undefined },
      { partnerId: PARTNER, opts: { unmirroredDeadlineMs: OBJECT_CALL_DEADLINE_MS } },
    ])
    expect(summary.buyers[0]).toMatchObject({ pending: 1, delivered: 1, failed: 0 })
    expect(summary.buyers[0].unmeasured).toBeUndefined()
    expect(good.marked).toHaveLength(1)
    expect(d.notify).toHaveBeenCalledWith([])
    expect(stamps.stored).toEqual({})
  })

  it('asks once more after a call lost in transit too', async () => {
    const seq = sequence(lost(), fakeLedger([]))
    const summary = await runBuyerSaleDrain(deps({ ledger: seq.ledger }))
    expect(seq.asked).toHaveLength(2)
    expect(summary.buyers[0].unmeasured).toBeUndefined()
  })

  it('never asks again after an answer, such as an error status, or an error nobody classified', async () => {
    for (const err of [new ObjectCallError('buyer ledger unmirrored', 500, 'boom'), new Error('something else')]) {
      const seq = sequence({ unmirrored: async () => { throw err }, markMirrored: async () => ({ marked: 0, changed: 0 }) })
      const summary = await runBuyerSaleDrain(deps({ ledger: seq.ledger }))
      expect(seq.asked).toHaveLength(1)
      expect(summary.buyers[0].unmeasured).toBe(err.message)
    }
  })

  it('a second ask that also fails leaves the ledger unmeasured with both errors named', async () => {
    const seq = sequence(slow(), lost())
    const summary = await runBuyerSaleDrain(deps({ ledger: seq.ledger }))
    expect(summary.buyers[0].unmeasured).toMatch(/did not answer within 5000 ms.*asked again.*Network connection lost/)
  })

  it('gives the second ask only what is left before the next tick, and makes none when too little is left', async () => {
    let t = NOW
    const lateBy = (left: number): DrainLedger => ({
      unmirrored: async () => { t = NOW + DRAIN_TICK_MS - left; throw new DeadlineError('buyer ledger unmirrored', OBJECT_CALL_DEADLINE_MS) },
      markMirrored: async () => ({ marked: 0, changed: 0 }),
    })
    const seq = sequence(lateBy(3_000), fakeLedger([]))
    await runBuyerSaleDrain(deps({ ledger: seq.ledger, now: () => t }))
    expect(seq.asked[1].opts).toEqual({ unmirroredDeadlineMs: 3_000 })

    t = NOW
    const short = sequence(lateBy(MEASURED_OBJECT_CALL_P99_MS - 1))
    const summary = await runBuyerSaleDrain(deps({ ledger: short.ledger, now: () => t }))
    expect(short.asked).toHaveLength(1)
    expect(summary.buyers[0].unmeasured).toMatch(/not asked again.*too little of this minute was left/)
  })

  it('(b) two unreadable runs in a row, 24 seconds apart, page nothing and keep the first moment', async () => {
    let t = NOW
    const stamps = memoryStamps()
    const d = deps({ ledger: () => slow(), unreadableSince: stamps, now: () => t })
    await runBuyerSaleDrain(d)
    t = NOW + 24_000
    await runBuyerSaleDrain(d)
    expect(vi.mocked(d.notify).mock.calls).toEqual([[[]], [[]]])
    expect(stamps.stored).toEqual({ [PARTNER]: NOW })
  })

  /** The production page, through the real alerter, with Slack replaced and KV held in memory. */
  function realAlerter(clock: () => number) {
    const store = new Map<string, string>()
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
    }
    const chain: unknown = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [{ organization_id: ORG }], error: null }).then(resolve)
        return () => chain
      },
    })
    const supabase = { from: () => chain } as never
    return (lines: string[], keys?: readonly string[]) => notifyBuyerSaleDrain(supabase, kv, lines, keys, clock())
  }

  it('(c) a ledger unreadable for longer than the backlog limit pages once, with the cron firing twice a minute', async () => {
    let t = NOW
    const clock = () => t
    const d = deps({ ledger: () => slow(), unreadableSince: memoryStamps(), now: clock, notify: realAlerter(clock) })
    const pagedAt: number[] = []
    for (; t <= NOW + 10 * 60_000; t += 30_000) {
      const before = vi.mocked(sendExportFailureAlert).mock.calls.length
      await runBuyerSaleDrain(d)
      if (vi.mocked(sendExportFailureAlert).mock.calls.length > before) pagedAt.push(t - NOW)
    }
    expect(pagedAt).toEqual([OUTBOX_BACKLOG_MS])
    const payload = vi.mocked(sendExportFailureAlert).mock.calls[0][3]
    expect(payload.title).toBe(BUYER_SALE_DRAIN_LEDGER_UNREADABLE_REMEDY.title)
    expect(payload.errors).toHaveLength(1)
    expect(payload.errors[0]).toMatch(/^tripoint's buyer ledger has not been readable for 5 minutes, since .+ E[DS]T, so its copy cannot be checked\. The last error was: buyer ledger unmirrored did not answer within 5000 ms/)
    // The drain already waited, so the alerter must not hold the line for one more run.
    expect(isTransientExportError(payload.errors[0])).toBe(false)
  })

  it('a minute with no run does not restart the clock: the first run past the limit pages', async () => {
    let t = NOW
    const clock = () => t
    const d = deps({ ledger: () => slow(), unreadableSince: memoryStamps(), now: clock, notify: realAlerter(clock) })
    for (const at of [0, 60_000, 4 * 60_000, OUTBOX_BACKLOG_MS + 10_000]) {
      t = NOW + at
      await runBuyerSaleDrain(d)
    }
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
  })

  it('(d) a good read clears the record, so the next unreadable stretch starts its own clock', async () => {
    let t = NOW
    let readable = false
    const stamps = memoryStamps()
    const d = deps({ ledger: () => (readable ? fakeLedger([]) : slow()), unreadableSince: stamps, now: () => t })
    await runBuyerSaleDrain(d)
    expect(stamps.stored).toEqual({ [PARTNER]: NOW })
    t = NOW + 4 * 60_000
    readable = true
    await runBuyerSaleDrain(d)
    expect(stamps.stored).toEqual({})
    t = NOW + 6 * 60_000
    readable = false
    await runBuyerSaleDrain(d)
    expect(stamps.stored).toEqual({ [PARTNER]: NOW + 6 * 60_000 })
    expect(vi.mocked(d.notify).mock.calls.every(([lines]) => lines.length === 0)).toBe(true)
  })

  it('a quiet run with nothing recorded writes nothing to the record', async () => {
    const stamps = memoryStamps()
    await runBuyerSaleDrain(deps({ ledger: () => fakeLedger([]), unreadableSince: stamps }))
    expect(stamps.writes).toBe(0)
  })

  it('forgets a buyer that is no longer listed, so a buyer listed again later starts fresh', async () => {
    const stamps = memoryStamps({ '55555555-5555-4555-8555-555555555555': NOW - 60 * 60_000 })
    await runBuyerSaleDrain(deps({ ledger: () => fakeLedger([]), unreadableSince: stamps }))
    expect(stamps.stored).toEqual({})
  })

  it('pages at once when the record of when it started cannot be read, rather than holding a page it cannot time', async () => {
    const d = deps({ ledger: () => slow(), unreadableSince: { read: async () => { throw new Error('KV read refused') }, write: async () => {} } })
    await runBuyerSaleDrain(d)
    const [lines, keys] = vi.mocked(d.notify).mock.calls[0] as unknown as [string[], string[]]
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^tripoint's buyer ledger could not be read, and how long that has lasted is unknown because the record of when it started could not be read \(KV read refused\)\. The last error was: /)
    expect(keys).toEqual(['tripoint:unmeasured'])
  })

  it('pages at once when the first moment cannot be saved, since no later run could time it', async () => {
    const d = deps({ ledger: () => slow(), unreadableSince: { read: async () => ({}), write: async () => { throw new Error('KV write refused') } } })
    await runBuyerSaleDrain(d)
    const lines = vi.mocked(d.notify).mock.calls[0][0] as string[]
    expect(lines[0]).toMatch(/could not be saved \(KV write refused\)/)
  })

  it('a record that cannot be cleared after a good read is logged, and pages nothing', async () => {
    const d = deps({ ledger: () => fakeLedger([]), unreadableSince: { read: async () => ({ [PARTNER]: NOW - 60_000 }), write: async () => { throw new Error('KV write refused') } } })
    await runBuyerSaleDrain(d)
    expect(d.notify).toHaveBeenCalledWith([])
    expect(d.lines.join(' ')).toMatch(/could not be saved.*KV write refused/)
  })

  it('a read that only succeeded on the second ask is recorded, so how often the first ask fails stays countable', async () => {
    const seq = sequence(slow(), fakeLedger([]))
    const d = deps({ ledger: seq.ledger })
    await runBuyerSaleDrain(d)
    const calls = vi.mocked(d.recordRun).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][1].outcome).toBe('ok')
    expect(calls[0][1].summary).toMatchObject({ buyers: [{ first_read_failed: expect.stringMatching(/did not answer within 5000 ms/) }] })
  })
})

describe('drainRemedyFor: one title per kind of page', () => {
  it('names a backlog, an unreadable ledger, both, and an unread buyer list apart', () => {
    expect(drainRemedyFor(['tripoint:backlog'])).toBe(BUYER_SALE_DRAIN_BACKLOG_REMEDY)
    expect(drainRemedyFor(['tripoint:unmeasured'])).toBe(BUYER_SALE_DRAIN_LEDGER_UNREADABLE_REMEDY)
    expect(drainRemedyFor(['tripoint:backlog', 'acme:unmeasured'])).toBe(BUYER_SALE_DRAIN_MIXED_REMEDY)
    expect(drainRemedyFor(['buyers-unlisted'])).toBe(BUYER_SALE_DRAIN_UNLISTED_REMEDY)
  })

  // #835: each page says only what its lines measured.
  it('never tells a reader selling is unaffected when a ledger, which every sale reserves through, cannot be read', () => {
    for (const r of [BUYER_SALE_DRAIN_LEDGER_UNREADABLE_REMEDY, BUYER_SALE_DRAIN_MIXED_REMEDY]) {
      expect(r.context ?? '').not.toMatch(/^Selling is not affected/)
      expect(r.context ?? '').toMatch(/reserves/)
    }
    expect(BUYER_SALE_DRAIN_BACKLOG_REMEDY.context).toMatch(/Selling is not affected/)
  })

  it('points a ledger it cannot read at that buyer, never at the drill, which exercises a throwaway buyer', () => {
    for (const r of [BUYER_SALE_DRAIN_LEDGER_UNREADABLE_REMEDY, BUYER_SALE_DRAIN_MIXED_REMEDY, BUYER_SALE_DRAIN_UNMARKED_REMEDY]) {
      expect(r.fixHint).not.toMatch(/drill/)
      expect(r.fixHint).toMatch(/partner page/)
    }
  })

  it('a row written whose ledger mark failed is its own page, never "not reaching the sales table"', async () => {
    const old = entry({ reserved_at: NOW - OUTBOX_BACKLOG_MS - 1000 })
    const ledger = { ...fakeLedger([old]), markMirrored: async () => { throw new Error('buyer ledger mark answered 500') } }
    const d = deps({ ledger: () => ledger })
    const summary = await runBuyerSaleDrain(d)
    // Counted exactly as before: the entry is still uncopied in the ledger's eyes.
    expect(summary.buyers[0]).toMatchObject({ pending: 1, delivered: 0, failed: 1 })
    const [lines, keys] = vi.mocked(d.notify).mock.calls[0] as [string[], string[]]
    expect(lines[0]).toMatch(/tripoint has 1 ledger entry in the sales table that the ledger could not mark as copied/)
    expect(lines[0]).not.toMatch(/not yet copied to the sales table/)
    expect(keys).toEqual(['tripoint:unmarked'])
    expect(drainRemedyFor(keys)).toBe(BUYER_SALE_DRAIN_UNMARKED_REMEDY)
    expect(BUYER_SALE_DRAIN_UNMARKED_REMEDY.title).not.toMatch(/not reaching the sales table/)
  })

  it('a buyer with both unwritten and unmarked entries names each count', async () => {
    const a = entry({ lead_key: 'lead-a', reserved_at: NOW - OUTBOX_BACKLOG_MS - 2000 })
    const b = entry({ lead_key: 'lead-b', reserved_at: NOW - OUTBOX_BACKLOG_MS - 1000 })
    const rpc = vi.fn(async (_fn: string, args: { p_row: { id: string; status: string; lead_key: string } }) =>
      args.p_row.lead_key === 'lead-a' ? { data: null, error: { message: 'db down' } } : { data: { id: args.p_row.id, status: args.p_row.status }, error: null })
    const ledger = { ...fakeLedger([a, b]), markMirrored: async () => { throw new Error('mark failed') } }
    const d = deps({ ledger: () => ledger, supabase: { rpc } as never })
    await runBuyerSaleDrain(d)
    const [lines, keys] = vi.mocked(d.notify).mock.calls[0] as [string[], string[]]
    expect(lines[0]).toMatch(/tripoint has 1 ledger entry not yet copied to the sales table/)
    expect(lines[0]).toMatch(/1 more is in the sales table but the ledger could not mark it as copied/)
    expect(keys).toEqual(['tripoint:backlog'])
  })

  it('an unmarked page beside another kind gets a title true of both', () => {
    expect(drainRemedyFor(['tripoint:unmarked', 'acme:backlog'])).toBe(BUYER_SALE_DRAIN_SEVERAL_REMEDY)
    expect(drainRemedyFor(['tripoint:unmarked', 'acme:unmeasured'])).toBe(BUYER_SALE_DRAIN_SEVERAL_REMEDY)
  })
})

describe('the production wiring of the second ask and the unreadable record (#1895)', () => {
  it('gives only the outbox read the shortened deadline; every other call keeps the default', () => {
    const opts = ledgerClientOptions({ unmirroredDeadlineMs: 2_500 })
    const deadline = opts.deadlineMs as (op: string) => number
    expect(deadline('buyer ledger unmirrored')).toBe(2_500)
    expect(deadline('buyer ledger mark-mirrored')).toBe(OBJECT_CALL_DEADLINE_MS)
    expect(ledgerClientOptions(undefined)).toEqual({})
  })

  function kvDouble(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial))
    const puts: Array<{ key: string; ttl: number | undefined }> = []
    return {
      store,
      puts,
      kv: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string, o?: { expirationTtl?: number }) => { puts.push({ key: k, ttl: o?.expirationTtl }); store.set(k, v) },
        delete: async (k: string) => { store.delete(k) },
      } as unknown as KVNamespace,
    }
  }

  it('round trips the record through KV, with a day long expiry, and deletes it when empty', async () => {
    const { kv, store, puts } = kvDouble()
    const s = kvUnreadableSince(kv)
    expect(await s.read()).toEqual({})
    await s.write({ [PARTNER]: NOW })
    expect(await s.read()).toEqual({ [PARTNER]: NOW })
    expect(puts).toEqual([{ key: UNREADABLE_SINCE_KEY, ttl: 24 * 60 * 60 }])
    await s.write({})
    expect(store.has(UNREADABLE_SINCE_KEY)).toBe(false)
  })

  it.each([['not json'], ['[1,2]'], ['null'], [`{"${PARTNER}":"yesterday"}`]])('a damaged record %s throws rather than reading as no ledger unreadable', async (raw) => {
    const { kv } = kvDouble({ [UNREADABLE_SINCE_KEY]: raw })
    await expect(kvUnreadableSince(kv).read()).rejects.toThrow()
  })
})
