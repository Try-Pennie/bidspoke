/**
 * The 15 minute buyer sales checks (#1413): each named for what it proves.
 *
 * Completeness: the ledger's day against the buyer_sales copy, unmeasured while
 * the outbox is not empty (L324). Consistency: accepted live entries against the
 * bid logger's winner rows, per Eastern hour, named consistency because the node
 * wrote both (L58); hours at or beyond the bid purge horizon are unmeasured with
 * the reason (L592). Independent: accepted entries against the Salesforce write
 * back another node made; a buyer with no such record is unmeasured, never
 * clean. Unresolved: one page per buyer counting every entry, repeated when the
 * count grows (L707, L641). A mismatch pages only when it persists across two
 * runs; the job records its own outcome so a lifetime of zero passes reads as
 * broken (L557).
 */
import { describe, expect, it, vi } from 'vitest'
import type { LedgerEntry } from '../../durable-objects/buyer-ledger'
import { PURGE_GRACE_HOURS } from '../sightings-export'
import {
  BID_PURGE_HORIZON_MS,
  BUYER_SALES_CHECKS_JOB,
  BUYER_SALES_MISMATCH_JOB,
  BUYER_SALES_UNRESOLVED_JOB,
  endingOf,
  runBuyerSalesChecks,
  type ChecksDeps,
  type CheckBuyer,
} from '../buyer-sales-checks'

// 2027-09-20 15:40 UTC is 11:40 in New York: the ET day is 2027-09-20.
const NOW = Date.UTC(2027, 8, 20, 15, 40)
const HOUR = 3_600_000
const PARTNER = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const TRIPOINT: CheckBuyer = {
  partner_id: PARTNER, organization_id: ORG, slug: 'tripoint',
  caps: { hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: 100_000 },
  has_independent_record: true,
}

function accepted(leadKey: string, reservedAt: number, reference = `TP-${leadKey}`): LedgerEntry {
  return {
    lead_key: leadKey, population: 'engine', kind: 'live', payout_cents: 2190, status: 'accepted',
    et_day: '2027-09-20', hour_bucket: Math.floor(reservedAt / HOUR), reserved_at: reservedAt, resolved_at: reservedAt + 2000,
    mirrored: true, execution_id: `exec-${leadKey}`,
    outcome: { buyer_reference: reference, result_code: '1000', http_status: 200, payout_cents: 2190 },
    resolution_source: 'buyer', resolved_by: null,
  }
}

function unresolved(leadKey: string, reservedAt: number): LedgerEntry {
  return { ...accepted(leadKey, reservedAt), status: 'unresolved', resolved_at: null, outcome: null, resolution_source: null, mirrored: true }
}

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}

interface Fixture {
  entries?: Record<string, LedgerEntry[]>
  unmirroredOldestMs?: number | null
  sales?: Array<{ lead_key: string; status: string; kind: string }>
  winners?: Array<{ execution_id: string; attempted_at_utc: string }>
  salesforce?: Set<string> | null
  buyers?: CheckBuyer[]
}

function deps(f: Fixture = {}, over: Partial<Omit<ChecksDeps, 'kv'>> = {}): Omit<ChecksDeps, 'kv'> & { kv: ReturnType<typeof fakeKv> } {
  const kv = fakeKv()
  const notifyMismatch = vi.fn(async (_lines: string[]) => {})
  const notifyUnresolved = vi.fn(async (_lines: string[]) => {})
  const entries = f.entries ?? { '2027-09-20': [accepted('lead-1', NOW - 10 * 60_000)], '2027-09-19': [] }
  const unresolvedEntries = Object.values(entries).flat().filter((e) => e.status === 'unresolved')
  return {
    kv,
    notifyMismatch,
    notifyUnresolved,
    listBuyers: async () => f.buyers ?? [TRIPOINT],
    ledger: () => ({
      entries: async (kind, day) => (kind === 'live' ? entries[day] ?? [] : []),
      unmirrored: async () => ({ entries: [], oldest_age_ms: f.unmirroredOldestMs ?? null }),
      unresolved: async () => unresolvedEntries,
    }),
    // The copy is read per day; the fixture's rows belong to today and yesterday holds nothing.
    readSalesRows: async (_partnerId, day) => (day === '2027-09-20' ? f.sales ?? [{ lead_key: 'lead-1', status: 'accepted', kind: 'live' }] : []),
    readWinnerRows: async () => f.winners ?? [{ execution_id: 'exec-lead-1', attempted_at_utc: new Date(NOW - 10 * 60_000).toISOString() }],
    readIndependentRecord: async () => (f.salesforce === undefined ? new Set(['TP-lead-1']) : f.salesforce),
    now: () => NOW,
    localDev: false,
    appUrl: 'https://app.example',
    log: () => {},
    ...over,
  }
}

describe('runBuyerSalesChecks', () => {
  it('a buyer whose copy, winner rows and write back all agree passes every check, pages nothing, and the run counts as a pass', async () => {
    const d = deps()
    const summary = await runBuyerSalesChecks(d)
    const b = summary.buyers[0]
    expect(b.completeness.verdict).toBe('complete')
    expect(b.consistency.verdict).toBe('consistent')
    expect(b.independent.verdict).toBe('verified')
    expect(d.notifyMismatch).toHaveBeenCalledWith([])
    expect(d.notifyUnresolved).toHaveBeenCalledWith([])
    expect(endingOf(summary).outcome).toBe('ok')
  })

  it('while the outbox is not empty the completeness check is unmeasured with the oldest age, never a mismatch (L324)', async () => {
    const d = deps({ unmirroredOldestMs: 6 * 60_000, sales: [] })
    const summary = await runBuyerSalesChecks(d)
    expect(summary.buyers[0].completeness).toMatchObject({ verdict: 'unmeasured', reason: expect.stringMatching(/outbox.*6 minutes/) })
    expect(d.notifyMismatch).toHaveBeenCalledWith([])
    expect(endingOf(summary).outcome).toBe('unmeasured')
  })

  it('a copy that disagrees with the ledger is a mismatch that pages only once it persists across two runs, one line per buyer', async () => {
    const d = deps({ sales: [] })
    const first = await runBuyerSalesChecks(d)
    expect(first.buyers[0].completeness.verdict).toBe('mismatch')
    expect(d.notifyMismatch).toHaveBeenLastCalledWith([])
    const second = await runBuyerSalesChecks(d)
    expect(second.buyers[0].completeness.verdict).toBe('mismatch')
    const lines = vi.mocked(d.notifyMismatch).mock.calls[1][0] as string[]
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^tripoint: /)
    expect(lines[0]).toMatch(/ledger.*1 accepted.*buyer_sales.*0/)
    expect(endingOf(second).outcome).toBe('findings')
  })

  it('a mismatch that clears on the second run pages nothing and forgets the first', async () => {
    const d = deps({ sales: [] })
    await runBuyerSalesChecks(d)
    d.readSalesRows = async (_p, day) => (day === '2027-09-20' ? [{ lead_key: 'lead-1', status: 'accepted', kind: 'live' }] : [])
    const second = await runBuyerSalesChecks(d)
    expect(second.buyers[0].completeness.verdict).toBe('complete')
    expect(d.notifyMismatch).toHaveBeenLastCalledWith([])
    await runBuyerSalesChecks(d)
    d.readSalesRows = async () => []
    const fourth = await runBuyerSalesChecks(d)
    expect(fourth.buyers[0].completeness.verdict).toBe('mismatch')
    expect(d.notifyMismatch).toHaveBeenLastCalledWith([])
  })

  it('an accepted ledger entry with no winner row fails the CONSISTENCY check, which is named as such and not as independent (L58)', async () => {
    const d = deps({ winners: [] })
    const summary = await runBuyerSalesChecks(d)
    expect(summary.buyers[0].consistency).toMatchObject({ verdict: 'inconsistent' })
    expect(summary.buyers[0].consistency).toMatchObject({ detail: expect.stringMatching(/1 accepted in the ledger.*0 winner rows/) })
    expect(summary.buyers[0].independent.verdict).toBe('verified')
    await runBuyerSalesChecks(d)
    const lines = vi.mocked(d.notifyMismatch).mock.calls[1][0] as string[]
    expect(lines[0]).toMatch(/consistency/i)
    expect(lines[0]).not.toMatch(/independent/i)
  })

  it('an hour at or beyond the bid purge horizon is unmeasured with beyond_bid_purge_horizon, not a mismatch (L592)', async () => {
    const old = accepted('lead-old', NOW - 26 * HOUR)
    old.et_day = '2027-09-19'
    const d = deps({ entries: { '2027-09-20': [], '2027-09-19': [old] }, winners: [], sales: [{ lead_key: 'lead-old', status: 'accepted', kind: 'live' }] })
    const summary = await runBuyerSalesChecks(d)
    expect(summary.buyers[0].consistency).toMatchObject({ verdict: 'unmeasured', reason: 'beyond_bid_purge_horizon', unmeasured_hours: 1 })
    expect(d.notifyMismatch).toHaveBeenCalledWith([])
  })

  it('an accepted entry whose reference Salesforce never received fails the independent check; a buyer with no write back is unmeasured, never clean', async () => {
    const d = deps({ salesforce: new Set() })
    const summary = await runBuyerSalesChecks(d)
    expect(summary.buyers[0].independent).toMatchObject({ verdict: 'unverified', detail: expect.stringMatching(/TP-lead-1/) })
    const noRecord = deps({ buyers: [{ ...TRIPOINT, slug: 'acme', has_independent_record: false }], salesforce: null })
    const s2 = await runBuyerSalesChecks(noRecord)
    expect(s2.buyers[0].independent).toMatchObject({ verdict: 'unmeasured', reason: 'no_independent_record' })
  })

  it('unresolved entries page once per buyer, counting all of them with the oldest age and what they hold against the caps, and again only when the count grows', async () => {
    const two = [unresolved('lead-u1', NOW - 40 * 60_000), unresolved('lead-u2', NOW - 30 * 60_000)]
    const d = deps({ entries: { '2027-09-20': two, '2027-09-19': [] }, sales: two.map((e) => ({ lead_key: e.lead_key, status: 'unresolved', kind: 'live' })), winners: [] })
    await runBuyerSalesChecks(d)
    const lines = vi.mocked(d.notifyUnresolved).mock.calls[0][0] as string[]
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/tripoint: 2 unresolved sales/)
    expect(lines[0]).toMatch(/oldest 40 minutes/)
    expect(lines[0]).toMatch(/2 of the 500 lead slots/)
    expect(lines[0]).toMatch(/\$43\.80 of the \$1,000\.00/)
    expect(lines[0]).toMatch(/partners\?selected=tripoint/)
    expect(lines[0]).not.toMatch(/lead-u1|lead-u2/)
    // Same count again: nothing new to say.
    await runBuyerSalesChecks(d)
    expect(d.notifyUnresolved).toHaveBeenLastCalledWith([])
    // A third entry: the count grew, so it pages again and the standing condition is reset first.
    const three = [...two, unresolved('lead-u3', NOW - 5 * 60_000)]
    d.ledger = () => ({
      entries: async () => three,
      unmirrored: async () => ({ entries: [], oldest_age_ms: null }),
      unresolved: async () => three,
    })
    d.kv.store.set(`export-alert:${BUYER_SALES_UNRESOLVED_JOB}:condition`, JSON.stringify({ since: '2027-09-20T15:00:00.000Z', alerts: 1 }))
    d.kv.store.set(`export-alert:${BUYER_SALES_UNRESOLVED_JOB}:cooldown`, '1')
    await runBuyerSalesChecks(d)
    const again = vi.mocked(d.notifyUnresolved).mock.calls[2][0] as string[]
    expect(again[0]).toMatch(/3 unresolved sales/)
    expect(d.kv.store.has(`export-alert:${BUYER_SALES_UNRESOLVED_JOB}:cooldown`)).toBe(false)
  })

  it('a manual mute (a cooldown with no standing condition) is left alone even when the count grows', async () => {
    const two = [unresolved('lead-u1', NOW - 40 * 60_000), unresolved('lead-u2', NOW - 30 * 60_000)]
    const d = deps({ entries: { '2027-09-20': two, '2027-09-19': [] }, sales: two.map((e) => ({ lead_key: e.lead_key, status: 'unresolved', kind: 'live' })), winners: [] })
    d.kv.store.set(`unresolved-paged:${PARTNER}`, '1')
    d.kv.store.set(`export-alert:${BUYER_SALES_UNRESOLVED_JOB}:cooldown`, 'muted')
    await runBuyerSalesChecks(d)
    expect(d.kv.store.get(`export-alert:${BUYER_SALES_UNRESOLVED_JOB}:cooldown`)).toBe('muted')
  })

  it("the monitor's own read failure is unmeasured for that buyer, never clean, and the run does not count as a pass (L98)", async () => {
    const d = deps({}, {
      ledger: () => ({
        entries: async () => { throw new Error('buyer ledger entries answered 500: boom') },
        unmirrored: async () => ({ entries: [], oldest_age_ms: null }),
        unresolved: async () => [],
      }),
    })
    const summary = await runBuyerSalesChecks(d)
    expect(summary.buyers[0].completeness).toMatchObject({ verdict: 'unmeasured', reason: expect.stringMatching(/answered 500/) })
    expect(summary.buyers[0].consistency.verdict).toBe('unmeasured')
    expect(summary.buyers[0].independent.verdict).toBe('unmeasured')
    expect(endingOf(summary).outcome).toBe('unmeasured')
    expect(d.notifyMismatch).toHaveBeenCalledWith([])
  })

  it('a buyer list that cannot be read is a failed run, not an empty one', async () => {
    const d = deps({}, { listBuyers: async () => { throw new Error('buyer_profiles unreadable') } })
    const summary = await runBuyerSalesChecks(d)
    expect(summary.unmeasured).toMatch(/buyer_profiles unreadable/)
    expect(endingOf(summary).outcome).toBe('unmeasured')
    expect(d.notifyMismatch).not.toHaveBeenCalledWith([])
  })

  it('does nothing in local dev and says so', async () => {
    const d = deps({}, { localDev: true })
    const summary = await runBuyerSalesChecks(d)
    expect(summary.skipped).toBe('local_dev')
    expect(d.notifyMismatch).not.toHaveBeenCalled()
  })

  it('names its jobs and derives the purge horizon from the export purge, never a copied literal', () => {
    expect(BUYER_SALES_CHECKS_JOB).toBe('buyer-sales-checks')
    expect(BUYER_SALES_MISMATCH_JOB).toBe('buyer-sales-mismatch')
    expect(BUYER_SALES_UNRESOLVED_JOB).toBe('buyer-sales-unresolved')
    expect(BID_PURGE_HORIZON_MS).toBe(PURGE_GRACE_HOURS * HOUR)
  })
})
