/**
 * LeadSaleObject against real SQLite storage inside workerd (#1410).
 *
 * One object per lead holds the claim that stops a lead being sold twice. Every
 * state carries a generation that moves on every transition, and every mutation
 * is a compare and set on the generation the caller read (L157): a mutation
 * whose generation has moved is refused and the caller re-reads.
 *
 * Time comes from the object's own clock, replaced here through
 * runInDurableObject and set in the future so workerd never fires anything
 * underneath the test (see buyer-ledger.workers.test.ts).
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../index'
import type { ClaimBody, ClaimResult, LeadSaleObject, SaleState } from '../lead-sale'

const bindings = env as unknown as Pick<Env, 'LEAD_SALE'>

/** 2027-09-20 15:30 UTC, a Monday, 11:30 in New York. */
const NOW = Date.UTC(2027, 8, 20, 15, 30)
const DEADLINE_MS = 20_000
const OUTCOME = { buyer_reference: 'TP-1', result_code: '1000', http_status: 200, payout_cents: 1500 }

let leadSeq = 0
function sale(kind: 'live' | 'rehearsal' = 'live'): DurableObjectStub {
  leadSeq += 1
  const id = bindings.LEAD_SALE.idFromName(`sale:${kind}:engine:lead-${leadSeq}`)
  return bindings.LEAD_SALE.get(id)
}

async function setClock(stub: DurableObjectStub, ms: number): Promise<void> {
  await runInDurableObject(stub, (instance: LeadSaleObject) => {
    instance.clock = () => ms
  })
}

function post(stub: DurableObjectStub, path: string, body: unknown): Promise<Response> {
  return stub.fetch(`http://do${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function claim(stub: DurableObjectStub, executionId: string, overrides: Partial<ClaimBody> = {}): Promise<ClaimResult> {
  const res = await post(stub, '/claim', { partner_id: 'partner-1', execution_id: executionId, deadline_ms: DEADLINE_MS, ...overrides })
  expect(res.status).toBe(200)
  return res.json<ClaimResult>()
}

async function read(stub: DurableObjectStub): Promise<SaleState> {
  const res = await stub.fetch('http://do/read')
  expect(res.status).toBe(200)
  return res.json<SaleState>()
}

describe('LeadSaleObject claim', () => {
  it('a fresh lead is free at generation 0, and the first claim takes it at generation 1', async () => {
    const stub = sale()
    await setClock(stub, NOW)
    expect(await read(stub)).toEqual({ state: 'free', generation: 0 })
    expect(await claim(stub, 'exec-1')).toEqual({ state: 'claimed', generation: 1 })
    expect(await read(stub)).toEqual({ state: 'in_flight', partner_id: 'partner-1', execution_id: 'exec-1', since: NOW, generation: 1 })
  })

  it('a second execution inside the deadline is told who holds the lead and since when', async () => {
    const stub = sale()
    await setClock(stub, NOW)
    await claim(stub, 'exec-1')
    await setClock(stub, NOW + DEADLINE_MS - 1)
    expect(await claim(stub, 'exec-2')).toEqual({ state: 'in_flight', holder_execution_id: 'exec-1', since: NOW, generation: 1 })
    // Nothing moved: the holder still holds it at the same generation.
    expect(await read(stub)).toMatchObject({ state: 'in_flight', execution_id: 'exec-1', generation: 1 })
  })

  it('an in_flight claim past its deadline becomes in_doubt, naming the partner, and the generation moves', async () => {
    const stub = sale()
    await setClock(stub, NOW)
    await claim(stub, 'exec-1')
    await setClock(stub, NOW + DEADLINE_MS)
    expect(await claim(stub, 'exec-2')).toEqual({ state: 'in_doubt', partner_id: 'partner-1', generation: 2 })
    expect(await read(stub)).toEqual({ state: 'in_doubt', partner_id: 'partner-1', generation: 2 })
  })

  it('the same execution claiming again while it holds the lead is not a rival', async () => {
    const stub = sale()
    await setClock(stub, NOW)
    await claim(stub, 'exec-1')
    expect(await claim(stub, 'exec-1')).toEqual({ state: 'claimed', generation: 1 })
  })
})

describe('LeadSaleObject sold', () => {
  it('sold stores the whole outcome and every later claim returns it with no new generation', async () => {
    const stub = sale()
    await setClock(stub, NOW)
    const claimed = await claim(stub, 'exec-1')
    const res = await post(stub, '/sold', { generation: claimed.generation, outcome: OUTCOME })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, generation: 2 })
    expect(await claim(stub, 'exec-2')).toEqual({ state: 'sold', partner_id: 'partner-1', outcome: OUTCOME, generation: 2 })
    // A replay of the original execution gets the same answer, not a second sale.
    expect(await claim(stub, 'exec-1')).toEqual({ state: 'sold', partner_id: 'partner-1', outcome: OUTCOME, generation: 2 })
  })

  it('a mutation on a generation that has moved is refused and changes nothing (L157)', async () => {
    const stub = sale()
    await setClock(stub, NOW)
    await claim(stub, 'exec-1')
    await post(stub, '/sold', { generation: 1, outcome: OUTCOME })
    const stale = await post(stub, '/free', { generation: 1 })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'generation_moved', current: { state: 'sold', partner_id: 'partner-1', outcome: OUTCOME, generation: 2 } })
    expect(await read(stub)).toMatchObject({ state: 'sold', generation: 2 })
  })
})

describe('LeadSaleObject in_doubt resolution', () => {
  it('two executions racing on one in_doubt claim: the first free wins, the second is refused, and only one can claim after', async () => {
    const stub = sale()
    await setClock(stub, NOW)
    await claim(stub, 'exec-1')
    await setClock(stub, NOW + DEADLINE_MS)
    const [a, b] = await Promise.all([claim(stub, 'exec-2'), claim(stub, 'exec-3')])
    expect(a).toEqual({ state: 'in_doubt', partner_id: 'partner-1', generation: 2 })
    expect(b).toEqual(a)
    // Both read generation 2 and both try to free it.
    const [freeA, freeB] = await Promise.all([post(stub, '/free', { generation: 2 }), post(stub, '/free', { generation: 2 })])
    const statuses = [freeA.status, freeB.status].sort()
    expect(statuses).toEqual([200, 409])
    expect(await read(stub)).toEqual({ state: 'free', generation: 3 })
    // The lead is free once, so of two racing claims exactly one is claimed.
    const [c, d] = await Promise.all([claim(stub, 'exec-2'), claim(stub, 'exec-3')])
    const claimed = [c, d].filter((r) => r.state === 'claimed')
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toEqual({ state: 'claimed', generation: 4 })
  })

  it('heal moves an in_doubt claim to sold with the ledger\'s recorded outcome, by generation', async () => {
    const stub = sale()
    await setClock(stub, NOW)
    await claim(stub, 'exec-1')
    await setClock(stub, NOW + DEADLINE_MS)
    await claim(stub, 'exec-2')
    const healed = await post(stub, '/heal', { generation: 2, outcome: OUTCOME })
    expect(healed.status).toBe(200)
    expect(await read(stub)).toEqual({ state: 'sold', partner_id: 'partner-1', outcome: OUTCOME, generation: 3 })
    // heal is only for in_doubt: on a sold claim it is refused by state.
    const again = await post(stub, '/heal', { generation: 3, outcome: OUTCOME })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: 'wrong_state', current: { state: 'sold' } })
  })

  it('a sold claim survives a later free attempt, so a live sale stays sold whatever happens to the share', async () => {
    const stub = sale()
    await setClock(stub, NOW)
    await claim(stub, 'exec-1')
    await post(stub, '/sold', { generation: 1, outcome: OUTCOME })
    const res = await post(stub, '/free', { generation: 2 })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'wrong_state', current: { state: 'sold' } })
  })
})

describe('LeadSaleObject refusals', () => {
  it('refuses malformed bodies by name', async () => {
    const stub = sale()
    const cases: Array<[string, unknown, string]> = [
      ['/claim', { partner_id: '', execution_id: 'e', deadline_ms: 1 }, 'bad_partner_id'],
      ['/claim', { partner_id: 'p', execution_id: '', deadline_ms: 1 }, 'bad_execution_id'],
      ['/claim', { partner_id: 'p', execution_id: 'e', deadline_ms: 0 }, 'bad_deadline'],
      ['/sold', { generation: 'one', outcome: OUTCOME }, 'bad_generation'],
      ['/sold', { generation: 0, outcome: { payout_cents: 'lots' } }, 'bad_outcome'],
      ['/free', {}, 'bad_generation'],
    ]
    for (const [path, body, error] of cases) {
      const res = await post(stub, path, body)
      expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(400)
      expect(await res.json()).toEqual({ error })
    }
    expect(await read(stub)).toEqual({ state: 'free', generation: 0 })
  })

  it('rehearsal claims live in their own namespace, so a rehearsal sale never blocks the live one', async () => {
    leadSeq += 1
    const live = bindings.LEAD_SALE.get(bindings.LEAD_SALE.idFromName(`sale:live:engine:lead-${leadSeq}`))
    const rehearsal = bindings.LEAD_SALE.get(bindings.LEAD_SALE.idFromName(`sale:rehearsal:engine:lead-${leadSeq}`))
    await setClock(rehearsal, NOW)
    await claim(rehearsal, 'exec-r')
    await post(rehearsal, '/sold', { generation: 1, outcome: OUTCOME })
    await setClock(live, NOW)
    expect(await claim(live, 'exec-1')).toEqual({ state: 'claimed', generation: 1 })
  })
})
