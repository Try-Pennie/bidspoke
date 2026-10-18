/**
 * BuyerLedgerObject against real SQLite storage inside workerd (#1410).
 *
 * One object per buyer holds every reservation and outcome, and answers the
 * cap question from what it holds. These tests drive the object through its
 * fetch routes exactly as the worker does, and read its storage back through
 * runInDurableObject where the route surface is not enough.
 *
 * Time never comes from the machine: every request carries `now`, the instant
 * the calling attempt is reasoning at, so the hour and the Eastern day roll on
 * a clock the test sets (L39, L524).
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../index'
import { PENDING_GRACE_MS, RETENTION_MS, type BuyerLedgerObject, type Counts, type EntryResult, type LedgerEntry, type MirroredStamp, type ReserveBody, type ReserveResult, type Summary, type UnmirroredResult } from '../buyer-ledger'
import { BuyerLedgerClient, buyerLedgerObjectName } from '../../lib/buyer-object-clients'
import { ledgerClientOptions, runBuyerSaleDrain, type DrainDeps } from '../../lib/buyer-sale-drain'

const bindings = env as unknown as Pick<Env, 'BUYER_LEDGER'>

/**
 * 2027-09-20 15:30 UTC: a Monday, 11:30 in New York (EDT). In the FUTURE on
 * purpose: the object arms its alarm relative to its clock, and workerd fires an
 * alarm whose time has already passed at once, so a fake clock in the past would
 * have the runtime running the alarm underneath the test instead of the test
 * running it through runDurableObjectAlarm.
 */
const NOW = Date.UTC(2027, 8, 20, 15, 30)

const NO_LIMITS: ReserveBody['limits'] = {
  hourly_lead_cap: null,
  daily_lead_cap: null,
  hourly_spend_cap_cents: null,
  daily_spend_cap_cents: null,
}

let buyerSeq = 0
/** A fresh object per test, so nothing leaks between cases. */
function ledger(): DurableObjectStub {
  buyerSeq += 1
  const id = bindings.BUYER_LEDGER.idFromName(`buyer:test-${buyerSeq}`)
  return bindings.BUYER_LEDGER.get(id)
}

function post(stub: DurableObjectStub, path: string, body: unknown): Promise<Response> {
  return stub.fetch(`http://do${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function reserveBody(leadKey: string, overrides: Partial<ReserveBody> = {}): ReserveBody {
  return {
    lead_key: leadKey,
    population: 'engine',
    kind: 'live',
    payout_cents: 1500,
    execution_id: `exec-${leadKey}`,
    limits: NO_LIMITS,
    ...overrides,
  }
}

async function reserve(stub: DurableObjectStub, leadKey: string, overrides: Partial<ReserveBody> = {}): Promise<ReserveResult> {
  const res = await post(stub, '/reserve', reserveBody(leadKey, overrides))
  expect(res.status).toBe(200)
  return res.json<ReserveResult>()
}

describe('BuyerLedgerObject reserve', () => {
  it.each([
    // [the out reason the refusal names, the one limit set]
    ['hourly_lead_cap', { hourly_lead_cap: 1 }],
    ['daily_lead_cap', { daily_lead_cap: 1 }],
    ['hourly_spend_cap', { hourly_spend_cap_cents: 2000 }],
    ['daily_spend_cap', { daily_spend_cap_cents: 2000 }],
  ] as const)('two leads racing for the last slot under %s: exactly one reserve passes', async (limit, partial) => {
    const stub = ledger()
    const limits = { ...NO_LIMITS, ...partial }
    const [a, b] = await Promise.all([
      reserve(stub, 'lead-a', { limits }),
      reserve(stub, 'lead-b', { limits }),
    ])
    const passed = [a, b].filter((r) => r.reserved)
    const refused = [a, b].filter((r) => !r.reserved)
    expect(passed).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ reserved: false, reason: limit })
  })

  it('a reserve repeated for one lead takes one slot and returns the existing entry', async () => {
    const stub = ledger()
    const limits = { ...NO_LIMITS, hourly_lead_cap: 1 }
    const first = await reserve(stub, 'lead-a', { limits })
    const again = await reserve(stub, 'lead-a', { limits, execution_id: 'exec-retry' })
    expect(first).toMatchObject({ reserved: true, repeat: false })
    expect(again).toMatchObject({ reserved: true, repeat: true })
    const entry = (again as { entry: LedgerEntry }).entry
    expect(entry.execution_id).toBe('exec-lead-a')
    // The slot the repeat did not take is still there for another lead? No:
    // the cap is one and lead-a holds it, so a third lead is refused, proving
    // the repeat neither took a second slot nor freed the first.
    const other = await reserve(stub, 'lead-b', { limits })
    expect(other).toMatchObject({ reserved: false, reason: 'hourly_lead_cap' })
  })

  it('refuses malformed input by name rather than reserving something else (L11, L50)', async () => {
    const stub = ledger()
    const cases: Array<[Partial<ReserveBody> | Record<string, unknown>, string]> = [
      [{ lead_key: '' }, 'bad_key'],
      [{ population: 'nowhere' }, 'bad_key'],
      [{ kind: 'dress_rehearsal' }, 'bad_key'],
      [{ payout_cents: 12.5 }, 'bad_payout'],
      [{ payout_cents: -1 }, 'bad_payout'],
      [{ execution_id: '' }, 'bad_execution_id'],
      [{ limits: { ...NO_LIMITS, hourly_lead_cap: 0 } }, 'bad_limits'],
      [{ limits: { ...NO_LIMITS, daily_spend_cap_cents: 'lots' } }, 'bad_limits'],
    ]
    for (const [overrides, error] of cases) {
      const res = await post(stub, '/reserve', { ...reserveBody('lead-x'), ...overrides })
      expect(res.status, JSON.stringify(overrides)).toBe(400)
      expect(await res.json()).toEqual({ error })
    }
    expect((await peek(stub)).hour_leads).toBe(0)
  })
})

// ── Shared helpers for the clock driven cases ─────────────────────────────────

async function setClock(stub: DurableObjectStub, ms: number): Promise<void> {
  await runInDurableObject(stub, (instance: BuyerLedgerObject) => {
    instance.clock = () => ms
  })
}

async function get<T>(stub: DurableObjectStub, path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`http://do${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await stub.fetch(url.toString())
  expect(res.status, path).toBe(200)
  return res.json<T>()
}

const key = (leadKey: string) => ({ lead_key: leadKey, population: 'engine', kind: 'live' })
const peek = (stub: DurableObjectStub) => get<Counts>(stub, '/peek', { kind: 'live' })
const entryOf = (stub: DurableObjectStub, leadKey: string) => get<EntryResult>(stub, '/entry', { ...key(leadKey) })
const OUTCOME = { buyer_reference: 'TP-1', result_code: '1000', http_status: 200, payout_cents: 1500 }
/** What a copy read of an entry, as the mark carries it (#2422). */
const stampFrom = (e: LedgerEntry): MirroredStamp => ({ lead_key: e.lead_key, population: e.population, kind: e.kind, status: e.status, resolved_at: e.resolved_at })
async function stampOf(stub: DurableObjectStub, leadKey: string): Promise<MirroredStamp> {
  const r = await entryOf(stub, leadKey)
  if (!r.found) throw new Error(`no entry ${leadKey}`)
  return stampFrom(r.entry)
}

describe('BuyerLedgerObject outcomes', () => {
  it('commit records the outcome, entry returns it, and a second commit is refused naming the state', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-a')
    const res = await post(stub, '/commit', { ...key('lead-a'), outcome: OUTCOME })
    expect(res.status).toBe(200)
    const found = await entryOf(stub, 'lead-a')
    expect(found).toMatchObject({ found: true, entry: { status: 'accepted', outcome: OUTCOME, resolved_at: NOW } })
    const again = await post(stub, '/commit', { ...key('lead-a'), outcome: OUTCOME })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: 'wrong_status', status: 'accepted' })
  })

  it('a release, declined or released, frees the slot and stops counting', async () => {
    const stub = ledger()
    const limits = { ...NO_LIMITS, hourly_lead_cap: 1 }
    await reserve(stub, 'lead-a', { limits })
    expect(await reserve(stub, 'lead-b', { limits })).toMatchObject({ reserved: false })
    const res = await post(stub, '/release', { ...key('lead-a'), status: 'declined' })
    expect(res.status).toBe(200)
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { status: 'declined' } })
    expect(await reserve(stub, 'lead-b', { limits })).toMatchObject({ reserved: true })
    expect((await peek(stub)).hour_leads).toBe(1)
  })

  it('a release keeps the buyer\'s answer it is given, so a decline records what the buyer said (#1735)', async () => {
    const stub = ledger()
    await reserve(stub, 'lead-a')
    const answer = { ...OUTCOME, result_code: '1003', buyer_reference: 'TP-9' }
    const res = await post(stub, '/release', { ...key('lead-a'), status: 'declined', outcome: answer })
    expect(res.status).toBe(200)
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { status: 'declined', outcome: answer, mirrored: false } })
  })

  it('a release given a malformed answer is refused and leaves the reservation as it was (#1735)', async () => {
    const stub = ledger()
    await reserve(stub, 'lead-a')
    const res = await post(stub, '/release', { ...key('lead-a'), status: 'declined', outcome: { result_code: 1003 } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad_outcome' })
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { status: 'reserved' } })
  })

  it('a transition on an absent entry answers absent, not success (L100)', async () => {
    const stub = ledger()
    const res = await post(stub, '/release', { ...key('never-reserved'), status: 'released' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'absent' })
    expect(await entryOf(stub, 'never-reserved')).toEqual({ found: false })
  })

  it('settle moves only an unresolved entry, and accepted needs the outcome', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-a')
    const early = await post(stub, '/settle', { ...key('lead-a'), status: 'released' })
    expect(early.status).toBe(409)
    expect(await early.json()).toMatchObject({ error: 'wrong_status', status: 'reserved' })
    await setClock(stub, NOW + PENDING_GRACE_MS)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const noOutcome = await post(stub, '/settle', { ...key('lead-a'), status: 'accepted' })
    expect(noOutcome.status).toBe(400)
    expect(await noOutcome.json()).toEqual({ error: 'accepted_needs_outcome' })
    const settled = await post(stub, '/settle', { ...key('lead-a'), status: 'accepted', outcome: OUTCOME })
    expect(settled.status).toBe(200)
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { status: 'accepted', outcome: OUTCOME } })
    const unresolved = await get<{ entries: LedgerEntry[] }>(stub, '/unresolved')
    expect(unresolved.entries).toEqual([])
  })

  it('settle records who settled it and how, and hands the entry back to the mirror (#1412, L83)', async () => {
    // The ledger is the one home of a settlement: the person's decision lands here
    // first, and the mirror carries resolution_source and resolved_by to
    // buyer_sales from the entry, so the drain can deliver it without knowing
    // who pressed the button.
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-a')
    await setClock(stub, NOW + PENDING_GRACE_MS)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    // The drain already mirrored the unresolved state.
    const marked = await post(stub, '/mark-mirrored', { keys: [await stampOf(stub, 'lead-a')] })
    expect(marked.status).toBe(200)
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { status: 'unresolved', mirrored: true } })

    const settled = await post(stub, '/settle', { ...key('lead-a'), status: 'released', resolved_by: '22222222-2222-4222-8222-222222222222' })
    expect(settled.status).toBe(200)
    const after = await entryOf(stub, 'lead-a')
    expect(after).toMatchObject({
      found: true,
      entry: { status: 'released', mirrored: false, resolution_source: 'settled', resolved_by: '22222222-2222-4222-8222-222222222222' },
    })
    const unmirrored = await get<UnmirroredResult>(stub, '/unmirrored')
    expect(unmirrored.entries.map((e) => e.lead_key)).toEqual(['lead-a'])
  })

  it('a buyer outcome records the buyer as the source, and a state change after a mirror is unmirrored again', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-a')
    await post(stub, '/mark-mirrored', { keys: [await stampOf(stub, 'lead-a')] })
    const committed = await post(stub, '/commit', { ...key('lead-a'), outcome: OUTCOME })
    expect(committed.status).toBe(200)
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { status: 'accepted', mirrored: false, resolution_source: 'buyer', resolved_by: null } })
  })

  it('the grace alarm moving a mirrored reservation to unresolved makes it unmirrored again, so the drain delivers the new state', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-a')
    await post(stub, '/mark-mirrored', { keys: [await stampOf(stub, 'lead-a')] })
    await setClock(stub, NOW + PENDING_GRACE_MS)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { status: 'unresolved', mirrored: false } })
  })

  it('settle refuses a resolved_by that is not a uuid, by name', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-a')
    await setClock(stub, NOW + PENDING_GRACE_MS)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const bad = await post(stub, '/settle', { ...key('lead-a'), status: 'released', resolved_by: 'dan' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'bad_resolved_by' })
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { status: 'unresolved' } })
  })
})

describe('BuyerLedgerObject summary agrees with reserve (L16)', () => {
  it('counts accepted, in flight and unresolved, and not declined, in both surfaces', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'accepted')
    await post(stub, '/commit', { ...key('accepted'), outcome: OUTCOME })
    await reserve(stub, 'unresolved')
    await setClock(stub, NOW + PENDING_GRACE_MS)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    await reserve(stub, 'in-flight')
    await reserve(stub, 'declined')
    await post(stub, '/release', { ...key('declined'), status: 'declined' })

    const summary = await get<Summary>(stub, '/summary', { kind: 'live', day: '2027-09-20' })
    expect(summary).toEqual({
      et_day: '2027-09-20',
      by_status: { reserved: 1, accepted: 1, unresolved: 1, declined: 1, released: 0 },
      counted_leads: 3,
      counted_spend_cents: 4500,
    })
    const counts = await peek(stub)
    expect(counts).toMatchObject({ day_leads: 3, day_spend_cents: 4500 })
    // The same three refuse a fourth under a cap of three, so reserve judges by the same number.
    const limits = { ...NO_LIMITS, daily_lead_cap: 3 }
    expect(await reserve(stub, 'fourth', { limits })).toMatchObject({ reserved: false, reason: 'daily_lead_cap', limit: 3 })
    // Rehearsal entries live in their own count.
    expect((await get<Counts>(stub, '/peek', { kind: 'rehearsal' })).day_leads).toBe(0)
  })
})

describe('BuyerLedgerObject entries for a day (#1413)', () => {
  it('lists one kind of entry for one Eastern day in reservation order, so the checks can compare them row by row', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-a')
    await post(stub, '/commit', { ...key('lead-a'), outcome: OUTCOME })
    await setClock(stub, NOW + 60_000)
    await reserve(stub, 'lead-b')
    await reserve(stub, 'lead-r', { kind: 'rehearsal' })
    const live = await get<{ entries: LedgerEntry[] }>(stub, '/entries', { kind: 'live', day: '2027-09-20' })
    expect(live.entries.map((e) => [e.lead_key, e.status])).toEqual([['lead-a', 'accepted'], ['lead-b', 'reserved']])
    const rehearsal = await get<{ entries: LedgerEntry[] }>(stub, '/entries', { kind: 'rehearsal', day: '2027-09-20' })
    expect(rehearsal.entries.map((e) => e.lead_key)).toEqual(['lead-r'])
    const otherDay = await get<{ entries: LedgerEntry[] }>(stub, '/entries', { kind: 'live', day: '2027-09-19' })
    expect(otherDay.entries).toEqual([])
  })

  it('refuses a malformed kind or day by name rather than answering for another day (L11)', async () => {
    const stub = ledger()
    const badKind = await stub.fetch('http://do/entries?kind=dress&day=2027-09-20')
    expect(badKind.status).toBe(400)
    expect(await badKind.json()).toEqual({ error: 'bad_kind' })
    const badDay = await stub.fetch('http://do/entries?kind=live&day=yesterday')
    expect(badDay.status).toBe(400)
    expect(await badDay.json()).toEqual({ error: 'bad_day' })
  })
})

describe('BuyerLedgerObject alarm', () => {
  it('a reservation still pending at the grace deadline becomes unresolved, still counts, and is reported', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-a')
    await setClock(stub, NOW + PENDING_GRACE_MS - 1)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { status: 'reserved' } })
    // The alarm re-armed itself for the entry still pending.
    await setClock(stub, NOW + PENDING_GRACE_MS)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { status: 'unresolved' } })
    expect((await peek(stub)).hour_leads).toBe(1)
    const unresolved = await get<{ entries: LedgerEntry[] }>(stub, '/unresolved')
    expect(unresolved.entries.map((e) => e.lead_key)).toEqual(['lead-a'])
    const unmirrored = await get<UnmirroredResult>(stub, '/unmirrored')
    expect(unmirrored.entries.map((e) => e.lead_key)).toEqual(['lead-a'])
    expect(unmirrored.oldest_age_ms).toBe(PENDING_GRACE_MS)
    // Nothing pending remains, so no alarm is armed.
    expect(await runDurableObjectAlarm(stub)).toBe(false)
  })
})

describe('BuyerLedgerObject alarm on a rehearsal (#1515)', () => {
  it('a rehearsal reservation still pending at the grace deadline is released by the alarm itself, source expired, and stops counting, while a live one beside it becomes unresolved', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-r', { kind: 'rehearsal' })
    await reserve(stub, 'lead-l', { kind: 'live' })
    await setClock(stub, NOW + PENDING_GRACE_MS)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const rehearsal = await get<EntryResult>(stub, '/entry', { lead_key: 'lead-r', population: 'engine', kind: 'rehearsal' })
    expect(rehearsal).toMatchObject({ found: true, entry: { status: 'released', resolution_source: 'expired', resolved_by: null, resolved_at: NOW + PENDING_GRACE_MS, mirrored: false } })
    const live = await get<EntryResult>(stub, '/entry', { lead_key: 'lead-l', population: 'engine', kind: 'live' })
    expect(live).toMatchObject({ found: true, entry: { status: 'unresolved', resolution_source: null } })
    // The released rehearsal counts toward nothing and waits on nobody; the live one still does both.
    expect((await get<Counts>(stub, '/peek', { kind: 'rehearsal' })).hour_leads).toBe(0)
    expect((await get<Counts>(stub, '/peek', { kind: 'live' })).hour_leads).toBe(1)
    const unresolved = await get<{ entries: LedgerEntry[] }>(stub, '/unresolved')
    expect(unresolved.entries.map((e) => e.lead_key)).toEqual(['lead-l'])
    // Both changed state, so both are delivered to the mirror again.
    const unmirrored = await get<UnmirroredResult>(stub, '/unmirrored')
    expect(unmirrored.entries.map((e) => e.lead_key).sort()).toEqual(['lead-l', 'lead-r'])
  })
})

describe('BuyerLedgerObject rollover', () => {
  it('the hour bucket rolls on the clock hour while the day keeps counting', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    const limits = { ...NO_LIMITS, hourly_lead_cap: 1, daily_lead_cap: 2 }
    expect(await reserve(stub, 'a', { limits })).toMatchObject({ reserved: true })
    expect(await reserve(stub, 'b', { limits })).toMatchObject({ reserved: false, reason: 'hourly_lead_cap' })
    await setClock(stub, NOW + 3_600_000)
    expect(await reserve(stub, 'b', { limits })).toMatchObject({ reserved: true, counts: { hour_leads: 1, day_leads: 2 } })
    // The new hour has room under a looser hourly cap; the day does not.
    const dayBound = { ...NO_LIMITS, hourly_lead_cap: 5, daily_lead_cap: 2 }
    expect(await reserve(stub, 'c', { limits: dayBound })).toMatchObject({ reserved: false, reason: 'daily_lead_cap', limit: 2 })
  })

  it.each([
    // [label, last instant of the old day (UTC), first instant of the new day (UTC), old day, new day]
    ['an ordinary EDT day', Date.UTC(2027, 8, 21, 3, 59), Date.UTC(2027, 8, 21, 4, 0), '2027-09-20', '2027-09-21'],
    ['the spring forward day (midnight is still EST)', Date.UTC(2027, 2, 14, 4, 59), Date.UTC(2027, 2, 14, 5, 0), '2027-03-13', '2027-03-14'],
    ['the fall back day (midnight is still EDT)', Date.UTC(2027, 10, 7, 3, 59), Date.UTC(2027, 10, 7, 4, 0), '2027-11-06', '2027-11-07'],
    ['the day after fall back (midnight is EST again)', Date.UTC(2027, 10, 8, 4, 59), Date.UTC(2027, 10, 8, 5, 0), '2027-11-07', '2027-11-08'],
  ])('the day rolls at Eastern midnight on %s', async (_label, before, after, oldDay, newDay) => {
    const stub = ledger()
    const limits = { ...NO_LIMITS, daily_lead_cap: 1 }
    await setClock(stub, before)
    expect(await reserve(stub, 'a', { limits })).toMatchObject({ reserved: true, counts: { et_day: oldDay } })
    expect(await reserve(stub, 'b', { limits })).toMatchObject({ reserved: false, reason: 'daily_lead_cap' })
    await setClock(stub, after)
    expect(await reserve(stub, 'b', { limits })).toMatchObject({ reserved: true, counts: { et_day: newDay, day_leads: 1 } })
  })
})

describe('BuyerLedgerObject mirror and prune', () => {
  it('prunes only entries that are both resolved and mirrored, once past retention (L5)', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'mirrored-accepted')
    await post(stub, '/commit', { ...key('mirrored-accepted'), outcome: OUTCOME })
    await reserve(stub, 'unmirrored-accepted')
    await post(stub, '/commit', { ...key('unmirrored-accepted'), outcome: OUTCOME })
    await reserve(stub, 'mirrored-unresolved')
    await setClock(stub, NOW + PENDING_GRACE_MS)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const marked = await post(stub, '/mark-mirrored', { keys: [await stampOf(stub, 'mirrored-accepted'), await stampOf(stub, 'mirrored-unresolved')] })
    expect(await marked.json()).toEqual({ marked: 2, changed: 0 })
    expect((await get<UnmirroredResult>(stub, '/unmirrored')).entries.map((e) => e.lead_key)).toEqual(['unmirrored-accepted'])

    await setClock(stub, NOW + RETENTION_MS + PENDING_GRACE_MS)
    // Marking the entry mirrored armed the alarm for its retention deadline.
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(await entryOf(stub, 'mirrored-accepted')).toEqual({ found: false })
    expect(await entryOf(stub, 'unmirrored-accepted')).toMatchObject({ found: true })
    expect(await entryOf(stub, 'mirrored-unresolved')).toMatchObject({ found: true, entry: { status: 'unresolved' } })
  })
})

describe('BuyerLedgerObject marks only the state the copy read (#2422)', () => {
  it('a copy that read a reservation the attempt then released is refused its mark, and the next copy delivers the release', async () => {
    // The race that froze buyer_sales row d135dfd0 at reserved on 2026-09-30: the
    // drain read the entry reserved, the attempt's cleanup released it, and the
    // drain's mark then marked the RELEASED state copied.
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-a')
    const read = await get<UnmirroredResult>(stub, '/unmirrored')
    expect(read.entries).toMatchObject([{ lead_key: 'lead-a', status: 'reserved', resolved_at: null }])
    await setClock(stub, NOW + 1_000)
    expect((await post(stub, '/release', { ...key('lead-a'), status: 'released' })).status).toBe(200)

    const mark = await post(stub, '/mark-mirrored', { keys: [stampFrom(read.entries[0])] })
    expect(mark.status).toBe(200)
    expect(await mark.json()).toEqual({ marked: 0, changed: 1 })

    const next = await get<UnmirroredResult>(stub, '/unmirrored')
    expect(next.entries).toMatchObject([{ lead_key: 'lead-a', status: 'released', resolved_at: NOW + 1_000, mirrored: false }])
    const again = await post(stub, '/mark-mirrored', { keys: [stampFrom(next.entries[0])] })
    expect(await again.json()).toEqual({ marked: 1, changed: 0 })
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { status: 'released', mirrored: true } })
  })

  it('a reservation the alarm made unresolved before the mark is refused too: resolved_at is unchanged, the status moved', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-a')
    const read = await get<UnmirroredResult>(stub, '/unmirrored')
    await setClock(stub, NOW + PENDING_GRACE_MS)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const mark = await post(stub, '/mark-mirrored', { keys: [stampFrom(read.entries[0])] })
    expect(await mark.json()).toEqual({ marked: 0, changed: 1 })
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { status: 'unresolved', mirrored: false } })
  })

  it('a mark whose state is unchanged marks the entry copied as before, in one batch with a changed one', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'kept')
    await reserve(stub, 'moved')
    await post(stub, '/commit', { ...key('kept'), outcome: OUTCOME })
    const read = await get<UnmirroredResult>(stub, '/unmirrored')
    await setClock(stub, NOW + 1_000)
    await post(stub, '/release', { ...key('moved'), status: 'released' })
    const mark = await post(stub, '/mark-mirrored', { keys: read.entries.map(stampFrom) })
    expect(await mark.json()).toEqual({ marked: 1, changed: 1 })
    expect(await entryOf(stub, 'kept')).toMatchObject({ found: true, entry: { status: 'accepted', mirrored: true } })
    expect((await get<UnmirroredResult>(stub, '/unmirrored')).entries.map((e) => e.lead_key)).toEqual(['moved'])
  })

  it('a mark that does not say what state it copied is refused by name, so no caller can mark blind', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-a')
    const bads = [
      key('lead-a'),
      { ...key('lead-a'), status: 'pending', resolved_at: null },
      { ...key('lead-a'), status: 'reserved', resolved_at: 'later' },
      { ...key('lead-a'), status: 'reserved' },
    ]
    for (const bad of bads) {
      const res = await post(stub, '/mark-mirrored', { keys: [bad] })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'bad_keys' })
    }
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { mirrored: false } })
  })
})

describe('BuyerLedgerObject clear-mirrored re-queues one entry for the copy (#2422)', () => {
  it('clears the copied mark on a released entry and changes nothing else, so the drain copies the ledger\'s own state', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-a')
    await reserve(stub, 'lead-b')
    await setClock(stub, NOW + 1_000)
    await post(stub, '/release', { ...key('lead-a'), status: 'released' })
    await post(stub, '/mark-mirrored', { keys: [await stampOf(stub, 'lead-a')] })
    const before = await entryOf(stub, 'lead-a')
    if (!before.found) throw new Error('the released entry is missing')
    expect(before.entry).toMatchObject({ status: 'released', mirrored: true })
    const countsBefore = await peek(stub)

    const res = await post(stub, '/clear-mirrored', key('lead-a'))
    expect(res.status).toBe(200)
    const body = await res.json<{ cleared: boolean; entry: LedgerEntry }>()
    expect(body).toEqual({ cleared: true, entry: { ...before.entry, mirrored: false } })
    expect(await entryOf(stub, 'lead-a')).toEqual({ found: true, entry: { ...before.entry, mirrored: false } })
    expect(await peek(stub)).toEqual(countsBefore)
    expect((await get<UnmirroredResult>(stub, '/unmirrored')).entries.map((e) => e.lead_key).sort()).toEqual(['lead-a', 'lead-b'])

    // Asked again, it says nothing was cleared rather than claiming a second re-queue.
    const twice = await post(stub, '/clear-mirrored', key('lead-a'))
    expect(await twice.json()).toMatchObject({ cleared: false, entry: { status: 'released', mirrored: false } })
  })

  it('a re-queued entry is not pruned while it waits for the copy', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    await reserve(stub, 'lead-a')
    await post(stub, '/release', { ...key('lead-a'), status: 'released' })
    await post(stub, '/mark-mirrored', { keys: [await stampOf(stub, 'lead-a')] })
    await post(stub, '/clear-mirrored', key('lead-a'))
    await setClock(stub, NOW + RETENTION_MS + 1)
    await runDurableObjectAlarm(stub)
    expect(await entryOf(stub, 'lead-a')).toMatchObject({ found: true, entry: { status: 'released', mirrored: false } })
  })

  it('an absent entry is 404 and a malformed key is 400, by name', async () => {
    const stub = ledger()
    await setClock(stub, NOW)
    const absent = await post(stub, '/clear-mirrored', key('nobody'))
    expect(absent.status).toBe(404)
    expect(await absent.json()).toEqual({ error: 'absent' })
    const bad = await post(stub, '/clear-mirrored', { lead_key: '', population: 'engine', kind: 'live' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'bad_key' })
  })
})

describe('the minute drain against a real ledger, racing the attempt\'s release (#2422)', () => {
  let raceSeq = 0
  function drainDeps(partnerId: string, rows: Array<{ status: string }>, duringWrite: () => Promise<void>): DrainDeps {
    const rpc = async (_fn: string, args: { p_row: { id: string; status: string } }) => {
      rows.push({ status: args.p_row.status })
      await duringWrite()
      return { data: { id: args.p_row.id, status: args.p_row.status }, error: null }
    }
    return {
      listBuyers: async () => [{ partner_id: partnerId, organization_id: '22222222-2222-4222-8222-222222222222', slug: 'tripoint' }],
      ledger: (pid, opts) => new BuyerLedgerClient(bindings.BUYER_LEDGER, pid, ledgerClientOptions(opts)),
      unreadableSince: { read: async () => ({}), write: async () => {} },
      readExistingRows: async () => new Map(),
      supabase: { rpc } as never,
      notify: async () => {},
      recordRun: async () => {},
      now: () => NOW,
      localDev: false,
      log: () => {},
    }
  }

  it('a reservation released between the copy and the mark is copied again as released on the next tick', async () => {
    raceSeq += 1
    const partnerId = `race-${raceSeq}`
    const client = new BuyerLedgerClient(bindings.BUYER_LEDGER, partnerId)
    const stub = bindings.BUYER_LEDGER.get(bindings.BUYER_LEDGER.idFromName(buyerLedgerObjectName(partnerId)))
    await setClock(stub, NOW)
    const k = { lead_key: 'lead-race', population: 'engine' as const, kind: 'rehearsal' as const }
    await client.reserve({ ...k, payout_cents: 2204, execution_id: 'exec-race', limits: NO_LIMITS })

    const rows: Array<{ status: string }> = []
    let raced = false
    // The attempt's cleanup lands while the drain's write is in flight.
    const first = await runBuyerSaleDrain(drainDeps(partnerId, rows, async () => {
      if (raced) return
      raced = true
      await client.release(k, 'released')
    }))
    expect(rows).toEqual([{ status: 'reserved' }])
    expect(first.buyers[0]).toMatchObject({ pending: 1, delivered: 0, failed: 0, changed_since_read: 1 })
    expect(first.paged).toEqual([])
    expect(await client.entry(k)).toMatchObject({ found: true, entry: { status: 'released', mirrored: false } })

    const second = await runBuyerSaleDrain(drainDeps(partnerId, rows, async () => {}))
    expect(rows).toEqual([{ status: 'reserved' }, { status: 'released' }])
    expect(second.buyers[0]).toMatchObject({ pending: 1, delivered: 1, failed: 0 })
    expect(await client.entry(k)).toMatchObject({ found: true, entry: { status: 'released', mirrored: true } })
  })
})
