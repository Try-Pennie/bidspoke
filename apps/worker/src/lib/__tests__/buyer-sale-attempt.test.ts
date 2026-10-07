/**
 * runBuyerSaleAttempt (#1410): the six step attempt the buyer_select node
 * drives per buyer, here against in memory fakes of the two objects so every
 * decision the orchestrator makes is asserted in milliseconds. The same steps
 * run against the real objects in durable-objects/__tests__/buyer-attempt.workers.test.ts.
 *
 * Attempt order: claim the lead, reserve at the buyer, call the buyer, commit,
 * mark sold, mirror. Each step names what a failure at that point means, and
 * the waiter for a lead another execution holds takes its sleep and clock as
 * parameters, so its schedule is asserted, never waited for (L524).
 */
import { describe, expect, it } from 'vitest'
import { DeadlineError } from '@bidspoke/buyer-profile'
import type { ClaimBody, ClaimResult } from '../../durable-objects/lead-sale'
import type { EntryKey, EntryResult, LedgerEntry, ReserveBody, ReserveResult, SaleOutcomeRecord } from '../../durable-objects/buyer-ledger'
import {
  GenerationMovedError,
  runBuyerSaleAttempt,
  type AttemptDeps,
  type AttemptInput,
  type AttemptStep,
  type BuyerCall,
  type LedgerApi,
  type SaleApi,
} from '../buyer-sale-attempt'

const OUTCOME: SaleOutcomeRecord = { buyer_reference: 'TP-1', result_code: '1000', http_status: 200, payout_cents: 1500 }
const NOW = Date.UTC(2027, 8, 20, 15, 30)

const INPUT: AttemptInput = {
  partner_id: 'partner-1',
  execution_id: 'exec-1',
  lead_key: 'lead-1',
  population: 'engine',
  kind: 'live',
  payout_cents: 1500,
  limits: { hourly_lead_cap: null, daily_lead_cap: null, hourly_spend_cap_cents: null, daily_spend_cap_cents: null },
}

function entry(status: LedgerEntry['status'], outcome: SaleOutcomeRecord | null = null): LedgerEntry {
  return {
    lead_key: 'lead-1', population: 'engine', kind: 'live', payout_cents: 1500, status,
    et_day: '2027-09-20', hour_bucket: Math.floor(NOW / 3_600_000), reserved_at: NOW, resolved_at: null,
    mirrored: false, execution_id: 'exec-1', outcome, resolution_source: null, resolved_by: null,
  }
}

/** A scripted claim object: answers claims from a queue, records every call. */
class FakeSale implements SaleApi {
  calls: string[] = []
  constructor(private claims: ClaimResult[], private refuse: Partial<Record<'sold' | 'free' | 'heal', Error>> = {}) {}
  async claim(body: ClaimBody): Promise<ClaimResult> {
    this.calls.push(`claim:${body.execution_id}`)
    const next = this.claims.length > 1 ? this.claims.shift() : this.claims[0]
    if (!next) throw new Error('fake sale ran out of script')
    if (next instanceof Error) throw next
    return next
  }
  async sold(generation: number, outcome: SaleOutcomeRecord): Promise<number> {
    this.calls.push(`sold:${generation}:${outcome.result_code}`)
    if (this.refuse.sold) throw this.refuse.sold
    return generation + 1
  }
  async free(generation: number): Promise<number> {
    this.calls.push(`free:${generation}`)
    if (this.refuse.free) throw this.refuse.free
    return generation + 1
  }
  async heal(generation: number, outcome: SaleOutcomeRecord): Promise<number> {
    this.calls.push(`heal:${generation}:${outcome.result_code}`)
    if (this.refuse.heal) throw this.refuse.heal
    return generation + 1
  }
}

class FakeLedger implements LedgerApi {
  calls: string[] = []
  constructor(
    private reserveResult: ReserveResult | Error = { reserved: true, repeat: false, entry: entry('reserved'), counts: { hour_leads: 1, day_leads: 1, hour_spend_cents: 1500, day_spend_cents: 1500, et_day: '2027-09-20', hour_bucket: 0 } },
    private entryResult: EntryResult | Error = { found: false },
    private commitError: Error | null = null
  ) {}
  async reserve(body: ReserveBody): Promise<ReserveResult> {
    this.calls.push(`reserve:${body.lead_key}`)
    if (this.reserveResult instanceof Error) throw this.reserveResult
    return this.reserveResult
  }
  async commit(_key: EntryKey, outcome: SaleOutcomeRecord): Promise<LedgerEntry> {
    this.calls.push(`commit:${outcome.result_code}`)
    if (this.commitError) throw this.commitError
    return entry('accepted', outcome)
  }
  released: (SaleOutcomeRecord | undefined)[] = []
  releaseError: Error | null = null
  async release(_key: EntryKey, status: 'declined' | 'released', outcome?: SaleOutcomeRecord): Promise<LedgerEntry> {
    this.calls.push(`release:${status}`)
    this.released.push(outcome)
    if (this.releaseError) throw this.releaseError
    return entry(status, outcome)
  }
  async entry(_key: EntryKey): Promise<EntryResult> {
    this.calls.push('entry')
    if (this.entryResult instanceof Error) throw this.entryResult
    return this.entryResult
  }
}

interface Harness {
  deps: AttemptDeps
  steps: AttemptStep[]
  sleeps: number[]
  buyerCalls: number
  mirrored: LedgerEntry[]
}

function harness(opts: {
  sale: SaleApi
  ledger: LedgerApi
  buyer?: BuyerCall | Error
  mirrorError?: Error
  buyerTimeoutMs?: number
  waitIntervalMs?: number
  killAfter?: AttemptStep
}): Harness {
  let now = NOW
  const h: Harness = { steps: [], sleeps: [], buyerCalls: 0, mirrored: [], deps: undefined as unknown as AttemptDeps }
  h.deps = {
    sale: opts.sale,
    ledger: opts.ledger,
    callBuyer: async () => {
      h.buyerCalls += 1
      if (opts.buyer instanceof Error) throw opts.buyer
      return opts.buyer ?? { outcome: 'accepted', record: OUTCOME }
    },
    mirror: async (e) => {
      if (opts.mirrorError) throw opts.mirrorError
      h.mirrored.push(e)
    },
    clock: () => now,
    // The fake sleep advances the clock by the requested delay and records it.
    sleep: async (ms) => {
      h.sleeps.push(ms)
      now += ms
    },
    buyerTimeoutMs: opts.buyerTimeoutMs ?? 20_000,
    waitIntervalMs: opts.waitIntervalMs ?? 250,
    onStep: (step) => {
      h.steps.push(step)
      if (opts.killAfter === step) throw new Error(`killed after ${step}`)
    },
  }
  return h
}

describe('runBuyerSaleAttempt happy path', () => {
  it('claims, reserves, calls, commits, marks sold and mirrors, in that order', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toEqual({ result: 'sold', outcome: OUTCOME, replay: false, mirrored: true })
    expect(h.steps).toEqual(['claimed', 'reserved', 'buyer_called', 'committed', 'marked_sold', 'mirrored'])
    expect(sale.calls).toEqual(['claim:exec-1', 'sold:1:1000'])
    expect(ledger.calls).toEqual(['reserve:lead-1', 'commit:1000'])
    expect(h.buyerCalls).toBe(1)
    expect(h.mirrored).toHaveLength(1)
  })

  it('a mirror failure leaves the sale sold and says the mirror did not land', async () => {
    const h = harness({ sale: new FakeSale([{ state: 'claimed', generation: 1 }]), ledger: new FakeLedger(), mirrorError: new Error('supabase down') })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'sold', outcome: OUTCOME, replay: false, mirrored: false })
  })
})

describe('runBuyerSaleAttempt claim outcomes', () => {
  it('a sold claim returns the recorded outcome with no buyer call and no reservation', async () => {
    const sale = new FakeSale([{ state: 'sold', partner_id: 'partner-1', outcome: OUTCOME, generation: 2 }])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'sold', outcome: OUTCOME, replay: true, mirrored: false })
    expect(h.buyerCalls).toBe(0)
    expect(ledger.calls).toEqual([])
  })

  it('a claim that does not answer is object_deadline, named for what happened, and touches nothing (L110, #1530)', async () => {
    const sale = new FakeSale([new DeadlineError('lead sale claim', 500) as unknown as ClaimResult])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'object_deadline', detail: 'lead sale claim did not answer within 500 ms' })
    expect(sale.calls).toEqual(['claim:exec-1'])
    expect(ledger.calls).toEqual([])
    expect(h.buyerCalls).toBe(0)
  })

  it('a claim that fails with anything but a deadline is still cap_check_error: the object answered, with an error', async () => {
    const sale = new FakeSale([new Error('lead sale 500') as unknown as ClaimResult])
    const h = harness({ sale, ledger: new FakeLedger() })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'cap_check_error', detail: 'lead sale 500' })
  })
})

describe('runBuyerSaleAttempt waiting on a holder (sale_in_flight, L524)', () => {
  it('polls the claim on the interval and returns the holder\'s sold outcome with no buyer call', async () => {
    const inFlight: ClaimResult = { state: 'in_flight', holder_execution_id: 'exec-0', since: NOW - 1000, generation: 1 }
    const sale = new FakeSale([inFlight, inFlight, { state: 'sold', partner_id: 'partner-1', outcome: OUTCOME, generation: 2 }])
    const h = harness({ sale, ledger: new FakeLedger() })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'sold', outcome: OUTCOME, replay: true, mirrored: false })
    expect(h.sleeps).toEqual([250, 250])
    expect(h.buyerCalls).toBe(0)
  })

  it('proceeds through a normal attempt once the holder frees the lead', async () => {
    const inFlight: ClaimResult = { state: 'in_flight', holder_execution_id: 'exec-0', since: NOW - 1000, generation: 1 }
    const sale = new FakeSale([inFlight, { state: 'claimed', generation: 3 }])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toMatchObject({ result: 'sold', replay: false })
    expect(h.sleeps).toEqual([250])
    expect(ledger.calls).toEqual(['reserve:lead-1', 'commit:1000'])
    expect(sale.calls).toEqual(['claim:exec-1', 'claim:exec-1', 'sold:3:1000'])
  })

  it('gives up at the remaining buyer timeout with sale_in_flight, holding nothing', async () => {
    const inFlight: ClaimResult = { state: 'in_flight', holder_execution_id: 'exec-0', since: NOW - 1000, generation: 1 }
    const sale = new FakeSale([inFlight])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger, buyerTimeoutMs: 1000, waitIntervalMs: 250 })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'sale_in_flight', detail: 'exec-0 held the lead past the 1000 ms budget' })
    // Four intervals fill the budget; the fifth poll would start past it.
    expect(h.sleeps).toEqual([250, 250, 250, 250])
    expect(ledger.calls).toEqual([])
    expect(h.buyerCalls).toBe(0)
    expect(sale.calls.filter((c) => c.startsWith('free'))).toEqual([])
  })
})

describe('runBuyerSaleAttempt on an in_doubt claim (L151, L105)', () => {
  const inDoubt: ClaimResult = { state: 'in_doubt', partner_id: 'partner-1', generation: 2 }

  it('ledger says accepted: heals the claim to sold and returns the prior outcome', async () => {
    const sale = new FakeSale([inDoubt])
    const ledger = new FakeLedger(undefined, { found: true, entry: entry('accepted', OUTCOME) })
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'sold', outcome: OUTCOME, replay: true, mirrored: false })
    expect(sale.calls).toEqual(['claim:exec-1', 'heal:2:1000'])
    expect(h.buyerCalls).toBe(0)
  })

  it.each([['released'], ['declined']] as const)('ledger says %s: frees the claim and re-claims', async (status) => {
    const sale = new FakeSale([inDoubt, { state: 'claimed', generation: 3 }])
    const ledger = new FakeLedger(undefined, { found: true, entry: entry(status) })
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toMatchObject({ result: 'sold', replay: false })
    expect(sale.calls.slice(0, 3)).toEqual(['claim:exec-1', 'free:2', 'claim:exec-1'])
  })

  it('ledger says absent: the crash came before the reserve, so the claim frees and the attempt proceeds', async () => {
    const sale = new FakeSale([inDoubt, { state: 'claimed', generation: 3 }])
    const ledger = new FakeLedger(undefined, { found: false })
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toMatchObject({ result: 'sold', replay: false })
    expect(sale.calls.slice(0, 3)).toEqual(['claim:exec-1', 'free:2', 'claim:exec-1'])
    expect(ledger.calls).toEqual(['entry', 'reserve:lead-1', 'commit:1000'])
  })

  it.each([['reserved'], ['unresolved']] as const)('ledger says %s: refuses with outcome_unknown and keeps the claim', async (status) => {
    const sale = new FakeSale([inDoubt])
    const ledger = new FakeLedger(undefined, { found: true, entry: entry(status) })
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'outcome_unknown', page: true, detail: `partner-1 ledger entry is ${status}` })
    expect(sale.calls).toEqual(['claim:exec-1'])
    expect(h.buyerCalls).toBe(0)
  })

  it('ledger unreadable: refuses with cap_check_error and keeps the claim', async () => {
    const sale = new FakeSale([inDoubt])
    const ledger = new FakeLedger(undefined, new Error('ledger 500'))
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'cap_check_error', detail: 'ledger 500' })
    expect(sale.calls).toEqual(['claim:exec-1'])
  })

  it('a free refused because the generation moved re-reads the claim rather than assuming (L157)', async () => {
    const sale = new FakeSale(
      [inDoubt, { state: 'sold', partner_id: 'partner-1', outcome: OUTCOME, generation: 3 }],
      { free: new GenerationMovedError({ state: 'sold', partner_id: 'partner-1', outcome: OUTCOME, generation: 3 }) }
    )
    const ledger = new FakeLedger(undefined, { found: false })
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'sold', outcome: OUTCOME, replay: true, mirrored: false })
    expect(sale.calls).toEqual(['claim:exec-1', 'free:2', 'claim:exec-1'])
  })
})

describe('runBuyerSaleAttempt reserve outcomes', () => {
  it('a cap refusal frees the claim and names the cap', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const counts = { hour_leads: 3, day_leads: 3, hour_spend_cents: 0, day_spend_cents: 0, et_day: '2027-09-20', hour_bucket: 0 }
    const ledger = new FakeLedger({ reserved: false, reason: 'daily_lead_cap', limit: 3, counts })
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'daily_lead_cap', detail: '3 of 3' })
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
    expect(h.buyerCalls).toBe(0)
  })

  it('a reserve that does not answer is object_deadline: it releases the reservation it may have landed, then frees the claim (#1512, #1530)', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger(new DeadlineError('buyer ledger reserve', 500))
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'object_deadline', detail: 'buyer ledger reserve did not answer within 500 ms' })
    expect(ledger.calls).toEqual(['reserve:lead-1', 'release:released'])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
    expect(h.buyerCalls).toBe(0)
  })

  it('a reserve that fails with anything but a deadline is cap_check_error, and is released and freed the same way', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger(new Error('ledger 500'))
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'cap_check_error', detail: 'ledger 500' })
    expect(ledger.calls).toEqual(['reserve:lead-1', 'release:released'])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
  })

  it('a repeat reservation already accepted is the earlier sale: the claim is marked sold and nothing is called', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const counts = { hour_leads: 1, day_leads: 1, hour_spend_cents: 1500, day_spend_cents: 1500, et_day: '2027-09-20', hour_bucket: 0 }
    const ledger = new FakeLedger({ reserved: true, repeat: true, entry: entry('accepted', OUTCOME), counts })
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'sold', outcome: OUTCOME, replay: true, mirrored: false })
    expect(sale.calls).toEqual(['claim:exec-1', 'sold:1:1000'])
    expect(h.buyerCalls).toBe(0)
  })

  it('a repeat reservation still pending is outcome_unknown, not a second buyer call', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const counts = { hour_leads: 1, day_leads: 1, hour_spend_cents: 1500, day_spend_cents: 1500, et_day: '2027-09-20', hour_bucket: 0 }
    const ledger = new FakeLedger({ reserved: true, repeat: true, entry: entry('reserved'), counts })
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'outcome_unknown', page: true, detail: 'partner-1 ledger entry is reserved' })
    expect(h.buyerCalls).toBe(0)
  })
})

describe('runBuyerSaleAttempt buyer outcomes', () => {
  it('declined: the entry is declined, the claim freed, and the reason is declined_by_buyer', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger, buyer: { outcome: 'declined_by_buyer', record: { ...OUTCOME, result_code: '1020' } } })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'declined_by_buyer', detail: '1020' })
    expect(ledger.calls).toEqual(['reserve:lead-1', 'release:declined'])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
  })

  it('buyer_error: the entry is released, the claim freed', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger, buyer: { outcome: 'buyer_error', record: { ...OUTCOME, http_status: 403, result_code: null } } })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'buyer_error', detail: 'http 403' })
    expect(ledger.calls).toEqual(['reserve:lead-1', 'release:released'])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
  })

  it('declined: the buyer\'s answer is kept on the entry and copied to buyer_sales at once (#1735)', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    const record = { ...OUTCOME, result_code: '1003', buyer_reference: 'tp-lead-9', http_status: 200 }
    const h = harness({ sale, ledger, buyer: { outcome: 'declined_by_buyer', record } })
    await runBuyerSaleAttempt(INPUT, h.deps)
    expect(ledger.released).toEqual([record])
    expect(h.mirrored).toHaveLength(1)
    expect(h.mirrored[0]).toMatchObject({ status: 'declined', outcome: record })
  })

  it('buyer_error: the answer the buyer gave is kept and copied too (#1735)', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    const record = { ...OUTCOME, http_status: 403, result_code: null }
    const h = harness({ sale, ledger, buyer: { outcome: 'buyer_error', record } })
    await runBuyerSaleAttempt(INPUT, h.deps)
    expect(ledger.released).toEqual([record])
    expect(h.mirrored[0]).toMatchObject({ status: 'released', outcome: record })
  })

  it('declined: the claim is freed BEFORE the copy, so a slow buyer_sales write never holds the lead (#1735)', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger, buyer: { outcome: 'declined_by_buyer', record: { ...OUTCOME, result_code: '1003' } } })
    let callsAtCopy: string[] = []
    const copy = h.deps.mirror
    h.deps.mirror = async (e) => { callsAtCopy = [...sale.calls]; await copy(e) }
    await runBuyerSaleAttempt(INPUT, h.deps)
    expect(callsAtCopy).toEqual(['claim:exec-1', 'free:1'])
  })

  it('declined: a failed copy is left to the drain and never changes the answer (#1735)', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger, buyer: { outcome: 'declined_by_buyer', record: { ...OUTCOME, result_code: '1003' } }, mirrorError: new Error('supabase down') })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'declined_by_buyer', detail: '1003' })
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
  })

  it('declined: a release that fails copies nothing and still frees the claim (#1735)', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    ledger.releaseError = new Error('ledger unreachable')
    const h = harness({ sale, ledger, buyer: { outcome: 'declined_by_buyer', record: { ...OUTCOME, result_code: '1003' } } })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'declined_by_buyer', detail: '1003' })
    expect(h.mirrored).toEqual([])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
  })

  // The node times each object call from these steps (#1804), so an answered decline reports
  // the release (with the claim freed) and the copy as steps of their own.
  it.each(['declined_by_buyer', 'buyer_error'] as const)('%s: reports released once the entry is released and the claim freed, then mirrored', async (outcome) => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger, buyer: { outcome, record: { ...OUTCOME, result_code: '1003' } } })
    let callsAtReleased: string[] = []
    const onStep = h.deps.onStep!
    h.deps.onStep = (s) => { if (s === 'released') callsAtReleased = [...sale.calls]; return onStep(s) }
    await runBuyerSaleAttempt(INPUT, h.deps)
    expect(h.steps).toEqual(['claimed', 'reserved', 'buyer_called', 'released', 'mirrored'])
    expect(callsAtReleased).toEqual(['claim:exec-1', 'free:1'])
  })

  it('declined: a release that fails reports no released step, because nothing was released', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    ledger.releaseError = new Error('ledger unreachable')
    const h = harness({ sale, ledger, buyer: { outcome: 'declined_by_buyer', record: { ...OUTCOME, result_code: '1003' } } })
    await runBuyerSaleAttempt(INPUT, h.deps)
    expect(h.steps).toEqual(['claimed', 'reserved', 'buyer_called'])
  })

  it('declined: a copy that fails reports no mirrored step', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger, buyer: { outcome: 'declined_by_buyer', record: { ...OUTCOME, result_code: '1003' } }, mirrorError: new Error('supabase down') })
    await runBuyerSaleAttempt(INPUT, h.deps)
    expect(h.steps).toEqual(['claimed', 'reserved', 'buyer_called', 'released'])
  })

  it('outcome_unknown: reservation and claim are both HELD, and the result pages', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger, buyer: { outcome: 'outcome_unknown', record: { ...OUTCOME, result_code: null, http_status: 200 } } })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'outcome_unknown', page: true, detail: 'buyer answered http 200 and no rule matched' })
    expect(ledger.calls).toEqual(['reserve:lead-1'])
    expect(sale.calls).toEqual(['claim:exec-1'])
  })

  it('a buyer call that throws is buyer_error when it never reached the buyer', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger, buyer: new Error('ECONNREFUSED') })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'buyer_error', detail: 'ECONNREFUSED' })
    expect(ledger.calls).toEqual(['reserve:lead-1', 'release:released'])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
  })

  it('a commit that does not answer after an accept is outcome_unknown with everything held', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger(undefined, undefined, new DeadlineError('commit', 500))
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'outcome_unknown', page: true, detail: 'commit did not answer within 500 ms' })
    expect(sale.calls).toEqual(['claim:exec-1'])
    expect(ledger.calls).toEqual(['reserve:lead-1', 'commit:1000'])
  })

  it('a mark sold that does not answer after a commit is outcome_unknown with everything held', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }], { sold: new DeadlineError('sold', 500) })
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'outcome_unknown', page: true, detail: 'sold did not answer within 500 ms' })
    expect(h.mirrored).toEqual([])
  })
})

describe('runBuyerSaleAttempt when the process dies (the kill hook)', () => {
  it('a throw from the step hook propagates, so the Workers suite can kill an attempt after each step', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger, killAfter: 'reserved' })
    await expect(runBuyerSaleAttempt(INPUT, h.deps)).rejects.toThrow('killed after reserved')
    expect(h.buyerCalls).toBe(0)
    expect(ledger.calls).toEqual(['reserve:lead-1'])
  })
})

describe('a budgeted attempt (decide only, #1491)', () => {
  const claimed = () => new FakeSale([{ state: 'claimed', generation: 1 }])

  it('a budget already spent after the claim frees the claim, reserves nothing and reports rehearsal_deadline', async () => {
    const sale = claimed()
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    h.deps.budgetLeftMs = () => 0
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toMatchObject({ result: 'no_sale', reason: 'rehearsal_deadline' })
    expect(ledger.calls).toEqual([])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
    expect(h.buyerCalls).toBe(0)
  })

  it('a budget spent after the reservation releases it, frees the claim and never calls the buyer', async () => {
    const sale = claimed()
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    const left = [100, 0]
    h.deps.budgetLeftMs = () => left.shift() ?? 0
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toMatchObject({ result: 'no_sale', reason: 'rehearsal_deadline' })
    expect(ledger.calls).toEqual(['reserve:lead-1', 'release:released'])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
    expect(h.buyerCalls).toBe(0)
  })

  it('a reserve that runs out of time under a budget is rehearsal_deadline, not a cap check error, and RELEASES the reservation it may have landed before freeing the claim (#1512)', async () => {
    const sale = claimed()
    const ledger = new FakeLedger(new DeadlineError('ledger reserve', 120))
    const h = harness({ sale, ledger })
    h.deps.budgetLeftMs = () => 120
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toMatchObject({ result: 'no_sale', reason: 'rehearsal_deadline' })
    expect(result).not.toHaveProperty('page', true)
    expect(ledger.calls).toEqual(['reserve:lead-1', 'release:released'])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
  })

  it('hands the cleanup after a budget ending to the background hook when one is given, so the caller is not kept waiting on it', async () => {
    const sale = claimed()
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    const left = [100, 0]
    h.deps.budgetLeftMs = () => left.shift() ?? 0
    const handed: Promise<void>[] = []
    h.deps.background = (work) => { handed.push(work) }
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toMatchObject({ result: 'no_sale', reason: 'rehearsal_deadline' })
    expect(handed).toHaveLength(1)
    await handed[0]
    expect(ledger.calls).toEqual(['reserve:lead-1', 'release:released'])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
    expect(h.buyerCalls).toBe(0)
  })

  it('a commit that runs out of time under a budget releases the reservation and frees the claim instead of holding and paging', async () => {
    const sale = claimed()
    const ledger = new FakeLedger(undefined, undefined, new DeadlineError('ledger commit', 90))
    const h = harness({ sale, ledger })
    h.deps.budgetLeftMs = () => 500
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toMatchObject({ result: 'no_sale', reason: 'rehearsal_deadline' })
    expect(result).not.toHaveProperty('page', true)
    expect(ledger.calls).toEqual(['reserve:lead-1', 'commit:1000', 'release:released'])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
  })

  it('a mark sold that runs out of time under a budget is rehearsal_deadline without a page: the entry is committed and the claim heals itself', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }], { sold: new DeadlineError('sale sold', 40) })
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    h.deps.budgetLeftMs = () => 400
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toMatchObject({ result: 'no_sale', reason: 'rehearsal_deadline' })
    expect(result).not.toHaveProperty('page', true)
    expect(ledger.calls).toEqual(['reserve:lead-1', 'commit:1000'])
    expect(sale.calls).toEqual(['claim:exec-1', 'sold:1:1000'])
  })

  it('control: without a rehearsal budget the same ledger deadline is object_deadline, never rehearsal_deadline, and the reservation it may have landed is released too (#1512)', async () => {
    const sale = claimed()
    const ledger = new FakeLedger(new DeadlineError('ledger reserve', 5000))
    const h = harness({ sale, ledger })
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toMatchObject({ result: 'no_sale', reason: 'object_deadline' })
    expect(ledger.calls).toEqual(['reserve:lead-1', 'release:released'])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
  })

  it('a claim that runs out of time under the rehearsal budget is rehearsal_deadline too, not a cap check error: the 22 rows of 2026-09-24 (#1530)', async () => {
    const sale = new FakeSale([new DeadlineError('lead sale claim', 533) as unknown as ClaimResult])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    h.deps.budgetLeftMs = () => 533
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toMatchObject({ result: 'no_sale', reason: 'rehearsal_deadline' })
    expect(ledger.calls).toEqual([])
    expect(h.buyerCalls).toBe(0)
  })
})

/**
 * #1508: in live the steps BEFORE the buyer call share one budget, read between
 * steps like the rehearsal one, but a spent budget is object_deadline (a live
 * out reason the execution view labels), the cleanup is awaited because money
 * is about to move, and the budget stops at the buyer call: commit and mark
 * sold keep their own deadlines and the outcome_unknown page, because an
 * accepted buyer answer must still be recorded whatever the clock says.
 */
describe('a live attempt bounded before the buyer call (#1508)', () => {
  const claimed = () => new FakeSale([{ state: 'claimed', generation: 1 }])

  it('a pre-call budget already spent after the claim frees the claim, reserves nothing and reports object_deadline', async () => {
    const sale = claimed()
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    h.deps.preCallBudgetLeftMs = () => 0
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toEqual({ result: 'no_sale', reason: 'object_deadline', detail: 'the pre-call budget ran out after the claim' })
    expect(ledger.calls).toEqual([])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
    expect(h.buyerCalls).toBe(0)
  })

  it('a pre-call budget spent after the reservation releases it, frees the claim and never calls the buyer', async () => {
    const sale = claimed()
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    const left = [900, 0]
    h.deps.preCallBudgetLeftMs = () => left.shift() ?? 0
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toEqual({ result: 'no_sale', reason: 'object_deadline', detail: 'the pre-call budget ran out after the reservation' })
    expect(ledger.calls).toEqual(['reserve:lead-1', 'release:released'])
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
    expect(h.buyerCalls).toBe(0)
  })

  it('the wait on another holder stops at the pre-call budget, not the buyer timeout, and holds nothing', async () => {
    const inFlight: ClaimResult = { state: 'in_flight', holder_execution_id: 'exec-0', since: NOW - 1000, generation: 1 }
    const sale = new FakeSale([inFlight])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger, buyerTimeoutMs: 20_000, waitIntervalMs: 250 })
    // The budget is read off the same clock the fake sleep advances, so the wait ends by the clock, never by a counter.
    const start = h.deps.clock()
    h.deps.preCallBudgetLeftMs = () => 600 - (h.deps.clock() - start)
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'sale_in_flight', detail: 'exec-0 held the lead for the whole pre-call budget' })
    // Two intervals fit inside 600 ms; the third would start with 100 ms left, less than an interval.
    expect(h.sleeps).toEqual([250, 250])
    expect(ledger.calls).toEqual([])
    expect(h.buyerCalls).toBe(0)
  })

  it('once the buyer has been called the budget no longer applies: a commit that does not answer is outcome_unknown, everything held, paged', async () => {
    const sale = claimed()
    const ledger = new FakeLedger(undefined, undefined, new DeadlineError('buyer ledger commit', 5000))
    const h = harness({ sale, ledger })
    h.deps.preCallBudgetLeftMs = () => 0.5
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toMatchObject({ result: 'no_sale', reason: 'outcome_unknown', page: true })
    expect(h.buyerCalls).toBe(1)
    expect(ledger.calls).toEqual(['reserve:lead-1', 'commit:1000'])
    expect(sale.calls).toEqual(['claim:exec-1'])
  })

  it('with budget to spare the attempt runs to a sale exactly as an unbudgeted one does', async () => {
    const sale = claimed()
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    h.deps.preCallBudgetLeftMs = () => 1500
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'sold', outcome: OUTCOME, replay: false, mirrored: true })
    expect(h.steps).toEqual(['claimed', 'reserved', 'buyer_called', 'committed', 'marked_sold', 'mirrored'])
  })
})
