/**
 * The typed clients for BuyerLedgerObject and LeadSaleObject (#1410). Each call
 * carries a deadline (L110) with injectable timers (L524), names its object by
 * the id and never the slug (L15), and turns the objects' named refusals into
 * typed errors the attempt can branch on, rather than a status code it would
 * have to remember.
 */
import { describe, expect, it } from 'vitest'
import { DeadlineError, type Timers } from '@bidspoke/buyer-profile'
import { GenerationMovedError, WrongStateError } from '../buyer-sale-attempt'
import { BuyerLedgerClient, LeadSaleClient, MEASURED_OBJECT_CALL_P99_MS, OBJECT_CALL_DEADLINE_MS, ObjectCallError } from '../buyer-object-clients'

describe('OBJECT_CALL_DEADLINE_MS carries its evidence (#1428, L316)', () => {
  it('is set from the worst p99 the deployed drill measured, with headroom, and inside the buyer budget', () => {
    // The drill against the deployed worker records the p99 of every object
    // call. The deadline must clear the worst one seen by a margin, or a
    // latency spike on the objects reads as a false cap_check_error, and it
    // must leave most of the 20 s buyer budget for the buyer. When a new drill
    // measures a worse p99, update the measurement beside the constant and this
    // says whether the deadline still holds.
    expect(MEASURED_OBJECT_CALL_P99_MS).toBeGreaterThan(0)
    expect(OBJECT_CALL_DEADLINE_MS).toBeGreaterThanOrEqual(3 * MEASURED_OBJECT_CALL_P99_MS)
    expect(OBJECT_CALL_DEADLINE_MS).toBeLessThanOrEqual(10_000)
  })
})

/** A namespace whose one object answers with `handler`; records the names asked for and the requests made. */
function namespace(handler: (req: Request) => Promise<Response> | Response) {
  const names: string[] = []
  const requests: Request[] = []
  const ns = {
    idFromName: (name: string) => {
      names.push(name)
      return { name } as unknown as DurableObjectId
    },
    get: () => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init)
        requests.push(req)
        return Promise.resolve(handler(req))
      },
    }),
  } as unknown as DurableObjectNamespace
  return { ns, names, requests }
}

/** Timers a test fires by hand, so a deadline is proven without waiting. */
function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number }> = []
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      pending.push({ fn, ms })
      return pending.length
    },
    clearTimeout: () => undefined,
  }
  return { timers, fire: () => pending.splice(0).forEach((p) => p.fn()), pending }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const OUTCOME = { buyer_reference: 'TP-1', result_code: '1000', http_status: 200, payout_cents: 1500 }

describe('LeadSaleClient', () => {
  it('names the object by kind, population and lead key, and posts the claim body', async () => {
    const { ns, names, requests } = namespace(() => json({ state: 'claimed', generation: 1 }))
    const client = new LeadSaleClient(ns, { kind: 'rehearsal', population: 'engine', lead_key: 'lead-1' })
    const result = await client.claim({ partner_id: 'p', execution_id: 'e', deadline_ms: 20_000 })
    expect(result).toEqual({ state: 'claimed', generation: 1 })
    expect(names).toEqual(['sale:rehearsal:engine:lead-1'])
    expect(requests[0].url).toBe('http://do/claim')
    expect(await requests[0].json()).toEqual({ partner_id: 'p', execution_id: 'e', deadline_ms: 20_000 })
  })

  it('a claim that never answers rejects with a DeadlineError naming the call, at the configured deadline (L110)', async () => {
    const { ns } = namespace(() => new Promise<Response>(() => undefined))
    const { timers, fire, pending } = manualTimers()
    const client = new LeadSaleClient(ns, { kind: 'live', population: 'engine', lead_key: 'lead-1' }, { timers })
    const promise = client.claim({ partner_id: 'p', execution_id: 'e', deadline_ms: 20_000 })
    const settled = promise.catch((e: unknown) => e)
    // The literal, not the constant: this is the value decided from the deployed
    // drill's measurements (#1428), so a change to it has to be a decision here too.
    expect(pending.map((p) => p.ms)).toEqual([5_000])
    expect(OBJECT_CALL_DEADLINE_MS).toBe(5_000)
    fire()
    const err = await settled
    expect(err).toBeInstanceOf(DeadlineError)
    expect((err as DeadlineError).operation).toBe('lead sale claim')
  })

  it('a 409 generation_moved becomes a GenerationMovedError carrying the current state', async () => {
    const current = { state: 'sold', partner_id: 'p', outcome: OUTCOME, generation: 3 }
    const { ns } = namespace(() => json({ error: 'generation_moved', current }, 409))
    const client = new LeadSaleClient(ns, { kind: 'live', population: 'engine', lead_key: 'lead-1' })
    const err = await client.free(2).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GenerationMovedError)
    expect((err as GenerationMovedError).current).toEqual(current)
  })

  it('a 409 wrong_state becomes a WrongStateError', async () => {
    const current = { state: 'sold', partner_id: 'p', outcome: OUTCOME, generation: 3 }
    const { ns } = namespace(() => json({ error: 'wrong_state', current }, 409))
    const client = new LeadSaleClient(ns, { kind: 'live', population: 'engine', lead_key: 'lead-1' })
    await expect(client.heal(3, OUTCOME)).rejects.toBeInstanceOf(WrongStateError)
  })

  it('sold returns the new generation', async () => {
    const { ns, requests } = namespace(() => json({ ok: true, generation: 2 }))
    const client = new LeadSaleClient(ns, { kind: 'live', population: 'engine', lead_key: 'lead-1' })
    expect(await client.sold(1, OUTCOME)).toBe(2)
    expect(await requests[0].json()).toEqual({ generation: 1, outcome: OUTCOME })
  })

  it('any other failure is an ObjectCallError naming the call and the status, never a silent default', async () => {
    const { ns } = namespace(() => new Response('boom', { status: 500 }))
    const client = new LeadSaleClient(ns, { kind: 'live', population: 'engine', lead_key: 'lead-1' })
    const err = await client.read().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ObjectCallError)
    expect((err as Error).message).toBe('lead sale read answered 500: boom')
  })
})

describe('BuyerLedgerClient', () => {
  it('names the object by the partner id and posts the reserve body', async () => {
    const reserved = { reserved: true, repeat: false, entry: {}, counts: {} }
    const { ns, names, requests } = namespace(() => json(reserved))
    const client = new BuyerLedgerClient(ns, 'partner-uuid')
    const body = { lead_key: 'l', population: 'engine' as const, kind: 'live' as const, payout_cents: 1, execution_id: 'e', limits: { hourly_lead_cap: null, daily_lead_cap: null, hourly_spend_cap_cents: null, daily_spend_cap_cents: null } }
    expect(await client.reserve(body)).toEqual(reserved)
    expect(names).toEqual(['buyer:partner-uuid'])
    expect(requests[0].url).toBe('http://do/reserve')
    expect(await requests[0].json()).toEqual(body)
  })

  it('entry reads by query string and returns found or absent as the object said', async () => {
    const { ns, requests } = namespace(() => json({ found: false }))
    const client = new BuyerLedgerClient(ns, 'partner-uuid')
    expect(await client.entry({ lead_key: 'l', population: 'engine', kind: 'live' })).toEqual({ found: false })
    const url = new URL(requests[0].url)
    expect(url.pathname).toBe('/entry')
    expect(Object.fromEntries(url.searchParams)).toEqual({ lead_key: 'l', population: 'engine', kind: 'live' })
  })

  it('commit unwraps the entry, and a refused commit is an ObjectCallError carrying the object\'s reason', async () => {
    const entry = { lead_key: 'l', status: 'accepted' }
    let calls = 0
    const { ns } = namespace(() => (calls++ === 0 ? json({ ok: true, entry }) : json({ error: 'wrong_status', status: 'accepted' }, 409)))
    const client = new BuyerLedgerClient(ns, 'partner-uuid')
    expect(await client.commit({ lead_key: 'l', population: 'engine', kind: 'live' }, OUTCOME)).toEqual(entry)
    const err = await client.commit({ lead_key: 'l', population: 'engine', kind: 'live' }, OUTCOME).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ObjectCallError)
    expect((err as Error).message).toBe('buyer ledger commit answered 409: {"error":"wrong_status","status":"accepted"}')
  })

  it('a reserve that never answers rejects with a DeadlineError (L110)', async () => {
    const { ns } = namespace(() => new Promise<Response>(() => undefined))
    const { timers, fire } = manualTimers()
    const client = new BuyerLedgerClient(ns, 'partner-uuid', { timers, deadlineMs: 750 })
    const settled = client.peek('live').catch((e: unknown) => e)
    fire()
    const err = await settled
    expect(err).toBeInstanceOf(DeadlineError)
    expect((err as DeadlineError).ms).toBe(750)
  })
})

describe('a deadline function is told which operation is asking (#1512)', () => {
  it('lets a caller give cleanup calls their own deadline while the budget bounds the rest', async () => {
    const { timers, fire, pending } = manualTimers()
    const { ns } = namespace(() => new Promise<Response>(() => undefined))
    const client = new LeadSaleClient(ns, { kind: 'rehearsal', population: 'engine', lead_key: 'lead-1' }, { deadlineMs: (op) => (op === 'lead sale free' ? 5_000 : 50), timers })
    const claim = client.claim({ partner_id: 'p', execution_id: 'e', deadline_ms: 800 })
    expect(pending[0].ms).toBe(50)
    fire()
    await expect(claim).rejects.toBeInstanceOf(DeadlineError)
    const free = client.free(1)
    expect(pending[0].ms).toBe(5_000)
    fire()
    await expect(free).rejects.toBeInstanceOf(DeadlineError)
  })
})

describe('a deadline given as a function (#1491)', () => {
  it('is read per call, so a shrinking budget bounds each later call more tightly', async () => {
    const { timers, fire, pending } = manualTimers()
    const { ns } = namespace(() => new Promise<Response>(() => undefined))
    const budgets = [300, 50]
    const client = new LeadSaleClient(ns, { kind: 'rehearsal', population: 'engine', lead_key: 'lead-1' }, { deadlineMs: () => budgets.shift() ?? 1, timers })
    const first = client.claim({ partner_id: 'p', execution_id: 'e', deadline_ms: 800 })
    expect(pending[0].ms).toBe(300)
    fire()
    await expect(first).rejects.toBeInstanceOf(DeadlineError)
    const second = client.claim({ partner_id: 'p', execution_id: 'e', deadline_ms: 800 })
    expect(pending[0].ms).toBe(50)
    fire()
    const err = await second.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeadlineError)
    expect((err as DeadlineError).ms).toBe(50)
  })
})
