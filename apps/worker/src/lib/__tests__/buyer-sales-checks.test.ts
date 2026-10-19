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
import { PAGE_SIZE } from '../paginate'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import { profilesTableDouble } from './_profiles-table-double'
import {
  BID_PURGE_HORIZON_MS,
  BUYER_OUTCOME_RATE_JOB,
  BUYER_OUTCOME_RATE_REMEDY,
  BUYER_SALES_CHECKS_JOB,
  BUYER_SALES_MISMATCH_JOB,
  BUYER_SALES_UNLISTED_REMEDY,
  BUYER_SALES_UNRESOLVED_JOB,
  BUYER_SALES_UNRESOLVED_REMEDY,
  OUTCOME_BASELINE_DAYS,
  OUTCOME_BASELINE_MIN_ATTEMPTS,
  OUTCOME_RATE_MIN_ATTEMPTS,
  OUTCOME_SATURATION_MIN_ATTEMPTS,
  endingOf,
  independentRecordSoql,
  judgeOutcomeRate,
  productionChecksDeps,
  runBuyerSalesChecks,
  type ChecksDeps,
  type CheckBuyer,
  type OutcomeBaseline,
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

/** A buyer answer that was not a sale: declined is the buyer saying no, released is a call that failed before the lead was processed. */
function noSale(leadKey: string, reservedAt: number, status: 'declined' | 'released'): LedgerEntry {
  return { ...accepted(leadKey, reservedAt), status, outcome: null, payout_cents: 0 }
}

/** n entries of one status inside the last hour, one per minute. */
function hourOf(status: 'accepted' | 'declined' | 'released', n: number, prefix = status): LedgerEntry[] {
  return Array.from({ length: n }, (_, i) =>
    status === 'accepted' ? accepted(`${prefix}-${i}`, NOW - (i + 1) * 60_000) : noSale(`${prefix}-${i}`, NOW - (i + 1) * 60_000, status),
  )
}

/** Fourteen ordinary days: a few buyer errors, a third declined. */
const HEALTHY_BASELINE: OutcomeBaseline = { attempts: 600, failed: 6, declined: 200 }

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
  baseline?: OutcomeBaseline
}

function deps(f: Fixture = {}, over: Partial<Omit<ChecksDeps, 'kv'>> = {}): Omit<ChecksDeps, 'kv'> & { kv: ReturnType<typeof fakeKv> } {
  const kv = fakeKv()
  const notifyMismatch = vi.fn(async (_lines: string[], _remedy: unknown) => {})
  const notifyUnresolved = vi.fn(async (_lines: string[]) => {})
  const notifyOutcomeRate = vi.fn(async (_lines: string[]) => {})
  const entries = f.entries ?? { '2027-09-20': [accepted('lead-1', NOW - 10 * 60_000)], '2027-09-19': [] }
  const unresolvedEntries = Object.values(entries).flat().filter((e) => e.status === 'unresolved')
  return {
    kv,
    notifyMismatch,
    notifyUnresolved,
    notifyOutcomeRate,
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
    readOutcomeBaseline: async () => f.baseline ?? HEALTHY_BASELINE,
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
    expect(d.notifyMismatch).toHaveBeenCalledWith([], expect.anything())
    expect(d.notifyUnresolved).toHaveBeenCalledWith([])
    expect(endingOf(summary).outcome).toBe('ok')
  })

  it('while the outbox is not empty the completeness check is unmeasured with the oldest age, never a mismatch (L324)', async () => {
    const d = deps({ unmirroredOldestMs: 6 * 60_000, sales: [] })
    const summary = await runBuyerSalesChecks(d)
    expect(summary.buyers[0].completeness).toMatchObject({ verdict: 'unmeasured', reason: expect.stringMatching(/outbox.*6 minutes/) })
    expect(d.notifyMismatch).toHaveBeenCalledWith([], expect.anything())
    expect(endingOf(summary).outcome).toBe('unmeasured')
  })

  it('a copy that disagrees with the ledger is a mismatch that pages only once it persists across two runs, one line per buyer', async () => {
    const d = deps({ sales: [] })
    const first = await runBuyerSalesChecks(d)
    expect(first.buyers[0].completeness.verdict).toBe('mismatch')
    expect(d.notifyMismatch).toHaveBeenLastCalledWith([], expect.anything())
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
    expect(d.notifyMismatch).toHaveBeenLastCalledWith([], expect.anything())
    await runBuyerSalesChecks(d)
    d.readSalesRows = async () => []
    const fourth = await runBuyerSalesChecks(d)
    expect(fourth.buyers[0].completeness.verdict).toBe('mismatch')
    expect(d.notifyMismatch).toHaveBeenLastCalledWith([], expect.anything())
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
    expect(d.notifyMismatch).toHaveBeenCalledWith([], expect.anything())
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

  it('rehearsal reservations the ledger alarm released are counted per buyer for the days read, and never page anybody (#1515)', async () => {
    const expired = (leadKey: string, reservedAt: number): LedgerEntry => ({
      ...accepted(leadKey, reservedAt), kind: 'rehearsal', status: 'released', outcome: null, payout_cents: 0,
      resolved_at: reservedAt + 60_000, resolution_source: 'expired',
    })
    const rehearsals: Record<string, LedgerEntry[]> = {
      '2027-09-20': [expired('r-1', NOW - 50 * 60_000), expired('r-2', NOW - 20 * 60_000), { ...accepted('r-3', NOW - 9 * 60_000), kind: 'rehearsal', resolution_source: 'rehearsal' }],
      '2027-09-19': [expired('r-0', NOW - 20 * HOUR)],
    }
    const live = { '2027-09-20': [accepted('lead-1', NOW - 10 * 60_000)], '2027-09-19': [] as LedgerEntry[] }
    const d = deps({}, {
      ledger: () => ({
        entries: async (kind, day) => (kind === 'live' ? live[day as keyof typeof live] ?? [] : rehearsals[day] ?? []),
        unmirrored: async () => ({ entries: [], oldest_age_ms: null }),
        unresolved: async () => [],
      }),
    })
    const summary = await runBuyerSalesChecks(d)
    expect(summary.buyers[0].rehearsals_expired).toBe(3)
    expect(d.notifyUnresolved).toHaveBeenCalledWith([])
    const ending = endingOf(summary)
    expect(ending.outcome).toBe('ok')
    // The count reaches the job record, or it is lost the moment the run ends.
    expect((ending.summary as { buyers: Array<{ rehearsals_expired: number }> }).buyers[0].rehearsals_expired).toBe(3)
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
    expect(d.notifyMismatch).toHaveBeenCalledWith([], expect.anything())
  })

  it('a buyer list that cannot be read is a failed run, not an empty one', async () => {
    const d = deps({}, { listBuyers: async () => { throw new Error('buyer_profiles unreadable') } })
    const summary = await runBuyerSalesChecks(d)
    expect(summary.unmeasured).toMatch(/buyer_profiles unreadable/)
    expect(endingOf(summary).outcome).toBe('unmeasured')
    expect(d.notifyMismatch).not.toHaveBeenCalledWith([], expect.anything())
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
    expect(BUYER_OUTCOME_RATE_JOB).toBe('buyer-outcome-rate')
    expect(BID_PURGE_HORIZON_MS).toBe(PURGE_GRACE_HOURS * HOUR)
  })
})

/**
 * The outcome rate (L77, L139): a decline and a buyer error are each an expected
 * answer, so every run carrying one succeeds and nothing else notices when a
 * buyer starts answering that way to everything. Per buyer over the last hour,
 * against the prior 14 days, with a saturation rule so a small hour in which
 * every attempt failed is not discarded by the rate's volume floor.
 */
describe('judgeOutcomeRate', () => {
  it('an hour in which every attempt failed is elevated even below the rate floor (saturation, L139)', () => {
    const entries = hourOf('released', OUTCOME_SATURATION_MIN_ATTEMPTS)
    const v = judgeOutcomeRate(entries, HEALTHY_BASELINE, NOW, false)
    expect(v).toMatchObject({ verdict: 'elevated' })
    expect(v).toMatchObject({ detail: expect.stringMatching(new RegExp(`all ${OUTCOME_SATURATION_MIN_ATTEMPTS} attempts in the last hour failed`)) })
  })

  it('unclassified answers count as failures: a buyer timing out on everything saturates too', () => {
    const entries = Array.from({ length: OUTCOME_SATURATION_MIN_ATTEMPTS }, (_, i) => unresolved(`u-${i}`, NOW - (i + 1) * 60_000))
    expect(judgeOutcomeRate(entries, HEALTHY_BASELINE, NOW, false).verdict).toBe('elevated')
  })

  it('a buyer error share far above the 14 day share is elevated and names both shares', () => {
    const entries = [...hourOf('released', 4), ...hourOf('accepted', 6)]
    const v = judgeOutcomeRate(entries, HEALTHY_BASELINE, NOW, false)
    expect(v).toMatchObject({ verdict: 'elevated' })
    expect(v).toMatchObject({ detail: expect.stringMatching(/4 of 10 attempts.*failed.*40%.*1% over the prior 14 days/) })
  })

  it('a decline share far above the 14 day share is elevated; the same share the buyer always had is normal', () => {
    const high = [...hourOf('declined', 9), ...hourOf('accepted', 1)]
    const v = judgeOutcomeRate(high, HEALTHY_BASELINE, NOW, false)
    expect(v).toMatchObject({ verdict: 'elevated', detail: expect.stringMatching(/9 of 10 attempts.*declined.*90%.*33% over the prior 14 days/) })
    const usual = [...hourOf('declined', 4), ...hourOf('accepted', 6)]
    expect(judgeOutcomeRate(usual, HEALTHY_BASELINE, NOW, false).verdict).toBe('normal')
  })

  it('a buyer that usually declines 42% and now declines 70% is elevated (#2392): a share that high can never double', () => {
    // The rule used to need the share to more than double AND rise 25 points.
    // Below a 25% baseline the 25 points already more than doubles it, so the
    // double clause only ever bit above 25%, where it made a big decliner
    // unpageable: Tripoint declines about 42% of what it is sent, and on
    // 2026-10-14 its declines rose to about 67% without any rule able to say so.
    const tripointLike: OutcomeBaseline = { attempts: 1000, failed: 1, declined: 420 }
    const entries = [...hourOf('declined', 7), ...hourOf('accepted', 3)]
    expect(judgeOutcomeRate(entries, tripointLike, NOW, false)).toMatchObject({ verdict: 'elevated', detail: expect.stringMatching(/7 of 10 attempts.*declined.*70%.*42% over the prior 14 days/) })
    const usual = [...hourOf('declined', 6), ...hourOf('accepted', 4)]
    expect(judgeOutcomeRate(usual, tripointLike, NOW, false).verdict).toBe('normal')
  })

  it('a quiet hour in which every attempt failed, fewer than saturation needs, says so rather than claiming not every one failed', () => {
    const v = judgeOutcomeRate(hourOf('released', OUTCOME_SATURATION_MIN_ATTEMPTS - 1), HEALTHY_BASELINE, NOW, false)
    expect(v.verdict).toBe('quiet')
    expect(v).not.toMatchObject({ detail: expect.stringMatching(/not every one failed/) })
    expect(v).toMatchObject({ detail: expect.stringMatching(new RegExp(`every one failed, fewer than the ${OUTCOME_SATURATION_MIN_ATTEMPTS}`)) })
  })

  it('a rise that doubles a tiny share but moves it by a few points is not elevated: the rise must be 25 points', () => {
    // 2 of 20 is double the 1% baseline but 9 points above it, which one bad
    // lead and one flaky call produce on an ordinary day.
    const entries = [...hourOf('released', 2), ...hourOf('accepted', 18)]
    expect(judgeOutcomeRate(entries, HEALTHY_BASELINE, NOW, false).verdict).toBe('normal')
  })

  it('too few attempts for a rate, and none of the saturation shape, is quiet: a third state, not normal (L11)', () => {
    const entries = [...hourOf('released', 1), ...hourOf('accepted', 2)]
    const v = judgeOutcomeRate(entries, HEALTHY_BASELINE, NOW, false)
    expect(v).toMatchObject({ verdict: 'quiet', detail: expect.stringMatching(new RegExp(`3 attempts in the last hour, fewer than the ${OUTCOME_RATE_MIN_ATTEMPTS}`)) })
  })

  it('a thin baseline leaves the rate unmeasured, while saturation is still judged', () => {
    const thin: OutcomeBaseline = { attempts: OUTCOME_BASELINE_MIN_ATTEMPTS - 1, failed: 0, declined: 0 }
    const busy = [...hourOf('released', 4), ...hourOf('accepted', 6)]
    expect(judgeOutcomeRate(busy, thin, NOW, false)).toMatchObject({ verdict: 'unmeasured', reason: expect.stringMatching(/baseline.*fewer than/) })
    expect(judgeOutcomeRate(hourOf('released', 5), thin, NOW, false).verdict).toBe('elevated')
  })

  it('an unreadable baseline is unmeasured with the reason, never normal', () => {
    const busy = [...hourOf('released', 4), ...hourOf('accepted', 6)]
    expect(judgeOutcomeRate(busy, null, NOW, false)).toMatchObject({ verdict: 'unmeasured', reason: expect.stringMatching(/could not be read/) })
  })

  it('reads only live attempts inside the last hour: older entries and still reserved ones do not count', () => {
    const old = hourOf('released', 5).map((e) => ({ ...e, reserved_at: NOW - 3 * HOUR }))
    const reserved = { ...accepted('r-1', NOW - 60_000), status: 'reserved' as const, outcome: null, resolved_at: null }
    expect(judgeOutcomeRate([...old, reserved], HEALTHY_BASELINE, NOW, false)).toMatchObject({ verdict: 'quiet' })
  })
})

describe('the outcome rate page', () => {
  const day = (entries: LedgerEntry[]) => ({ '2027-09-20': entries, '2027-09-19': [] })

  it('an hour of all buyer errors pages once per buyer, naming it, and the same shape across two buyers gives two lines', async () => {
    const failing = hourOf('released', 6)
    const sales = failing.map((e) => ({ lead_key: e.lead_key, status: 'released', kind: 'live' }))
    const one = deps({ entries: day(failing), sales, winners: [] })
    const s1 = await runBuyerSalesChecks(one)
    expect(s1.buyers[0].outcome_rate.verdict).toBe('elevated')
    const lines = vi.mocked(one.notifyOutcomeRate).mock.calls[0][0] as string[]
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^tripoint: all 6 attempts in the last hour failed/)
    expect(lines[0]).toMatch(/partners\?selected=tripoint/)
    expect(endingOf(s1).outcome).toBe('findings')

    const acme: CheckBuyer = { ...TRIPOINT, partner_id: '33333333-3333-4333-8333-333333333333', slug: 'acme', has_independent_record: false }
    const two = deps({ entries: day(failing), sales, winners: [], buyers: [TRIPOINT, acme], salesforce: null })
    await runBuyerSalesChecks(two)
    const both = vi.mocked(two.notifyOutcomeRate).mock.calls[0][0] as string[]
    expect(both.map((l) => l.split(':')[0])).toEqual(['tripoint', 'acme'])
  })

  it('a healthy hour clears the page, and a buyer that starts failing while another is already paged gets out past the backoff', async () => {
    const acme: CheckBuyer = { ...TRIPOINT, partner_id: '33333333-3333-4333-8333-333333333333', slug: 'acme', has_independent_record: false }
    const d = deps({ entries: day([accepted('ok-1', NOW - 60_000)]), sales: [{ lead_key: 'ok-1', status: 'accepted', kind: 'live' }], winners: [{ execution_id: 'exec-ok-1', attempted_at_utc: new Date(NOW - 60_000).toISOString() }], buyers: [TRIPOINT, acme], salesforce: null })
    await runBuyerSalesChecks(d)
    expect(d.notifyOutcomeRate).toHaveBeenLastCalledWith([])

    // Tripoint fails; the alerter records its condition and cooldown.
    const failing = hourOf('released', 6)
    d.ledger = (partnerId) => ({
      entries: async () => (partnerId === PARTNER ? failing : [accepted('ok-1', NOW - 60_000)]),
      unmirrored: async () => ({ entries: [], oldest_age_ms: null }),
      unresolved: async () => [],
    })
    d.readSalesRows = async () => []
    await runBuyerSalesChecks(d)
    expect((vi.mocked(d.notifyOutcomeRate).mock.calls[1][0] as string[]).map((l) => l.split(':')[0])).toEqual(['tripoint'])
    d.kv.store.set(`export-alert:${BUYER_OUTCOME_RATE_JOB}:condition`, JSON.stringify({ since: '2027-09-20T15:00:00.000Z', alerts: 1 }))
    d.kv.store.set(`export-alert:${BUYER_OUTCOME_RATE_JOB}:cooldown`, '1')

    // Acme starts failing too: a new buyer's first page must not wait out Tripoint's reminder backoff (L707).
    d.ledger = () => ({
      entries: async () => failing,
      unmirrored: async () => ({ entries: [], oldest_age_ms: null }),
      unresolved: async () => [],
    })
    await runBuyerSalesChecks(d)
    expect((vi.mocked(d.notifyOutcomeRate).mock.calls[2][0] as string[]).map((l) => l.split(':')[0])).toEqual(['tripoint', 'acme'])
    expect(d.kv.store.has(`export-alert:${BUYER_OUTCOME_RATE_JOB}:cooldown`)).toBe(false)
  })

  it('a manual mute is left alone when a second buyer starts failing', async () => {
    const acme: CheckBuyer = { ...TRIPOINT, partner_id: '33333333-3333-4333-8333-333333333333', slug: 'acme', has_independent_record: false }
    const failing = hourOf('released', 6)
    const d = deps({ entries: day(failing), sales: [], winners: [], buyers: [TRIPOINT, acme], salesforce: null })
    d.kv.store.set(`outcome-rate-paged:${PARTNER}`, '1')
    d.kv.store.set(`export-alert:${BUYER_OUTCOME_RATE_JOB}:cooldown`, 'muted')
    await runBuyerSalesChecks(d)
    expect(d.kv.store.get(`export-alert:${BUYER_OUTCOME_RATE_JOB}:cooldown`)).toBe('muted')
  })

  it('the baseline read covers the 14 Eastern days before today and is asked once per buyer', async () => {
    const asked: Array<[string, string, string]> = []
    const d = deps({}, { readOutcomeBaseline: async (partnerId, fromDay, toDay) => { asked.push([partnerId, fromDay, toDay]); return HEALTHY_BASELINE } })
    const s = await runBuyerSalesChecks(d)
    expect(asked).toEqual([[PARTNER, '2027-09-06', '2027-09-20']])
    expect(OUTCOME_BASELINE_DAYS).toBe(14)
    expect(s.buyers[0].outcome_rate.verdict).toBe('quiet')
    expect(endingOf(s).outcome).toBe('ok')
  })

  it('a baseline that cannot be read is unmeasured for that buyer and the run is not a pass', async () => {
    const busy = [...hourOf('released', 4), ...hourOf('accepted', 6)]
    const d = deps({ entries: day(busy), sales: [], winners: [] }, { readOutcomeBaseline: async () => { throw new Error('buyer_sales count timed out') } })
    const s = await runBuyerSalesChecks(d)
    expect(s.buyers[0].outcome_rate).toMatchObject({ verdict: 'unmeasured', reason: expect.stringMatching(/timed out/) })
    expect(endingOf(s).outcome).not.toBe('ok')
  })
})

// #2420: an hour the check could not measure says nothing about a standing
// page, so it neither raises one nor clears one (L98, L695), the way the
// Tripoint bridge already treats it; only a measured hour clears.
describe('an unmeasured hour and a standing outcome rate page (#2420)', () => {
  const day = (entries: LedgerEntry[]) => ({ '2027-09-20': entries, '2027-09-19': [] })
  const ACME: CheckBuyer = { ...TRIPOINT, partner_id: '33333333-3333-4333-8333-333333333333', slug: 'acme', has_independent_record: false }
  const CONDITION = `export-alert:${BUYER_OUTCOME_RATE_JOB}:condition`
  // Ten attempts, enough for a rate, one in ten failed: clean against a healthy baseline.
  const cleanHour = () => [...hourOf('released', 1), ...hourOf('accepted', 9)]
  /** A fixture every other check agrees with, so the run's outcome is the outcome rate's alone. */
  const agreeing = (entries: LedgerEntry[]): Fixture => {
    const won = entries.filter((e) => e.status === 'accepted')
    return {
      entries: day(entries),
      sales: entries.map((e) => ({ lead_key: e.lead_key, status: e.status, kind: 'live' })),
      winners: won.map((e) => ({ execution_id: e.execution_id ?? '', attempted_at_utc: new Date(e.reserved_at).toISOString() })),
      salesforce: new Set(won.map((e) => e.outcome?.buyer_reference ?? '')),
    }
  }

  function standing(d: ReturnType<typeof deps>, partnerId = PARTNER) {
    d.kv.store.set(`outcome-rate-paged:${partnerId}`, '2027-09-20T14:40:00.000Z')
    d.kv.store.set(CONDITION, JSON.stringify({ since: '2027-09-20T14:40:00.000Z', alerts: 1 }))
  }

  it('a standing page and an hour whose baseline cannot be read: the page stands, and the run records the hour as unmeasured with the reason', async () => {
    const d = deps(agreeing(cleanHour()), { readOutcomeBaseline: async () => { throw new Error('buyer_sales count timed out') } })
    standing(d)
    const s = await runBuyerSalesChecks(d)
    expect(s.buyers[0].outcome_rate).toMatchObject({ verdict: 'unmeasured', reason: expect.stringMatching(/could not be read: buyer_sales count timed out/) })
    expect(d.notifyOutcomeRate).not.toHaveBeenCalled()
    expect(d.kv.store.get(`outcome-rate-paged:${PARTNER}`)).toBe('2027-09-20T14:40:00.000Z')
    expect(d.kv.put).toHaveBeenCalledWith(`outcome-rate-paged:${PARTNER}`, '2027-09-20T14:40:00.000Z', { expirationTtl: 24 * 3600 })
    expect(s.outcome_rate_held).toEqual(['tripoint'])
    const ending = endingOf(s)
    expect(ending.outcome).toBe('unmeasured')
    expect(ending.detail).toMatch(/tripoint outcome rate: the baseline over the prior 14 days could not be read: buyer_sales count timed out/)
    expect(ending.summary).toMatchObject({ held_outcome_rates: ['tripoint'] })
  })

  it('a standing page and an hour whose baseline is below its floor: the page stands', async () => {
    const d = deps({ ...agreeing(cleanHour()), baseline: { attempts: OUTCOME_BASELINE_MIN_ATTEMPTS - 1, failed: 0, declined: 30 } })
    standing(d)
    const s = await runBuyerSalesChecks(d)
    expect(s.buyers[0].outcome_rate).toMatchObject({ verdict: 'unmeasured', reason: expect.stringMatching(/holds 99 attempts, fewer than the 100 it needs/) })
    expect(d.notifyOutcomeRate).not.toHaveBeenCalled()
    expect(d.kv.store.has(`outcome-rate-paged:${PARTNER}`)).toBe(true)
    expect(endingOf(s)).toMatchObject({ outcome: 'unmeasured', detail: expect.stringMatching(/tripoint outcome rate: .*fewer than the 100 it needs/) })
  })

  it('a standing page and a measured clean hour: the page clears', async () => {
    const d = deps(agreeing(cleanHour()))
    standing(d)
    const s = await runBuyerSalesChecks(d)
    expect(s.buyers[0].outcome_rate.verdict).toBe('normal')
    expect(d.notifyOutcomeRate).toHaveBeenCalledWith([])
    expect(d.kv.store.has(`outcome-rate-paged:${PARTNER}`)).toBe(false)
    expect(s.outcome_rate_held).toEqual([])
    expect(endingOf(s).outcome).toBe('ok')
  })

  it('an unmeasured buyer with no page of its own does not hold another buyer\'s page that a measured hour cleared', async () => {
    const d = deps({ entries: day(cleanHour()), sales: [], winners: [], buyers: [TRIPOINT, ACME], salesforce: null }, {
      readOutcomeBaseline: async (partnerId) => {
        if (partnerId === ACME.partner_id) throw new Error('buyer_sales count timed out')
        return HEALTHY_BASELINE
      },
    })
    standing(d)
    const s = await runBuyerSalesChecks(d)
    expect(s.buyers.map((b) => b.outcome_rate.verdict)).toEqual(['normal', 'unmeasured'])
    expect(d.notifyOutcomeRate).toHaveBeenCalledWith([])
    expect(s.outcome_rate_held).toEqual([])
  })

  it('a buyer still elevated keeps paging while another buyer\'s standing page waits out an unmeasured hour', async () => {
    const failing = hourOf('released', 6)
    const d = deps({ entries: day(failing), sales: [], winners: [], buyers: [TRIPOINT, ACME], salesforce: null })
    d.ledger = (partnerId) => ({
      entries: async () => (partnerId === PARTNER ? failing : cleanHour()),
      unmirrored: async () => ({ entries: [], oldest_age_ms: null }),
      unresolved: async () => [],
    })
    d.readOutcomeBaseline = async (partnerId) => {
      if (partnerId === ACME.partner_id) throw new Error('buyer_sales count timed out')
      return HEALTHY_BASELINE
    }
    standing(d, ACME.partner_id)
    const s = await runBuyerSalesChecks(d)
    expect((vi.mocked(d.notifyOutcomeRate).mock.calls[0][0] as string[]).map((l) => l.split(':')[0])).toEqual(['tripoint'])
    expect(d.kv.store.has(`outcome-rate-paged:${ACME.partner_id}`)).toBe(true)
    expect(s.outcome_rate_held).toEqual(['acme'])
    expect(endingOf(s).outcome).toBe('findings')
  })

  // #2421: once a buyer's page stands it holds until the share falls back
  // under half the 25 point rise, so one incident is one page.
  // Ten attempts, half declined: 50% against the 33% baseline, 17 points above,
  // between the line that clears a page (12.5) and the one that raises it (25).
  const betweenTheLines = () => [...hourOf('declined', 5), ...hourOf('accepted', 5)]

  it('judgeOutcomeRate holds a standing page through an hour between the lines, and raises nothing there when none stands', () => {
    expect(judgeOutcomeRate(betweenTheLines(), HEALTHY_BASELINE, NOW, true)).toMatchObject({ verdict: 'held', detail: expect.stringMatching(/5 of 10 attempts in the last hour were declined by the buyer, 50% against 33%/) })
    expect(judgeOutcomeRate(betweenTheLines(), HEALTHY_BASELINE, NOW, false).verdict).toBe('normal')
  })

  it('a standing page and an hour between the lines: nothing is sent, the marker is renewed, and the run records a finding (#2421)', async () => {
    const d = deps(agreeing(betweenTheLines()))
    standing(d)
    const s = await runBuyerSalesChecks(d)
    expect(s.buyers[0].outcome_rate.verdict).toBe('held')
    expect(d.notifyOutcomeRate).not.toHaveBeenCalled()
    expect(d.kv.put).toHaveBeenCalledWith(`outcome-rate-paged:${PARTNER}`, '2027-09-20T14:40:00.000Z', { expirationTtl: 24 * 3600 })
    expect(s.outcome_rate_held).toEqual(['tripoint'])
    expect(endingOf(s).outcome).toBe('findings')
  })

  it('the same hour with no page standing is normal and clears nothing it did not raise (#2421)', async () => {
    const d = deps(agreeing(betweenTheLines()))
    const s = await runBuyerSalesChecks(d)
    expect(s.buyers[0].outcome_rate.verdict).toBe('normal')
    expect(d.notifyOutcomeRate).toHaveBeenCalledWith([])
    expect(d.kv.store.has(`outcome-rate-paged:${PARTNER}`)).toBe(false)
    expect(endingOf(s).outcome).toBe('ok')
  })

  it('each buyer is judged against its own standing page: a held buyer stays off the page while a newly elevated one is paged (#2421)', async () => {
    const failing = hourOf('released', 6)
    const d = deps({ entries: day(failing), sales: [], winners: [], buyers: [TRIPOINT, ACME], salesforce: null })
    d.ledger = (partnerId) => ({
      entries: async () => (partnerId === PARTNER ? betweenTheLines() : failing),
      unmirrored: async () => ({ entries: [], oldest_age_ms: null }),
      unresolved: async () => [],
    })
    standing(d)
    const s = await runBuyerSalesChecks(d)
    expect(s.buyers.map((b) => b.outcome_rate.verdict)).toEqual(['held', 'elevated'])
    expect((vi.mocked(d.notifyOutcomeRate).mock.calls[0][0] as string[]).map((l) => l.split(':')[0])).toEqual(['acme'])
    expect(d.kv.store.has(`outcome-rate-paged:${PARTNER}`)).toBe(true)
    expect(s.outcome_rate_held).toEqual(['tripoint'])
  })

  it('a standing marker that cannot be read leaves that buyer unmeasured and its page alone, and every other buyer is still checked (#2421)', async () => {
    const d = deps({ ...agreeing(cleanHour()), buyers: [TRIPOINT, ACME], salesforce: null })
    const read = d.kv.get.getMockImplementation() as (k: string) => Promise<string | null>
    d.kv.get.mockImplementation(async (k: string) => {
      if (k === `outcome-rate-paged:${PARTNER}`) throw new Error('KV unavailable')
      return read(k)
    })
    const s = await runBuyerSalesChecks(d)
    expect(s.buyers[0].outcome_rate).toMatchObject({ verdict: 'unmeasured', reason: expect.stringMatching(/whether this buyer's outcome rate page is standing could not be read: KV unavailable/) })
    expect(s.buyers[1].outcome_rate.verdict).toBe('normal')
    expect(s.outcome_rate_held).toEqual(['tripoint'])
    expect(d.notifyOutcomeRate).not.toHaveBeenCalled()
  })
})


describe('productionChecksDeps reads past the row cap (#1497)', () => {
  /**
   * A table double that behaves like PostgREST: one answer holds at most
   * PAGE_SIZE rows whatever `.limit` asks, and only `.range` moves the window.
   * Both reads asked for 5,000 rows in one call; a buyer's day of rehearsal
   * entries (up to the 1,695 daily cap) or a busy hour of winner rows would come
   * back truncated and the completeness and consistency checks would page a
   * mismatch that is really the reader's.
   */
  function cappedTable(table: string, total: number) {
    const rows = Array.from({ length: total }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}`, lead_key: `lead-${i}`, status: 'accepted', kind: 'live', execution_id: `e${i}`, attempted_at_utc: new Date(Date.UTC(2027, 8, 20, 13, 0, i % 60, i)).toISOString() }))
    const ranges: Array<[number, number]> = []
    const orders: string[] = []
    let limit: number | null = null
    let range: [number, number] | null = null
    const builder: Record<string, unknown> = {}
    const chain = () => builder
    for (const m of ['select', 'eq', 'gte', 'lt']) builder[m] = chain
    builder.order = (col: string) => { orders.push(col); return builder }
    builder.limit = (n: number) => { limit = n; return builder }
    builder.range = (from: number, to: number) => { range = [from, to]; ranges.push([from, to]); return builder }
    builder.then = (resolve: (v: unknown) => void) => {
      const [from, to] = range ?? [0, Math.min(limit ?? PAGE_SIZE, PAGE_SIZE) - 1]
      const page = rows.slice(from, Math.min(to, from + PAGE_SIZE - 1) + 1)
      range = null
      limit = null
      resolve({ data: page, error: null })
    }
    const supabase = { from: (t: string) => { if (t !== table) throw new Error(`unexpected table ${t}`); return builder } } as unknown as SupabaseClient
    return { supabase, ranges, orders, rows }
  }
  const env = {} as unknown as Env

  it('readSalesRows lists every buyer_sales row of the day in pages of at most PAGE_SIZE, ordered by id', async () => {
    const fake = cappedTable('buyer_sales', 1_700)
    const rows = await productionChecksDeps(fake.supabase, env).readSalesRows('partner-1', '2027-09-20')
    expect(rows).toHaveLength(1_700)
    expect(fake.ranges.length).toBeGreaterThanOrEqual(2)
    for (const [from, to] of fake.ranges) expect(to - from + 1).toBeLessThanOrEqual(PAGE_SIZE)
    expect(fake.orders).toContain('id')
  })

  it('readWinnerRows lists every winner row of the window in pages, ordered by attempted_at_utc with id as the tiebreaker', async () => {
    const fake = cappedTable('lead_sighting_bids', 2_300)
    const rows = await productionChecksDeps(fake.supabase, env).readWinnerRows('tripoint', Date.UTC(2027, 8, 20, 13), Date.UTC(2027, 8, 20, 14))
    expect(rows).toHaveLength(2_300)
    expect(fake.ranges.length).toBeGreaterThanOrEqual(3)
    expect(fake.orders[0]).toBe('attempted_at_utc')
    expect(fake.orders).toContain('id')
  })
})

// #1541: a click sold buyer has no ledger day and no buyer_sales rows, so
// listing it here would turn every 15 minute run unmeasured.
describe('productionChecksDeps lists offer buyers only', () => {
  it('leaves a click sold buyer out of the checks', async () => {
    const partner = (slug: string) => ({ organization_id: 'org-1', slug })
    const caps = { hourly_lead_cap: null, daily_lead_cap: 50, hourly_spend_cap_cents: null, daily_spend_cap_cents: null }
    const supabase = profilesTableDouble([
      { partner_id: 'p-offer', sold_on: 'offer', ...caps, organizations: { is_synthetic: false }, partner_configs: partner('tripoint') },
      { partner_id: 'p-click', sold_on: 'click', ...caps, organizations: { is_synthetic: false }, partner_configs: partner('liberty1') },
    ])
    const buyers = await productionChecksDeps(supabase, {} as unknown as Env).listBuyers()
    expect(buyers.map((b) => b.partner_id)).toEqual(['p-offer'])
  })

  // #2135: the partners page delivery monitor's organization is synthetic, and
  // no job that lists buyers across organizations may list one of it.
  it('never lists a buyer of a synthetic organization', async () => {
    const caps = { hourly_lead_cap: null, daily_lead_cap: 50, hourly_spend_cap_cents: null, daily_spend_cap_cents: null }
    const supabase = profilesTableDouble([
      { partner_id: 'p-real', sold_on: 'offer', ...caps, organizations: { is_synthetic: false }, partner_configs: { organization_id: 'org-1', slug: 'tripoint' } },
      { partner_id: 'p-monitor', sold_on: 'offer', ...caps, organizations: { is_synthetic: true }, partner_configs: { organization_id: 'org-monitor', slug: 'monitor-buyer' } },
    ])
    const buyers = await productionChecksDeps(supabase, {} as unknown as Env).listBuyers()
    expect(buyers.map((b) => b.partner_id)).toEqual(['p-real'])
  })
})

describe('the independent record lookup (#1737)', () => {
  it('asks Salesforce for the field the Engine Bidding patch writes, TripointLeadID__c, bounded by CreatedDate', () => {
    const from = Date.UTC(2026, 9, 2, 4, 0, 0)
    const soql = independentRecordSoql(['51550e5d-dc03-4889-8e8e-f02355316ea4', 'TP-2'], from)
    expect(soql).toBe(
      "SELECT TripointLeadID__c FROM Prospect__c WHERE CreatedDate >= 2026-10-02T04:00:00Z AND TripointLeadID__c IN ('51550e5d-dc03-4889-8e8e-f02355316ea4','TP-2')",
    )
    // The field that does not exist on Prospect__c, read 2026-10-02 from FieldDefinition.
    expect(soql).not.toContain('Tripoint_Lead_ID__c')
  })

  it('looks back from an hour before the earliest checked Eastern day, so a prospect created just before midnight still counts', async () => {
    const seen: number[] = []
    const d = deps({}, { readIndependentRecord: async (_buyer, _refs, fromMs) => { seen.push(fromMs); return new Set(['TP-lead-1']) } })
    await runBuyerSalesChecks(d)
    // The fixture checks Eastern days 2027-09-20 and 2027-09-19; 2027-09-19 starts at 04:00 UTC (EDT).
    expect(seen).toEqual([Date.UTC(2027, 8, 19, 3, 0, 0)])
  })
})

/**
 * What each page says, derived from what the check measured (#835). Every
 * sentence here used to be one fixed paragraph per page, which told a reader
 * about a lost bid logger write when the winner rows were LONG, about a missing
 * Salesforce write back when Salesforce was never asked, and about a ledger
 * disagreement when the buyer list could not even be read.
 */
describe('the page wording follows what was measured (#835)', () => {
  type Sent = { consequence: string; fixHint: string; headlineVerb?: string }
  const mismatchRemedy = (d: ReturnType<typeof deps>, call: number): Sent => vi.mocked(d.notifyMismatch).mock.calls[call][1] as Sent

  it('a buyer list that cannot be read is said in its own words, never as a ledger disagreement', async () => {
    const d = deps({}, { listBuyers: async () => { throw new Error('buyer_profiles unreadable') } })
    await runBuyerSalesChecks(d)
    const sent = mismatchRemedy(d, 0)
    expect(sent).toBe(BUYER_SALES_UNLISTED_REMEDY)
    expect(sent.consequence).not.toMatch(/disagreed/)
    expect(sent.consequence).toMatch(/buyer list/)
    expect(`${sent.consequence} ${sent.headlineVerb}`).not.toMatch(/disagreement/)
  })

  it('more winner rows than accepted sales in an hour is never called a lost bid logger write', async () => {
    const twoWinners = [
      { execution_id: 'exec-lead-1', attempted_at_utc: new Date(NOW - 10 * 60_000).toISOString() },
      { execution_id: 'exec-lead-x', attempted_at_utc: new Date(NOW - 9 * 60_000).toISOString() },
    ]
    const d = deps({ winners: twoWinners })
    await runBuyerSalesChecks(d)
    await runBuyerSalesChecks(d)
    const sent = mismatchRemedy(d, 1)
    expect(sent.fixHint).not.toMatch(/write was lost|no winner row/)
    expect(sent.fixHint).toMatch(/more winner rows than accepted sales/)
    // Only the check that disagreed gets a fix line.
    expect(sent.fixHint).not.toMatch(/Completeness|Salesforce/)
  })

  it('fewer winner rows than accepted sales is the lost write case, and only that clause is given', async () => {
    const d = deps({ winners: [] })
    await runBuyerSalesChecks(d)
    await runBuyerSalesChecks(d)
    const sent = mismatchRemedy(d, 1)
    expect(sent.fixHint).toMatch(/fewer winner rows than accepted sales/)
    expect(sent.fixHint).toMatch(/lost/)
    expect(sent.fixHint).not.toMatch(/more winner rows/)
  })

  it('an attempt whose winner row and reservation fall either side of an hour is named as that before a lost write', async () => {
    // Reserved at 15:00:30, its winner row stamped at 14:59:50: hour 14 has a winner and no sale, hour 15 the reverse.
    const reservedAt = Date.UTC(2027, 8, 20, 15, 0, 30)
    const d = deps({
      entries: { '2027-09-20': [accepted('lead-1', reservedAt)], '2027-09-19': [] },
      winners: [{ execution_id: 'exec-lead-1', attempted_at_utc: new Date(Date.UTC(2027, 8, 20, 14, 59, 50)).toISOString() }],
    })
    await runBuyerSalesChecks(d)
    await runBuyerSalesChecks(d)
    const sent = mismatchRemedy(d, 1)
    expect(sent.fixHint).toMatch(/began in one hour and reserved in the next/)
  })

  it('an accepted sale with no buyer reference is not described as missing from Salesforce, which was never asked about it', async () => {
    const blank = { ...accepted('lead-1', NOW - 10 * 60_000), outcome: { buyer_reference: null, result_code: '1000', http_status: 200, payout_cents: 2190 } } as unknown as LedgerEntry
    const d = deps({ entries: { '2027-09-20': [blank], '2027-09-19': [] } })
    await runBuyerSalesChecks(d)
    await runBuyerSalesChecks(d)
    const sent = mismatchRemedy(d, 1)
    expect(sent.fixHint).not.toMatch(/Salesforce holds no write back/)
    expect(sent.fixHint).toMatch(/no buyer reference/)
  })

  it('a reference Salesforce lacks keeps the write back fix', async () => {
    const d = deps({ salesforce: new Set() })
    await runBuyerSalesChecks(d)
    await runBuyerSalesChecks(d)
    const sent = mismatchRemedy(d, 1)
    expect(sent.fixHint).toMatch(/Salesforce holds no write back/)
    expect(sent.fixHint).not.toMatch(/no buyer reference/)
  })

  it('the outcome rate page claims no baseline it may not have had and no runs it did not read', () => {
    // A saturated hour is judged with no baseline at all, and an unclassified answer holds the lead and can fail the run.
    const words = `${BUYER_OUTCOME_RATE_REMEDY.consequence} ${BUYER_OUTCOME_RATE_REMEDY.headlineVerb}`
    expect(words).not.toMatch(/prior 14 days|than usual/)
    expect(words).not.toMatch(/succeeded|nothing else pages/)
  })

  it("an unresolved sale from an earlier day is counted, but only today's are said to hold today's caps", async () => {
    const yesterday = { ...unresolved('lead-u0', NOW - 20 * HOUR), et_day: '2027-09-19' }
    const today = unresolved('lead-u1', NOW - 40 * 60_000)
    const d = deps({}, {
      ledger: () => ({
        entries: async () => [],
        unmirrored: async () => ({ entries: [], oldest_age_ms: null }),
        unresolved: async () => [yesterday, today],
      }),
    })
    const s = await runBuyerSalesChecks(d)
    // The count and the page decision are unchanged: both entries are waiting on a person.
    expect(s.buyers[0].unresolved.count).toBe(2)
    const line = (vi.mocked(d.notifyUnresolved).mock.calls[0][0] as string[])[0]
    expect(line).toMatch(/tripoint: 2 unresolved sales, oldest 20 hours/)
    expect(line).toMatch(/1 of the 500 lead slots/)
    expect(line).toMatch(/\$21\.90 of the \$1,000\.00/)
    expect(BUYER_SALES_UNRESOLVED_REMEDY.consequence).not.toMatch(/Each holds a slot/)
  })
})

describe('one KV marker failing leaves every other check judged (#2431, L71, L98)', () => {
  const ACME: CheckBuyer = { ...TRIPOINT, partner_id: '33333333-3333-4333-8333-333333333333', slug: 'acme', has_independent_record: false }
  // Today holds one accepted sale and one unresolved one; the copy holds nothing, so completeness is a mismatch.
  const mixed = () => ({ '2027-09-20': [accepted('lead-1', NOW - 10 * 60_000), unresolved('lead-u1', NOW - 20 * 60_000)], '2027-09-19': [] })

  /** Makes one KV operation on one key throw, leaving every other call to the fake store. */
  function failing(d: ReturnType<typeof deps>, op: 'get' | 'put' | 'delete', key: string) {
    const real = d.kv[op].getMockImplementation() as (k: string, ...rest: unknown[]) => Promise<unknown>
    d.kv[op].mockImplementation((async (k: string, ...rest: unknown[]) => {
      if (k === key) throw new Error('KV unavailable')
      return real(k, ...rest)
    }) as never)
  }

  it('a mismatch marker that cannot be read leaves completeness, consistency, independent, unresolved and outcome rate judged, and the mismatch page is neither raised nor cleared', async () => {
    const d = deps({ entries: mixed(), sales: [] })
    failing(d, 'get', `buyer-sales-mismatch-seen:${PARTNER}`)
    const s = await runBuyerSalesChecks(d)
    expect(s.buyers[0].completeness.verdict).toBe('mismatch')
    expect(s.buyers[0].consistency.verdict).toBe('consistent')
    expect(s.buyers[0].independent.verdict).toBe('verified')
    expect(s.buyers[0].outcome_rate.verdict).not.toBe('unmeasured')
    expect(s.buyers[0].unresolved).toMatchObject({ count: 1, paged: true })
    expect(d.notifyUnresolved).toHaveBeenCalledWith([expect.stringMatching(/^tripoint: 1 unresolved sale/)])
    expect(d.notifyOutcomeRate).toHaveBeenCalled()
    // Neither a page on what may be a one run disagreement nor an all clear on a mismatch measured this run.
    expect(d.notifyMismatch).not.toHaveBeenCalled()
    expect(s.mismatch_held).toEqual(['tripoint'])
    expect(s.marker_failures).toEqual([expect.stringMatching(/tripoint mismatch marker could not be read: KV unavailable/)])
    const ending = endingOf(s)
    expect(ending.outcome).toBe('findings')
    expect(ending.summary?.unmeasured).toEqual(expect.arrayContaining([expect.stringMatching(/tripoint mismatch marker could not be read: KV unavailable/)]))
    // The marker is still written, so the next run can tell the mismatch persisted.
    expect(d.kv.store.has(`buyer-sales-mismatch-seen:${PARTNER}`)).toBe(true)
  })

  it("a buyer whose mismatch marker cannot be read does not stop another buyer's persisting mismatch paging", async () => {
    const d = deps({ sales: [], buyers: [TRIPOINT, ACME], salesforce: null })
    d.kv.store.set(`buyer-sales-mismatch-seen:${ACME.partner_id}`, '2027-09-20T15:25:00.000Z')
    failing(d, 'get', `buyer-sales-mismatch-seen:${PARTNER}`)
    await runBuyerSalesChecks(d)
    expect((vi.mocked(d.notifyMismatch).mock.calls[0][0] as string[]).map((l) => l.split(':')[0])).toEqual(['acme'])
  })

  it('an unresolved marker that cannot be read pages the count again rather than risk never paging it, and every other check is judged', async () => {
    const d = deps({ entries: mixed(), sales: [] })
    d.kv.store.set(`buyer-sales-mismatch-seen:${PARTNER}`, '2027-09-20T15:25:00.000Z')
    failing(d, 'get', `unresolved-paged:${PARTNER}`)
    const s = await runBuyerSalesChecks(d)
    expect(s.buyers[0].completeness.verdict).toBe('mismatch')
    expect(s.buyers[0].consistency.verdict).toBe('consistent')
    expect(s.buyers[0].independent.verdict).toBe('verified')
    expect(s.buyers[0].outcome_rate.verdict).not.toBe('unmeasured')
    expect(d.notifyMismatch).toHaveBeenCalledWith([expect.stringMatching(/^tripoint: completeness/)], expect.anything())
    expect(d.notifyUnresolved).toHaveBeenCalledWith([expect.stringMatching(/^tripoint: 1 unresolved sale/)])
    expect(s.buyers[0].unresolved.paged).toBe(true)
    expect(s.marker_failures).toEqual([expect.stringMatching(/tripoint unresolved marker could not be read: KV unavailable/)])
    expect(endingOf(s).summary?.unmeasured).toEqual(expect.arrayContaining([expect.stringMatching(/tripoint unresolved marker could not be read/)]))
  })

  it('an unresolved marker holding something that is not a count pages, never parses to a value no count can exceed (L50)', async () => {
    const d = deps({ entries: mixed(), sales: [] })
    d.kv.store.set(`unresolved-paged:${PARTNER}`, 'not a number')
    const s = await runBuyerSalesChecks(d)
    expect(d.notifyUnresolved).toHaveBeenCalledWith([expect.stringMatching(/^tripoint: 1 unresolved sale/)])
    expect(s.marker_failures).toEqual([expect.stringMatching(/tripoint unresolved marker holds "not a number", not a count/)])
  })

  it('an unreadable unresolved marker does not reset the reminder backoff, which only a count known to have grown may do', async () => {
    const d = deps({ entries: mixed(), sales: [] })
    d.kv.store.set(`export-alert:${BUYER_SALES_UNRESOLVED_JOB}:condition`, JSON.stringify({ since: '2027-09-20T15:00:00.000Z', alerts: 1 }))
    d.kv.store.set(`export-alert:${BUYER_SALES_UNRESOLVED_JOB}:cooldown`, '1')
    failing(d, 'get', `unresolved-paged:${PARTNER}`)
    await runBuyerSalesChecks(d)
    expect(d.kv.store.has(`export-alert:${BUYER_SALES_UNRESOLVED_JOB}:cooldown`)).toBe(true)
  })

  it('a failed write to any marker is recorded with what it costs and does not abort the run', async () => {
    const d = deps({ entries: mixed(), sales: [] })
    failing(d, 'put', `buyer-sales-mismatch-seen:${PARTNER}`)
    failing(d, 'put', `unresolved-paged:${PARTNER}`)
    const s = await runBuyerSalesChecks(d)
    expect(d.notifyMismatch).toHaveBeenCalled()
    expect(d.notifyUnresolved).toHaveBeenCalledWith([expect.stringMatching(/^tripoint: 1 unresolved sale/)])
    expect(d.notifyOutcomeRate).toHaveBeenCalled()
    expect(s.marker_failures).toEqual([
      expect.stringMatching(/tripoint mismatch marker could not be written: KV unavailable/),
      expect.stringMatching(/tripoint unresolved marker could not be written: KV unavailable/),
    ])
  })

  it('a marker that cannot be cleared on a clean run is recorded, and the run is unmeasured rather than a pass', async () => {
    const d = deps()
    failing(d, 'delete', `buyer-sales-mismatch-seen:${PARTNER}`)
    failing(d, 'delete', `unresolved-paged:${PARTNER}`)
    failing(d, 'delete', `outcome-rate-paged:${PARTNER}`)
    const s = await runBuyerSalesChecks(d)
    expect(s.buyers[0].completeness.verdict).toBe('complete')
    expect(d.notifyMismatch).toHaveBeenCalledWith([], expect.anything())
    expect(s.marker_failures).toEqual([
      expect.stringMatching(/tripoint mismatch marker could not be cleared: KV unavailable/),
      expect.stringMatching(/tripoint unresolved marker could not be cleared: KV unavailable/),
      expect.stringMatching(/tripoint outcome rate marker could not be cleared: KV unavailable/),
    ])
    const ending = endingOf(s)
    expect(ending.outcome).toBe('unmeasured')
    expect(ending.detail).toMatch(/tripoint mismatch marker could not be cleared/)
  })

  it('an outcome rate marker that cannot be written after a page is recorded, and the page still goes', async () => {
    const d = deps({ entries: { '2027-09-20': hourOf('released', 12), '2027-09-19': [] }, sales: [], winners: [] })
    failing(d, 'put', `outcome-rate-paged:${PARTNER}`)
    const s = await runBuyerSalesChecks(d)
    expect(s.buyers[0].outcome_rate.verdict).toBe('elevated')
    expect(d.notifyOutcomeRate).toHaveBeenCalledWith([expect.stringMatching(/^tripoint: /)])
    expect(s.marker_failures).toEqual([expect.stringMatching(/tripoint outcome rate marker could not be written: KV unavailable/)])
  })

  it('a reminder backoff that cannot be reset is recorded, and the page still goes', async () => {
    const two = [unresolved('lead-u1', NOW - 40 * 60_000), unresolved('lead-u2', NOW - 30 * 60_000)]
    const d = deps({ entries: { '2027-09-20': two, '2027-09-19': [] }, sales: two.map((e) => ({ lead_key: e.lead_key, status: 'unresolved', kind: 'live' })), winners: [] })
    d.kv.store.set(`unresolved-paged:${PARTNER}`, '1')
    d.kv.store.set(`export-alert:${BUYER_SALES_UNRESOLVED_JOB}:condition`, JSON.stringify({ since: '2027-09-20T15:00:00.000Z', alerts: 1 }))
    failing(d, 'delete', `export-alert:${BUYER_SALES_UNRESOLVED_JOB}:condition`)
    const s = await runBuyerSalesChecks(d)
    expect(d.notifyUnresolved).toHaveBeenCalledWith([expect.stringMatching(/^tripoint: 2 unresolved sales/)])
    expect(s.marker_failures).toEqual([expect.stringMatching(/the buyer-sales-unresolved reminder backoff could not be reset: KV unavailable/)])
  })

  it('one page that cannot be sent does not stop the others, and the run is recorded as failed with the reason', async () => {
    const d = deps({ entries: mixed(), sales: [] }, { notifyMismatch: vi.fn(async () => { throw new Error('alerter KV unavailable') }) })
    const s = await runBuyerSalesChecks(d)
    expect(d.notifyUnresolved).toHaveBeenCalled()
    expect(d.notifyOutcomeRate).toHaveBeenCalled()
    expect(s.alert_failures).toEqual([expect.stringMatching(/the buyer-sales-mismatch page could not be sent: alerter KV unavailable/)])
    const ending = endingOf(s)
    expect(ending.outcome).toBe('failed')
    expect(ending.detail).toMatch(/buyer-sales-mismatch page could not be sent: alerter KV unavailable/)
  })
})
