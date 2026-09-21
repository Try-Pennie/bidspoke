/**
 * The six step attempt against the REAL objects in workerd (#1410, L151).
 *
 * An attempt is killed after each step in turn (the step hook throws, as a
 * crash would), and the next run's behaviour is asserted for each: what the
 * ledger says, what the claim does, whether the buyer is called again. Then two
 * executions race on one free lead and on one in_doubt claim.
 *
 * The objects' clocks are moved through runInDurableObject so a claim deadline
 * or the grace period passes without waiting. The waiter's interval is short and
 * real here, because the holder it waits on is a real object finishing real work.
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../index'
import { PENDING_GRACE_MS, type BuyerLedgerObject, type LedgerEntry } from '../buyer-ledger'
import type { LeadSaleObject } from '../lead-sale'
import { BuyerLedgerClient, LeadSaleClient } from '../../lib/buyer-object-clients'
import { runBuyerSaleAttempt, type AttemptInput, type AttemptResult, type AttemptStep, type BuyerCall } from '../../lib/buyer-sale-attempt'

const bindings = env as unknown as Pick<Env, 'BUYER_LEDGER' | 'LEAD_SALE'>
const NOW = Date.UTC(2027, 8, 20, 15, 30)
const BUYER_TIMEOUT_MS = 20_000
const OUTCOME = { buyer_reference: 'TP-1', result_code: '1000', http_status: 200, payout_cents: 1500 }
const NO_LIMITS = { hourly_lead_cap: null, daily_lead_cap: null, hourly_spend_cap_cents: null, daily_spend_cap_cents: null }

let seq = 0

interface Scenario {
  input: AttemptInput
  ledger: BuyerLedgerClient
  sale: LeadSaleClient
  ledgerStub: DurableObjectStub
  saleStub: DurableObjectStub
  buyerCalls: number
  mirrored: LedgerEntry[]
  setObjectClocks: (ms: number) => Promise<void>
  run: (executionId: string, opts?: { killAfter?: AttemptStep; buyer?: BuyerCall; steps?: AttemptStep[] }) => Promise<AttemptResult>
}

function scenario(): Scenario {
  seq += 1
  const partnerId = `partner-${seq}`
  const leadKey = `lead-${seq}`
  const key = { kind: 'live' as const, population: 'engine' as const, lead_key: leadKey }
  const ledgerStub = bindings.BUYER_LEDGER.get(bindings.BUYER_LEDGER.idFromName(`buyer:${partnerId}`))
  const saleStub = bindings.LEAD_SALE.get(bindings.LEAD_SALE.idFromName(`sale:live:engine:${leadKey}`))
  const s: Scenario = {
    input: { partner_id: partnerId, execution_id: '', lead_key: leadKey, population: 'engine', kind: 'live', payout_cents: 1500, limits: NO_LIMITS },
    ledger: new BuyerLedgerClient(bindings.BUYER_LEDGER, partnerId),
    sale: new LeadSaleClient(bindings.LEAD_SALE, key),
    ledgerStub,
    saleStub,
    buyerCalls: 0,
    mirrored: [],
    setObjectClocks: async (ms) => {
      await runInDurableObject(ledgerStub, (o: BuyerLedgerObject) => { o.clock = () => ms })
      await runInDurableObject(saleStub, (o: LeadSaleObject) => { o.clock = () => ms })
    },
    run: (executionId, opts = {}) =>
      runBuyerSaleAttempt({ ...s.input, execution_id: executionId }, {
        sale: s.sale,
        ledger: s.ledger,
        callBuyer: async () => {
          s.buyerCalls += 1
          return opts.buyer ?? { outcome: 'accepted', record: OUTCOME }
        },
        mirror: async (e) => { s.mirrored.push(e) },
        clock: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        buyerTimeoutMs: BUYER_TIMEOUT_MS,
        waitIntervalMs: 20,
        onStep: (step) => {
          opts.steps?.push(step)
          if (opts.killAfter === step) throw new Error(`killed after ${step}`)
        },
      }),
  }
  return s
}

async function entryStatus(s: Scenario): Promise<string | null> {
  const found = await s.ledger.entry({ lead_key: s.input.lead_key, population: 'engine', kind: 'live' })
  return found.found ? found.entry.status : null
}

describe('an attempt killed after each step, and what the next run does (L151)', () => {
  it('after the claim alone: the ledger has nothing, the claim frees, and the next run sells once', async () => {
    const s = scenario()
    await s.setObjectClocks(NOW)
    await expect(s.run('exec-1', { killAfter: 'claimed' })).rejects.toThrow('killed after claimed')
    expect(await entryStatus(s)).toBeNull()
    expect(await s.sale.read()).toMatchObject({ state: 'in_flight', execution_id: 'exec-1' })
    // Inside the holder's deadline a second run waits on it; once past, the claim is in doubt.
    await s.setObjectClocks(NOW + BUYER_TIMEOUT_MS)
    const steps: AttemptStep[] = []
    expect(await s.run('exec-2', { steps })).toEqual({ result: 'sold', outcome: OUTCOME, replay: false, mirrored: true })
    expect(steps).toEqual(['claimed', 'reserved', 'buyer_called', 'committed', 'marked_sold', 'mirrored'])
    expect(s.buyerCalls).toBe(1)
    expect(await s.sale.read()).toMatchObject({ state: 'sold', outcome: OUTCOME })
  })

  it.each(['reserved', 'buyer_called'] as const)('after %s: the next run refuses with outcome_unknown, the entry goes unresolved at the grace deadline and still counts, and a settle frees it', async (killAfter) => {
    const s = scenario()
    await s.setObjectClocks(NOW)
    await expect(s.run('exec-1', { killAfter })).rejects.toThrow(`killed after ${killAfter}`)
    expect(await entryStatus(s)).toBe('reserved')

    await s.setObjectClocks(NOW + BUYER_TIMEOUT_MS)
    expect(await s.run('exec-2')).toEqual({ result: 'no_sale', reason: 'outcome_unknown', page: true, detail: `${s.input.partner_id} ledger entry is reserved` })
    expect(await s.sale.read()).toMatchObject({ state: 'in_doubt' })

    await s.setObjectClocks(NOW + PENDING_GRACE_MS)
    expect(await runDurableObjectAlarm(s.ledgerStub)).toBe(true)
    expect(await entryStatus(s)).toBe('unresolved')
    expect((await s.ledger.peek('live')).hour_leads).toBe(1)
    expect((await s.ledger.unresolved()).map((e) => e.lead_key)).toEqual([s.input.lead_key])
    expect((await s.ledger.unmirrored()).entries.map((e) => e.lead_key)).toEqual([s.input.lead_key])
    expect(await s.run('exec-3')).toEqual({ result: 'no_sale', reason: 'outcome_unknown', page: true, detail: `${s.input.partner_id} ledger entry is unresolved` })

    // A person settles it as released: the slot frees and the next run proceeds.
    await s.ledger.settle({ lead_key: s.input.lead_key, population: 'engine', kind: 'live' }, 'released')
    expect((await s.ledger.peek('live')).hour_leads).toBe(0)
    // The claim is still in doubt; the ledger now says released, so the run frees it and re-claims,
    // then meets the released entry as a repeat and reports the earlier answer without a second buyer call.
    expect(await s.run('exec-4')).toEqual({ result: 'no_sale', reason: 'buyer_error', detail: 'earlier attempt released' })
    expect(s.buyerCalls).toBe(killAfter === 'buyer_called' ? 1 : 0)
  })

  it('after the commit: the next run heals the claim to sold from the ledger and calls nobody', async () => {
    const s = scenario()
    await s.setObjectClocks(NOW)
    await expect(s.run('exec-1', { killAfter: 'committed' })).rejects.toThrow('killed after committed')
    expect(await entryStatus(s)).toBe('accepted')
    expect(await s.sale.read()).toMatchObject({ state: 'in_flight' })
    await s.setObjectClocks(NOW + BUYER_TIMEOUT_MS)
    expect(await s.run('exec-2')).toEqual({ result: 'sold', outcome: OUTCOME, replay: true, mirrored: false })
    expect(await s.sale.read()).toMatchObject({ state: 'sold', outcome: OUTCOME })
    expect(s.buyerCalls).toBe(1)
  })

  it('after marking sold: a replay returns the recorded outcome with no call, even inside the deadline', async () => {
    const s = scenario()
    await s.setObjectClocks(NOW)
    await expect(s.run('exec-1', { killAfter: 'marked_sold' })).rejects.toThrow('killed after marked_sold')
    expect(await s.run('exec-1')).toEqual({ result: 'sold', outcome: OUTCOME, replay: true, mirrored: false })
    expect(await s.run('exec-2')).toEqual({ result: 'sold', outcome: OUTCOME, replay: true, mirrored: false })
    expect(s.buyerCalls).toBe(1)
    // The mirror never ran, so the entry is still reported for the drain.
    expect((await s.ledger.unmirrored()).entries).toHaveLength(1)
  })

  it('after the mirror: nothing changes on a replay', async () => {
    const s = scenario()
    await s.setObjectClocks(NOW)
    await expect(s.run('exec-1', { killAfter: 'mirrored' })).rejects.toThrow('killed after mirrored')
    expect(s.mirrored).toHaveLength(1)
    expect(await s.run('exec-1')).toEqual({ result: 'sold', outcome: OUTCOME, replay: true, mirrored: false })
    expect(s.buyerCalls).toBe(1)
    expect(await entryStatus(s)).toBe('accepted')
  })
})

describe('two executions racing on one lead', () => {
  it('on a free lead: the second waits on the holder and returns its sold outcome with no second buyer call', async () => {
    const s = scenario()
    await s.setObjectClocks(NOW)
    const [a, b] = await Promise.all([s.run('exec-1'), s.run('exec-2')])
    const fresh = [a, b].filter((r) => r.result === 'sold' && !r.replay)
    const replayed = [a, b].filter((r) => r.result === 'sold' && r.replay)
    expect(fresh).toHaveLength(1)
    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toMatchObject({ outcome: OUTCOME })
    expect(s.buyerCalls).toBe(1)
    expect((await s.ledger.summary('live', '2027-09-20')).by_status.accepted).toBe(1)
  })

  it('on a free lead with the holder declining: the second meets the declined entry and the buyer is asked once', async () => {
    const s = scenario()
    await s.setObjectClocks(NOW)
    const declined: BuyerCall = { outcome: 'declined_by_buyer', record: { ...OUTCOME, result_code: '1020' } }
    const [a, b] = await Promise.all([s.run('exec-1', { buyer: declined }), s.run('exec-2', { buyer: declined })])
    expect([a, b].map((r) => r.result)).toEqual(['no_sale', 'no_sale'])
    expect([a, b].map((r) => (r as { reason: string }).reason)).toEqual(['declined_by_buyer', 'declined_by_buyer'])
    expect(s.buyerCalls).toBe(1)
    const summary = await s.ledger.summary('live', '2027-09-20')
    expect(summary.by_status.declined).toBe(1)
    expect(summary.counted_leads).toBe(0)
  })

  it('on an in_doubt claim with nothing in the ledger: exactly one frees it and reserves, the other gets that sale (L157)', async () => {
    const s = scenario()
    await s.setObjectClocks(NOW)
    await expect(s.run('exec-1', { killAfter: 'claimed' })).rejects.toThrow()
    await s.setObjectClocks(NOW + BUYER_TIMEOUT_MS)
    const [a, b] = await Promise.all([s.run('exec-2'), s.run('exec-3')])
    expect([a, b].map((r) => r.result)).toEqual(['sold', 'sold'])
    expect([a, b].filter((r) => r.result === 'sold' && !r.replay)).toHaveLength(1)
    expect(s.buyerCalls).toBe(1)
    expect((await s.ledger.summary('live', '2027-09-20')).counted_leads).toBe(1)
  })
})
