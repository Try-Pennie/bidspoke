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
  async release(_key: EntryKey, status: 'declined' | 'released'): Promise<LedgerEntry> {
    this.calls.push(`release:${status}`)
    return entry(status)
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

  it('a claim that does not answer is cap_check_error and touches nothing (L110)', async () => {
    const sale = new FakeSale([new DeadlineError('claim', 500) as unknown as ClaimResult])
    const ledger = new FakeLedger()
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'cap_check_error', detail: 'claim did not answer within 500 ms' })
    expect(sale.calls).toEqual(['claim:exec-1'])
    expect(ledger.calls).toEqual([])
    expect(h.buyerCalls).toBe(0)
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

  it('a reserve that does not answer frees the claim and is cap_check_error', async () => {
    const sale = new FakeSale([{ state: 'claimed', generation: 1 }])
    const ledger = new FakeLedger(new DeadlineError('reserve', 500))
    const h = harness({ sale, ledger })
    expect(await runBuyerSaleAttempt(INPUT, h.deps)).toEqual({ result: 'no_sale', reason: 'cap_check_error', detail: 'reserve did not answer within 500 ms' })
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

  it('a ledger call that runs out of time under a budget is rehearsal_deadline, not a cap check error, and holds nothing', async () => {
    const sale = claimed()
    const ledger = new FakeLedger(new DeadlineError('ledger reserve', 120))
    const h = harness({ sale, ledger })
    h.deps.budgetLeftMs = () => 120
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toMatchObject({ result: 'no_sale', reason: 'rehearsal_deadline' })
    expect(result).not.toHaveProperty('page', true)
    expect(sale.calls).toEqual(['claim:exec-1', 'free:1'])
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

  it('control: without a budget the same ledger deadline is still a cap check error, so live attempts are unchanged', async () => {
    const h = harness({ sale: claimed(), ledger: new FakeLedger(new DeadlineError('ledger reserve', 5000)) })
    const result = await runBuyerSaleAttempt(INPUT, h.deps)
    expect(result).toMatchObject({ result: 'no_sale', reason: 'cap_check_error' })
  })
})
