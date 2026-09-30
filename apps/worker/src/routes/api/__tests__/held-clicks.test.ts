/**
 * Held click routes (#1552): the clicks buyer_click_send left held, listed for
 * one buyer, and a person's two releases.
 *
 *   mark sent   the person confirmed in the buyer's system that the lead exists:
 *               heal the claim to sold with the lead id they give, count the
 *               prospect on the Pacific day the click was held
 *   free        the buyer does not have it: free the claim so the next click sends
 *   clear       a list entry whose claim is no longer held is removed
 *
 * The claim object is the authority, and every release is a compare and set on
 * the generation the page read, so a stale page is refused by name. The list
 * entry is removed only while it is still the hold the route read, and every
 * release is audited with the claim's old and new state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'
import type { SaleState } from '../../../durable-objects/lead-sale'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/held-click-sale-writes', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/held-click-sale-writes')>('../../../lib/held-click-sale-writes')
  return { ...actual, writeHeldClickSale: vi.fn() }
})
const saleStub = { read: vi.fn(), heal: vi.fn(), free: vi.fn() }
const counterStub = { addMember: vi.fn(), date: '2027-09-20' }
vi.mock('../../../lib/buyer-object-clients', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/buyer-object-clients')>('../../../lib/buyer-object-clients')
  return {
    ...actual,
    // Plain functions, not arrows: the route constructs the clients with `new`.
    LeadSaleClient: vi.fn(function () { return saleStub }),
    ClickCounterClient: vi.fn(function () { return counterStub }),
  }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { ClickCounterClient, LeadSaleClient } from '../../../lib/buyer-object-clients'
import { GenerationMovedError, WrongStateError } from '../../../lib/buyer-sale-attempt'
import { writeHeldClickSale, type SaleWrites } from '../../../lib/held-click-sale-writes'
import { makeSupabase, type TableConfig } from './_supabase-mock'

const testUser = { id: '22222222-2222-4222-8222-222222222222', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: testUser.id, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, LEAD_SALE: {}, DAILY_CAP: {} } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

const PARTNER = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'
const ROW_ID = '55555555-5555-4555-8555-555555555501'
const PROSPECT = 'a0B000000000001AAA'
const LEAD_ID = 'a0B5f00000XyZ12AAB'
const HELD_AT = '2027-09-20T18:00:00.000Z'
const NOW = Date.UTC(2027, 8, 22, 18, 0)

const heldRow = {
  id: ROW_ID, organization_id: 'org-abc', partner_id: PARTNER, prospect_id: PROSPECT, reason: 'outcome_unknown',
  detail: 'no answer from the buyer: The operation was aborted', partner_lead_id: null, workflow_id: '44444444-4444-4444-8444-444444444444',
  execution_id: 'exec-1', trace_id: 'trace-1', held_at: HELD_AT, last_execution_id: 'exec-1', last_seen_at: HELD_AT,
}

const inDoubt: SaleState = { state: 'in_doubt', partner_id: PARTNER, generation: 2 }
const soldAs = (ref: string | null, generation = 3): SaleState => ({ state: 'sold', partner_id: PARTNER, outcome: { buyer_reference: ref, result_code: 'marked_sent', http_status: null, payout_cents: 0 }, generation })

const SUBMISSION = 'a0C000000000001AAA'
const SF_LEAD = '00Q000000000001AAA'
const allWritten: SaleWrites = {
  complete: true,
  records_from: 'step_log',
  writes: [
    { record: 'prospect', object: 'Prospect__c', id: PROSPECT, outcome: 'written' },
    { record: 'submission', object: 'Submission__c', id: SUBMISSION, outcome: 'written' },
    { record: 'lead', object: 'Lead', id: SF_LEAD, outcome: 'written' },
  ],
}
const submissionFailed: SaleWrites = {
  complete: false,
  records_from: 'step_log',
  writes: [
    { record: 'prospect', object: 'Prospect__c', id: PROSPECT, outcome: 'written' },
    { record: 'submission', object: 'Submission__c', id: SUBMISSION, outcome: 'failed', message: 'Salesforce refused the Submission__c update (400): FIELD_CUSTOM_VALIDATION_EXCEPTION' },
    { record: 'lead', object: 'Lead', id: SF_LEAD, outcome: 'written' },
  ],
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function request(app: Awaited<ReturnType<typeof makeApp>>, method: string, path: string, body?: unknown, auth = true) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer tok' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, testEnv, mockCtx)
}

function supabaseWith(tables: Record<string, TableConfig | TableConfig[]>) {
  const sb = makeSupabase({ users: { single: testUser }, ...tables })
  vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
  return sb
}

let app: Awaited<ReturnType<typeof makeApp>>
beforeEach(async () => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.mocked(verifyJwt).mockResolvedValue(validPayload)
  vi.mocked(writeAuditLog).mockResolvedValue(undefined)
  saleStub.read.mockResolvedValue(inDoubt)
  saleStub.heal.mockResolvedValue(3)
  saleStub.free.mockResolvedValue(3)
  counterStub.addMember.mockResolvedValue({ added: true, count: 12 })
  vi.mocked(writeHeldClickSale).mockResolvedValue(allWritten)
  app = await makeApp()
})

describe('GET /held-clicks', () => {
  it('lists the org\'s held clicks for one buyer, each with the claim\'s live state and generation', async () => {
    const sb = supabaseWith({ held_click_claims: { list: [heldRow], count: 1 } })
    const res = await request(app, 'GET', `/held-clicks?partner_id=${PARTNER}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { entries: Array<Record<string, unknown>>; total: number }
    expect(body.total).toBe(1)
    expect(body.entries).toEqual([expect.objectContaining({
      id: ROW_ID, prospect_id: PROSPECT, reason: 'outcome_unknown', held_at: HELD_AT, workflow_id: heldRow.workflow_id, execution_id: 'exec-1',
      claim: { status: 'held', generation: 2 },
    })])
    expect(sb.calls.held_click_claims).toEqual(expect.arrayContaining([['eq', ['organization_id', 'org-abc']], ['eq', ['partner_id', PARTNER]]]))
    expect(vi.mocked(LeadSaleClient)).toHaveBeenCalledWith(testEnv.LEAD_SALE, { kind: 'click', partner_id: PARTNER, prospect_id: PROSPECT }, expect.anything())
  })

  it('an empty list is an empty list with a total of zero', async () => {
    supabaseWith({ held_click_claims: { list: [], count: 0 } })
    const res = await request(app, 'GET', `/held-clicks?partner_id=${PARTNER}`)
    expect(await res.json()).toEqual({ entries: [], total: 0 })
  })

  it('names every claim state apart: a lapsed send is held, a live one is still sending, free and sold are no longer held, and an unanswered read is its own state', async () => {
    const rows = ['p1', 'p2', 'p3', 'p4', 'p5'].map((p, i) => ({ ...heldRow, id: `55555555-5555-4555-8555-55555555550${i}`, prospect_id: p }))
    supabaseWith({ held_click_claims: { list: rows, count: 5 } })
    saleStub.read
      .mockResolvedValueOnce({ state: 'in_flight', partner_id: PARTNER, execution_id: 'exec-1', since: NOW - 60_000, deadline_ms: 40_000, generation: 1 })
      .mockResolvedValueOnce({ state: 'in_flight', partner_id: PARTNER, execution_id: 'exec-1', since: NOW - 10_000, deadline_ms: 40_000, generation: 1 })
      .mockResolvedValueOnce({ state: 'free', generation: 4 })
      .mockResolvedValueOnce({ state: 'sold', partner_id: PARTNER, outcome: { buyer_reference: LEAD_ID, result_code: 'created', http_status: 200, payout_cents: 0 }, generation: 5 })
      .mockRejectedValueOnce(new Error('lead sale read did not answer within 5000 ms'))
    const res = await request(app, 'GET', `/held-clicks?partner_id=${PARTNER}`)
    const body = await res.json() as { entries: Array<{ claim: unknown }> }
    expect(body.entries.map((e) => e.claim)).toEqual([
      { status: 'held', generation: 1 },
      { status: 'sending', generation: 1, releasable_at: new Date(NOW + 30_000).toISOString() },
      { status: 'free', generation: 4 },
      { status: 'sold', generation: 5, partner_lead_id: LEAD_ID },
      { status: 'unreadable', message: expect.stringMatching(/did not answer/) },
    ])
  })

  it('refuses a missing or malformed partner id rather than listing nothing (L100)', async () => {
    supabaseWith({ held_click_claims: { list: [heldRow] } })
    expect((await request(app, 'GET', '/held-clicks')).status).toBe(400)
    expect((await request(app, 'GET', '/held-clicks?partner_id=liberty1')).status).toBe(400)
  })

  it('a failed read is 500, not an empty list (L98)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ held_click_claims: { listError: { code: '57014', message: 'timeout' } } })
    expect((await request(app, 'GET', `/held-clicks?partner_id=${PARTNER}`)).status).toBe(500)
  })

  it('an unauthenticated call is refused before anything is read', async () => {
    const sb = supabaseWith({ held_click_claims: { list: [heldRow] } })
    const res = await request(app, 'GET', `/held-clicks?partner_id=${PARTNER}`, undefined, false)
    expect(res.status).toBe(401)
    expect(sb.calls.held_click_claims).toBeUndefined()
    expect(saleStub.read).not.toHaveBeenCalled()
  })
})

describe('POST /held-clicks/:id/mark-sent', () => {
  it('heals the claim to sold with the lead id at the generation read, counts the prospect on the day it was held, clears the entry and audits old and new', async () => {
    const sb = supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: ` ${LEAD_ID} ` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'sent', generation: 3, count: { added: true, count: 12, date: '2027-09-20' }, salesforce: allWritten, list_cleared: true })
    expect(saleStub.heal).toHaveBeenCalledWith(2, { buyer_reference: LEAD_ID, result_code: 'marked_sent', http_status: null, payout_cents: 0 })
    expect(vi.mocked(ClickCounterClient)).toHaveBeenCalledWith(testEnv.DAILY_CAP, testEnv.WORKFLOW_CACHE, PARTNER, Date.parse(HELD_AT))
    expect(counterStub.addMember).toHaveBeenCalledWith(PROSPECT)
    expect(sb.eqCalls.held_click_claims).toEqual(expect.arrayContaining([['id', ROW_ID], ['organization_id', 'org-abc'], ['last_execution_id', 'exec-1']]))
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'updated', testUser.id, {
      claim_state: { old: 'in_doubt', new: 'sold' },
      claim_generation: { old: 2, new: 3 },
      buyer_lead_id: { old: null, new: LEAD_ID },
      salesforce_writes: { old: null, new: allWritten },
      subject: { partner_id: PARTNER, prospect_id: PROSPECT, reason: 'outcome_unknown', held_at: HELD_AT },
    })
  })

  it('writes the click\'s Salesforce updates for the held row with the entered lead id, after the claim is sold', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: ` ${LEAD_ID} ` })
    expect(vi.mocked(writeHeldClickSale)).toHaveBeenCalledWith(testEnv, expect.anything(), { orgId: 'org-abc', userId: testUser.id, row: heldRow, buyerLeadId: LEAD_ID })
    expect(saleStub.heal.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(writeHeldClickSale).mock.invocationCallOrder[0])
  })

  it('one Salesforce write failing leaves the mark standing, names the failed write, audits it, and keeps the entry listed for a retry', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    vi.mocked(writeHeldClickSale).mockResolvedValue(submissionFailed)
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outcome: 'sent', generation: 3, salesforce: submissionFailed, list_cleared: false })
    expect(saleStub.free).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'updated', testUser.id, expect.objectContaining({
      claim_state: { old: 'in_doubt', new: 'sold' },
      salesforce_writes: { old: null, new: submissionFailed },
    }))
  })

  it('Salesforce writes that throw outright are reported as not attempted, and the mark still stands', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    vi.mocked(writeHeldClickSale).mockRejectedValue(new Error('boom'))
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(200)
    const body = await res.json() as { salesforce: SaleWrites; list_cleared: boolean }
    expect(body.salesforce.complete).toBe(false)
    expect(body.salesforce.writes.every((w) => w.outcome === 'not_attempted' && /boom/.test(w.message))).toBe(true)
    expect(body.list_cleared).toBe(false)
  })

  it('a lapsed send can be marked sent: the claim object takes it', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    saleStub.read.mockResolvedValue({ state: 'in_flight', partner_id: PARTNER, execution_id: 'exec-1', since: NOW - 60_000, deadline_ms: 40_000, generation: 1 })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 1, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(200)
    expect(saleStub.heal).toHaveBeenCalledWith(1, expect.anything())
  })

  it('a stale page is refused by name and nothing changes: the generation read is not the claim\'s now', async () => {
    supabaseWith({ held_click_claims: { single: heldRow } })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 1, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'claim_changed', message: expect.stringMatching(/changed since/) })
    expect(saleStub.heal).not.toHaveBeenCalled()
    expect(counterStub.addMember).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
    expect(vi.mocked(writeHeldClickSale)).not.toHaveBeenCalled()
  })

  it('a claim that moves between the read and the heal is refused the same way (the compare and set)', async () => {
    supabaseWith({ held_click_claims: { single: heldRow } })
    saleStub.heal.mockRejectedValue(new GenerationMovedError({ state: 'free', generation: 3 }))
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'claim_changed' })
    expect(counterStub.addMember).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('a send still inside its window is refused with when it can be released', async () => {
    supabaseWith({ held_click_claims: { single: heldRow } })
    saleStub.read.mockResolvedValue({ state: 'in_flight', partner_id: PARTNER, execution_id: 'exec-9', since: NOW - 10_000, deadline_ms: 40_000, generation: 1 })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 1, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'still_sending', releasable_at: new Date(NOW + 30_000).toISOString() })
    expect(saleStub.heal).not.toHaveBeenCalled()
  })

  it('a claim no longer held is refused as not held, naming what it is now', async () => {
    supabaseWith({ held_click_claims: { single: heldRow } })
    saleStub.read.mockResolvedValue({ state: 'free', generation: 2 })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'not_held', claim: 'free' })
    expect(saleStub.heal).not.toHaveBeenCalled()
  })

  it('a count that fails is reported on a sale that stands, not a failed release', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    counterStub.addMember.mockRejectedValue(new Error('click counter add answered 500'))
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outcome: 'sent', count: null, count_error: expect.stringMatching(/500/), count_date: '2027-09-20' })
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalled()
  })

  it('an entry a newer hold replaced is left on the list, and the answer says so', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [] } })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ list_cleared: false })
  })

  it('refuses a missing lead id, a lead id with spaces inside, and a generation that is not a whole number', async () => {
    supabaseWith({ held_click_claims: { single: heldRow } })
    for (const body of [{ generation: 2 }, { generation: 2, buyer_lead_id: '  ' }, { generation: 2, buyer_lead_id: 'a0B 5f' }, { generation: 'two', buyer_lead_id: LEAD_ID }, { generation: 1.5, buyer_lead_id: LEAD_ID }]) {
      const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(saleStub.heal).not.toHaveBeenCalled()
  })

  it('another org\'s held click is not found, and nothing is read from or written to its claim', async () => {
    const sb = supabaseWith({ held_click_claims: { single: null } })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(404)
    expect(sb.eqCalls.held_click_claims).toEqual(expect.arrayContaining([['organization_id', 'org-abc']]))
    expect(saleStub.read).not.toHaveBeenCalled()
    expect(saleStub.heal).not.toHaveBeenCalled()
  })

  it('an unauthenticated call is refused before anything is read or written', async () => {
    supabaseWith({ held_click_claims: { single: heldRow } })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: LEAD_ID }, false)
    expect(res.status).toBe(401)
    expect(saleStub.read).not.toHaveBeenCalled()
    expect(saleStub.heal).not.toHaveBeenCalled()
  })

  it('a claim object that does not answer is 503 and nothing is audited', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ held_click_claims: { single: heldRow } })
    saleStub.heal.mockRejectedValue(new Error('lead sale heal did not answer within 5000 ms'))
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(503)
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})

describe('POST /held-clicks/:id/free', () => {
  it('frees the claim at the generation read, counts nothing, clears the entry and audits old and new', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/free`, { generation: 2 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'freed', generation: 3, list_cleared: true })
    expect(saleStub.free).toHaveBeenCalledWith(2)
    expect(counterStub.addMember).not.toHaveBeenCalled()
    // Release (free) writes nothing to Salesforce: the buyer does not have the lead.
    expect(vi.mocked(writeHeldClickSale)).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'updated', testUser.id, {
      claim_state: { old: 'in_doubt', new: 'free' },
      claim_generation: { old: 2, new: 3 },
      subject: { partner_id: PARTNER, prospect_id: PROSPECT, reason: 'outcome_unknown', held_at: HELD_AT },
    })
  })

  it('a send still inside its window is not freed: the claim object would allow it, so the route refuses it', async () => {
    supabaseWith({ held_click_claims: { single: heldRow } })
    saleStub.read.mockResolvedValue({ state: 'in_flight', partner_id: PARTNER, execution_id: 'exec-9', since: NOW - 10_000, deadline_ms: 40_000, generation: 1 })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/free`, { generation: 1 })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'still_sending' })
    expect(saleStub.free).not.toHaveBeenCalled()
  })

  it('a stale page is refused and nothing is freed', async () => {
    supabaseWith({ held_click_claims: { single: heldRow } })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/free`, { generation: 7 })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'claim_changed' })
    expect(saleStub.free).not.toHaveBeenCalled()
  })

  it('a claim the object refuses by state is not held, and the answer names what it is', async () => {
    supabaseWith({ held_click_claims: { single: heldRow } })
    saleStub.free.mockRejectedValue(new WrongStateError({ state: 'sold', partner_id: PARTNER, outcome: { buyer_reference: LEAD_ID, result_code: 'created', http_status: 200, payout_cents: 0 }, generation: 2 }))
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/free`, { generation: 2 })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'not_held', claim: 'sold' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })

  it('another org\'s held click is not found; an unauthenticated call is refused', async () => {
    supabaseWith({ held_click_claims: { single: null } })
    expect((await request(app, 'POST', `/held-clicks/${ROW_ID}/free`, { generation: 2 })).status).toBe(404)
    expect((await request(app, 'POST', `/held-clicks/${ROW_ID}/free`, { generation: 2 }, false)).status).toBe(401)
    expect(saleStub.free).not.toHaveBeenCalled()
  })

  it('an id that is not a uuid is not found rather than a database error', async () => {
    supabaseWith({ held_click_claims: { single: heldRow } })
    expect((await request(app, 'POST', '/held-clicks/not-a-uuid/free', { generation: 2 })).status).toBe(404)
  })
})

describe('POST /held-clicks/:id/clear', () => {
  it('removes an entry whose claim is no longer held, and audits the removal', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    saleStub.read.mockResolvedValue({ state: 'free', generation: 4 })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/clear`, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'cleared', claim: 'free', list_cleared: true })
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'deleted', testUser.id, {
      held_click: { old: { partner_id: PARTNER, prospect_id: PROSPECT, reason: 'outcome_unknown', held_at: HELD_AT }, new: null },
      claim_state: { old: 'free', new: 'free' },
    })
  })

  it('refuses to clear an entry whose claim is still held, so a held click cannot be hidden', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/clear`, {})
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'still_held' })
    expect(vi.mocked(writeAuditLog)).not.toHaveBeenCalled()
  })
})

describe('POST /held-clicks/:id/salesforce (retry the Salesforce updates)', () => {
  it('writes again for a click already marked sent, with the lead id the claim holds, clears the entry once every write lands, and audits it', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    saleStub.read.mockResolvedValue(soldAs(LEAD_ID))
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/salesforce`, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'written', salesforce: allWritten, list_cleared: true })
    // The lead id comes from the claim, the authority, never from the request.
    expect(vi.mocked(writeHeldClickSale)).toHaveBeenCalledWith(testEnv, expect.anything(), { orgId: 'org-abc', userId: testUser.id, row: heldRow, buyerLeadId: LEAD_ID })
    expect(saleStub.heal).not.toHaveBeenCalled()
    expect(counterStub.addMember).not.toHaveBeenCalled()
    expect(vi.mocked(writeAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'updated', testUser.id, {
      salesforce_writes: { old: null, new: allWritten },
      subject: { partner_id: PARTNER, prospect_id: PROSPECT, reason: 'outcome_unknown', held_at: HELD_AT },
    })
  })

  it('a retry that still fails keeps the entry and says which write failed', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    saleStub.read.mockResolvedValue(soldAs(LEAD_ID))
    vi.mocked(writeHeldClickSale).mockResolvedValue(submissionFailed)
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/salesforce`, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'incomplete', salesforce: submissionFailed, list_cleared: false })
  })

  it('a click not marked sent has no sale to write, and nothing is written', async () => {
    supabaseWith({ held_click_claims: { single: heldRow } })
    for (const state of [inDoubt, { state: 'free', generation: 4 } as SaleState]) {
      saleStub.read.mockResolvedValue(state)
      const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/salesforce`, {})
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: 'not_sold' })
    }
    expect(vi.mocked(writeHeldClickSale)).not.toHaveBeenCalled()
  })

  it('a sale with no lead id on the claim is refused rather than written without one', async () => {
    supabaseWith({ held_click_claims: { single: heldRow } })
    saleStub.read.mockResolvedValue(soldAs(null))
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/salesforce`, {})
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'no_lead_id' })
    expect(vi.mocked(writeHeldClickSale)).not.toHaveBeenCalled()
  })

  it('a claim that does not answer is 503; another org\'s entry is 404; unauthenticated is 401', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    supabaseWith({ held_click_claims: { single: heldRow } })
    saleStub.read.mockRejectedValue(new Error('did not answer'))
    expect((await request(app, 'POST', `/held-clicks/${ROW_ID}/salesforce`, {})).status).toBe(503)
    supabaseWith({ held_click_claims: { single: null } })
    expect((await request(app, 'POST', `/held-clicks/${ROW_ID}/salesforce`, {})).status).toBe(404)
    expect((await request(app, 'POST', `/held-clicks/${ROW_ID}/salesforce`, {}, false)).status).toBe(401)
    expect(vi.mocked(writeHeldClickSale)).not.toHaveBeenCalled()
  })
})

describe('GET /held-clicks: the last Salesforce outcome of a sold entry', () => {
  it('a sold entry carries the Salesforce writes its latest audit recorded, so a reload still shows what failed', async () => {
    supabaseWith({
      held_click_claims: { list: [heldRow], count: 1 },
      audit_log: { list: [
        { entity_id: ROW_ID, changed_at: '2027-09-22T18:01:00Z', changes: { salesforce_writes: { old: null, new: submissionFailed } } },
        { entity_id: ROW_ID, changed_at: '2027-09-22T17:00:00Z', changes: { salesforce_writes: { old: null, new: allWritten } } },
      ] },
    })
    saleStub.read.mockResolvedValue(soldAs(LEAD_ID))
    const res = await request(app, 'GET', `/held-clicks?partner_id=${PARTNER}`)
    const body = await res.json() as { entries: Array<Record<string, unknown>> }
    expect(body.entries[0].salesforce).toEqual({ status: 'recorded', at: '2027-09-22T18:01:00Z', writes: submissionFailed })
  })

  it('a sold entry with no recorded writes says none, a held entry carries nothing, and an audit read that fails is its own state', async () => {
    supabaseWith({ held_click_claims: { list: [heldRow], count: 1 }, audit_log: { list: [] } })
    saleStub.read.mockResolvedValue(soldAs(LEAD_ID))
    let body = await (await request(app, 'GET', `/held-clicks?partner_id=${PARTNER}`)).json() as { entries: Array<Record<string, unknown>> }
    expect(body.entries[0].salesforce).toEqual({ status: 'none' })

    saleStub.read.mockResolvedValue(inDoubt)
    body = await (await request(app, 'GET', `/held-clicks?partner_id=${PARTNER}`)).json() as { entries: Array<Record<string, unknown>> }
    expect(body.entries[0].salesforce).toBeNull()

    supabaseWith({ held_click_claims: { list: [heldRow], count: 1 }, audit_log: { listError: { message: 'timeout', code: '57014' } } })
    saleStub.read.mockResolvedValue(soldAs(LEAD_ID))
    body = await (await request(app, 'GET', `/held-clicks?partner_id=${PARTNER}`)).json() as { entries: Array<Record<string, unknown>> }
    expect(body.entries[0].salesforce).toEqual({ status: 'unreadable', message: expect.stringMatching(/timeout/) })
  })
})
