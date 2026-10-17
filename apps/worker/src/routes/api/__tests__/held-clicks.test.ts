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
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'
import type { SaleState } from '../../../durable-objects/lead-sale'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/held-click-sale-writes', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/held-click-sale-writes')>('../../../lib/held-click-sale-writes')
  return { ...actual, writeHeldClickSale: vi.fn() }
})
const saleStub = { read: vi.fn(), heal: vi.fn(), free: vi.fn(), amend: vi.fn() }
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
import { recordAuditLog, writeAuditLog } from '../../../lib/audit'
import { ClickCounterClient, LeadSaleClient, ObjectCallError, ObjectCallLostError } from '../../../lib/buyer-object-clients'
import { DeadlineError } from '@bidspoke/buyer-profile'
import { GenerationMovedError, WrongStateError } from '../../../lib/buyer-sale-attempt'
import { writeHeldClickSale, type SaleWrites } from '../../../lib/held-click-sale-writes'
import { makeSupabase, type TableConfig } from './_supabase-mock'

const testUser = { id: '22222222-2222-4222-8222-222222222222', organization_id: 'org-abc', email: 'dan@pennie.com' }
const validPayload = { sub: testUser.id, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, LEAD_SALE: {}, DAILY_CAP: {} } as unknown as Env
const mockCtx = recordingContext()

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

/** Who released it, carried on every held click audit row as PR1's partner rows carry it (#2139). */
const ACTOR = { name: null, email: 'dan@pennie.com' }

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
  vi.mocked(recordAuditLog).mockResolvedValue(true)
  saleStub.read.mockResolvedValue(inDoubt)
  saleStub.heal.mockResolvedValue(3)
  saleStub.free.mockResolvedValue(3)
  saleStub.amend.mockResolvedValue(4)
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
    expect(await res.json()).toEqual({ outcome: 'sent', generation: 3, count: { added: true, count: 12, date: '2027-09-20' }, salesforce: allWritten, audit_recorded: true, list_cleared: true })
    expect(saleStub.heal).toHaveBeenCalledWith(2, { buyer_reference: LEAD_ID, result_code: 'marked_sent', http_status: null, payout_cents: 0 })
    expect(vi.mocked(ClickCounterClient)).toHaveBeenCalledWith(testEnv.DAILY_CAP, testEnv.WORKFLOW_CACHE, PARTNER, Date.parse(HELD_AT))
    expect(counterStub.addMember).toHaveBeenCalledWith(PROSPECT)
    expect(sb.eqCalls.held_click_claims).toEqual(expect.arrayContaining([['id', ROW_ID], ['organization_id', 'org-abc'], ['last_execution_id', 'exec-1']]))
    expect(vi.mocked(recordAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'updated', testUser.id, {
      claim_state: { old: 'in_doubt', new: 'sold' },
      claim_generation: { old: 2, new: 3 },
      buyer_lead_id: { old: null, new: LEAD_ID },
      salesforce_writes: { old: null, new: allWritten },
      subject: { partner_id: PARTNER, prospect_id: PROSPECT, reason: 'outcome_unknown', held_at: HELD_AT },
      _actor: ACTOR,
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
    expect(vi.mocked(recordAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'updated', testUser.id, expect.objectContaining({
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

  it('an audit entry that fails to land is reported, since it is the only record of the Salesforce outcome', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    vi.mocked(writeHeldClickSale).mockResolvedValue(submissionFailed)
    vi.mocked(recordAuditLog).mockResolvedValue(false)
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outcome: 'sent', salesforce: submissionFailed, audit_recorded: false, list_cleared: false })
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
    expect(vi.mocked(recordAuditLog)).toHaveBeenCalled()
  })

  // #1766: an add that got no answer may have landed, and the count is a set, so it is asked
  // once more; the answer says whether the count refused it or whether that is not known.
  describe('the count after Mark sent says only what the counter answered (#1766)', () => {
    const markSent = async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
      const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: LEAD_ID })
      expect(res.status).toBe(200)
      return res.json() as Promise<Record<string, unknown>>
    }

    it('an add that times out once and then answers is counted, asked twice', async () => {
      counterStub.addMember.mockRejectedValueOnce(new DeadlineError('click counter add', 5000)).mockResolvedValueOnce({ added: true, count: 12 })
      expect(await markSent()).toMatchObject({ count: { added: true, count: 12, date: '2027-09-20' } })
      expect(counterStub.addMember).toHaveBeenCalledTimes(2)
    })

    it('a call lost in transit is asked again too', async () => {
      counterStub.addMember.mockRejectedValueOnce(new ObjectCallLostError(new TypeError('Network connection lost.'))).mockResolvedValueOnce({ added: false, count: 12 })
      expect(await markSent()).toMatchObject({ count: { added: false, count: 12 } })
      expect(counterStub.addMember).toHaveBeenCalledTimes(2)
    })

    it('no answer twice is reported as unknown, with both answers, never as not added', async () => {
      counterStub.addMember.mockRejectedValue(new DeadlineError('click counter add', 5000))
      const body = await markSent()
      expect(counterStub.addMember).toHaveBeenCalledTimes(2)
      expect(body).toMatchObject({ count: null, count_failure: 'unknown', count_date: '2027-09-20' })
      expect(body.count_error).toBe('click counter add did not answer within 5000 ms; asked again: click counter add did not answer within 5000 ms')
    })

    it('a refusal the counter gave is not asked again, and is reported as not added', async () => {
      counterStub.addMember.mockRejectedValue(new ObjectCallError('click counter add', 400, '{"error":"bad_member"}'))
      const body = await markSent()
      expect(counterStub.addMember).toHaveBeenCalledTimes(1)
      expect(body).toMatchObject({ count: null, count_failure: 'not_added', count_error: 'click counter add answered 400: {"error":"bad_member"}' })
    })

    it('an error nobody classified is not asked again, and is reported as unknown', async () => {
      counterStub.addMember.mockRejectedValue(new Error('click counter add answered 500'))
      const body = await markSent()
      expect(counterStub.addMember).toHaveBeenCalledTimes(1)
      expect(body).toMatchObject({ count: null, count_failure: 'unknown' })
    })
  })

  it('an entry a newer hold replaced is left on the list, and the answer says so', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [] } })
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ list_cleared: false })
  })

  it('refuses a lead id with spaces inside or not text, and a generation that is not a whole number', async () => {
    supabaseWith({ held_click_claims: { single: heldRow } })
    for (const body of [{ generation: 2, buyer_lead_id: 'a0B 5f' }, { generation: 2, buyer_lead_id: 7 }, { generation: 2, buyer_lead_id: 'x'.repeat(201) }, { generation: 'two', buyer_lead_id: LEAD_ID }, { generation: 1.5, buyer_lead_id: LEAD_ID }]) {
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
      _actor: ACTOR,
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
      _actor: ACTOR,
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
    expect(await res.json()).toEqual({ outcome: 'written', salesforce: allWritten, audit_recorded: true, list_cleared: true })
    // The lead id comes from the claim, the authority, never from the request.
    expect(vi.mocked(writeHeldClickSale)).toHaveBeenCalledWith(testEnv, expect.anything(), { orgId: 'org-abc', userId: testUser.id, row: heldRow, buyerLeadId: LEAD_ID })
    expect(saleStub.heal).not.toHaveBeenCalled()
    expect(counterStub.addMember).not.toHaveBeenCalled()
    expect(vi.mocked(recordAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'updated', testUser.id, {
      salesforce_writes: { old: null, new: allWritten },
      subject: { partner_id: PARTNER, prospect_id: PROSPECT, reason: 'outcome_unknown', held_at: HELD_AT },
      _actor: ACTOR,
    })
  })

  it('a retry that still fails keeps the entry and says which write failed', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    saleStub.read.mockResolvedValue(soldAs(LEAD_ID))
    vi.mocked(writeHeldClickSale).mockResolvedValue(submissionFailed)
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/salesforce`, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'incomplete', salesforce: submissionFailed, audit_recorded: true, list_cleared: false })
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

  it('a sale marked without a lead id is written without one (PM-7), and stays listed so a lead id can still be added (#2139)', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    saleStub.read.mockResolvedValue(soldAs(null))
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/salesforce`, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'written', salesforce: allWritten, audit_recorded: true, list_cleared: false })
    expect(vi.mocked(writeHeldClickSale)).toHaveBeenCalledWith(testEnv, expect.anything(), { orgId: 'org-abc', userId: testUser.id, row: heldRow, buyerLeadId: null })
  })

  it('a retry with no lead id that Salesforce refuses is incomplete, with Salesforce\'s own words on the record it refused', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    saleStub.read.mockResolvedValue(soldAs(null))
    vi.mocked(writeHeldClickSale).mockResolvedValue(submissionFailed)
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/salesforce`, {})
    const body = await res.json() as { outcome: string; salesforce: SaleWrites; list_cleared: boolean }
    expect(body.outcome).toBe('incomplete')
    expect(body.salesforce.writes[1]).toEqual(expect.objectContaining({ outcome: 'failed', message: expect.stringMatching(/FIELD_CUSTOM_VALIDATION_EXCEPTION/) }))
    expect(body.list_cleared).toBe(false)
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

  it('each sold entry reads its OWN newest Salesforce row, so another entry\'s many audit rows cannot push it out and make it read as none', async () => {
    const ROW_B = '55555555-5555-4555-8555-555555555502'
    const sb = supabaseWith({
      held_click_claims: { list: [heldRow, { ...heldRow, id: ROW_B, prospect_id: 'a0B000000000002AAA' }], count: 2 },
      audit_log: [
        { list: [{ changed_at: '2027-09-22T18:01:00Z', changes: { salesforce_writes: { old: null, new: submissionFailed } } }] },
        { list: [{ changed_at: '2027-09-20T10:00:00Z', changes: { salesforce_writes: { old: null, new: allWritten } } }] },
      ],
    })
    saleStub.read.mockResolvedValue(soldAs(LEAD_ID))
    const body = await (await request(app, 'GET', `/held-clicks?partner_id=${PARTNER}`)).json() as { entries: Array<Record<string, unknown>> }
    expect(body.entries.map((e) => e.salesforce)).toEqual([
      { status: 'recorded', at: '2027-09-22T18:01:00Z', writes: submissionFailed },
      { status: 'recorded', at: '2027-09-20T10:00:00Z', writes: allWritten },
    ])
    // One read per entry, scoped to it, to rows carrying salesforce_writes, newest one only.
    expect(sb.calls.audit_log).toEqual(expect.arrayContaining([
      ['eq', ['entity_id', ROW_ID]],
      ['eq', ['entity_id', ROW_B]],
      ['not', ['changes->salesforce_writes', 'is', null]],
      ['limit', [1]],
    ]))
    expect(sb.calls.audit_log.filter(([m]) => m === 'in')).toHaveLength(0)
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

describe('POST /held-clicks/:id/salesforce: the audit carries what it replaced (L529)', () => {
  it('the previous recorded outcome is the old value of the retry\'s audit entry', async () => {
    supabaseWith({
      held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] },
      audit_log: { list: [{ entity_id: ROW_ID, changed_at: '2027-09-22T18:01:00Z', changes: { salesforce_writes: { old: null, new: submissionFailed } } }] },
    })
    saleStub.read.mockResolvedValue(soldAs(LEAD_ID))
    await request(app, 'POST', `/held-clicks/${ROW_ID}/salesforce`, {})
    expect(vi.mocked(recordAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'updated', testUser.id, expect.objectContaining({
      salesforce_writes: { old: submissionFailed, new: allWritten },
    }))
  })

  it('a previous outcome that cannot be read is recorded as unreadable, not as none', async () => {
    supabaseWith({
      held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] },
      audit_log: { listError: { message: 'timeout', code: '57014' } },
    })
    saleStub.read.mockResolvedValue(soldAs(LEAD_ID))
    await request(app, 'POST', `/held-clicks/${ROW_ID}/salesforce`, {})
    expect(vi.mocked(recordAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'updated', testUser.id, expect.objectContaining({
      salesforce_writes: { old: { unreadable: expect.stringMatching(/timeout/) }, new: allWritten },
    }))
  })

  it('a retry whose audit entry fails to land says so', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    saleStub.read.mockResolvedValue(soldAs(LEAD_ID))
    vi.mocked(recordAuditLog).mockResolvedValue(false)
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/salesforce`, {})
    expect(await res.json()).toMatchObject({ outcome: 'written', audit_recorded: false })
  })
})

describe('POST /held-clicks/:id/mark-sent without a lead id (PM-7, #2139)', () => {
  it('counts the click, sells the claim with no lead id, marks the sale Completed in Salesforce with none, and keeps the entry listed so one can be added (L1008)', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    const noId: SaleWrites = { ...allWritten, buyer_lead_id: null }
    vi.mocked(writeHeldClickSale).mockResolvedValue(noId)
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'sent', generation: 3, count: { added: true, count: 12, date: '2027-09-20' }, salesforce: noId, audit_recorded: true, list_cleared: false })
    expect(saleStub.heal).toHaveBeenCalledWith(2, { buyer_reference: null, result_code: 'marked_sent', http_status: null, payout_cents: 0 })
    expect(counterStub.addMember).toHaveBeenCalledWith(PROSPECT)
    expect(vi.mocked(writeHeldClickSale)).toHaveBeenCalledWith(testEnv, expect.anything(), { orgId: 'org-abc', userId: testUser.id, row: heldRow, buyerLeadId: null })
    expect(vi.mocked(recordAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'updated', testUser.id, expect.objectContaining({
      buyer_lead_id: { old: null, new: null },
      salesforce_writes: { old: null, new: noId },
      _actor: ACTOR,
    }))
  })

  it('an empty or blank lead id is no lead id, never an empty string on the claim', async () => {
    for (const buyer_lead_id of ['', '   ', null]) {
      supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
      saleStub.heal.mockClear()
      expect((await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2, buyer_lead_id })).status).toBe(200)
      expect(saleStub.heal).toHaveBeenCalledWith(2, expect.objectContaining({ buyer_reference: null }))
    }
  })

  it('a Salesforce update that fails with no lead id is incomplete, with Salesforce\'s own words on each record, and the sale stands', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    const failedNoId: SaleWrites = { ...submissionFailed, buyer_lead_id: null }
    vi.mocked(writeHeldClickSale).mockResolvedValue(failedNoId)
    const res = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2 })
    expect(res.status).toBe(200)
    const body = await res.json() as { outcome: string; salesforce: SaleWrites; list_cleared: boolean }
    expect(body.outcome).toBe('sent')
    expect(body.salesforce.complete).toBe(false)
    expect(body.salesforce.writes.map((w) => [w.record, w.outcome, 'message' in w ? w.message : null])).toEqual([
      ['prospect', 'written', null],
      ['submission', 'failed', 'Salesforce refused the Submission__c update (400): FIELD_CUSTOM_VALIDATION_EXCEPTION'],
      ['lead', 'written', null],
    ])
    expect(body.list_cleared).toBe(false)
    expect(saleStub.free).not.toHaveBeenCalled()
  })

  it('writes no buyer ledger entry and calls no sale recording function, so the daily sale check, which judges only the ledger, counts nothing new (A4)', async () => {
    const ledger = { idFromName: vi.fn(), get: vi.fn() }
    const rpc = vi.fn(async () => ({ data: null, error: null }))
    const sb = makeSupabase({ users: { single: testUser }, held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } }, { rpc })
    vi.mocked(createSupabaseClient).mockReturnValue(sb as unknown as ReturnType<typeof createSupabaseClient>)
    const res = await app.request(`/held-clicks/${ROW_ID}/mark-sent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify({ generation: 2 }),
    }, { ...testEnv, BUYER_LEDGER: ledger } as unknown as Env, mockCtx)
    expect(res.status).toBe(200)
    expect(ledger.idFromName).not.toHaveBeenCalled()
    expect(ledger.get).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(Object.keys(sb.calls).filter((t) => t !== 'users').sort()).toEqual(['held_click_claims'])
  })

  it('a double press is gated by the generation: the second is refused and nothing is counted or written twice', async () => {
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    expect((await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2 })).status).toBe(200)
    saleStub.read.mockResolvedValue(soldAs(null, 3))
    const second = await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2 })
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ error: 'claim_changed' })
    expect(saleStub.heal).toHaveBeenCalledTimes(1)
    expect(counterStub.addMember).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeHeldClickSale)).toHaveBeenCalledTimes(1)
  })

  it('the person\'s name is carried on the audit row when the token has one', async () => {
    vi.mocked(verifyJwt).mockResolvedValue({ ...validPayload, user_metadata: { full_name: 'Dan Wright' } } as unknown as Awaited<ReturnType<typeof verifyJwt>>)
    supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] } })
    await request(app, 'POST', `/held-clicks/${ROW_ID}/mark-sent`, { generation: 2 })
    expect(vi.mocked(recordAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'updated', testUser.id, expect.objectContaining({
      _actor: { name: 'Dan Wright', email: 'dan@pennie.com' },
    }))
  })
})

describe('GET /held-clicks: a sold entry with no lead id (#2139)', () => {
  it('returns null for the lead id, never an empty string, and stands written when Salesforce took the sale without one', async () => {
    supabaseWith({
      held_click_claims: { list: [heldRow], count: 1 },
      audit_log: { list: [{ changed_at: '2027-09-22T18:01:00Z', changes: { salesforce_writes: { old: null, new: { ...allWritten, buyer_lead_id: null } } } }] },
    })
    saleStub.read.mockResolvedValue(soldAs(null))
    const body = await (await request(app, 'GET', `/held-clicks?partner_id=${PARTNER}`)).json() as { entries: Array<Record<string, unknown>> }
    expect(body.entries[0].claim).toEqual({ status: 'sold', generation: 3, partner_lead_id: null })
    expect(body.entries[0].salesforce_standing).toBe('written')
  })
})

describe('GET /held-clicks: where each sold entry stands in Salesforce (PM-8, #2139)', () => {
  const listWith = (claim: SaleState, auditRows: Array<Record<string, unknown>>) => {
    supabaseWith({ held_click_claims: { list: [heldRow], count: 1 }, audit_log: { list: auditRows } })
    saleStub.read.mockResolvedValue(claim)
  }
  const standing = async () => {
    const body = await (await request(app, 'GET', `/held-clicks?partner_id=${PARTNER}`)).json() as { entries: Array<Record<string, unknown>> }
    return body.entries[0].salesforce_standing
  }

  it('incomplete when the last updates did not all land', async () => {
    listWith(soldAs(LEAD_ID), [{ changed_at: '2027-09-22T18:01:00Z', changes: { salesforce_writes: { old: null, new: { ...submissionFailed, buyer_lead_id: LEAD_ID } } } }])
    expect(await standing()).toBe('incomplete')
  })

  it('lead_id_not_written when the claim now holds a lead id the last updates did not carry, as after an amend that stopped before Salesforce', async () => {
    listWith(soldAs('L1-NEW'), [{ changed_at: '2027-09-22T18:01:00Z', changes: { salesforce_writes: { old: null, new: { ...allWritten, buyer_lead_id: LEAD_ID } } } }])
    expect(await standing()).toBe('lead_id_not_written')
  })

  it('reads the lead id of a record made before it was carried on the writes from the same audit row\'s buyer_lead_id', async () => {
    listWith(soldAs('L1-NEW'), [{ changed_at: '2027-09-22T18:01:00Z', changes: { buyer_lead_id: { old: null, new: LEAD_ID }, salesforce_writes: { old: null, new: allWritten } } }])
    expect(await standing()).toBe('lead_id_not_written')
  })

  it('not_recorded when a sold entry has no recorded update, as after a Mark sent that stopped before Salesforce', async () => {
    listWith(soldAs(LEAD_ID), [])
    expect(await standing()).toBe('not_recorded')
  })

  it('unreadable when the record cannot be read, never written', async () => {
    supabaseWith({ held_click_claims: { list: [heldRow], count: 1 }, audit_log: { listError: { message: 'timeout', code: '57014' } } })
    saleStub.read.mockResolvedValue(soldAs(LEAD_ID))
    expect(await standing()).toBe('unreadable')
  })

  it('null on an entry that is not sold', async () => {
    listWith(inDoubt, [])
    expect(await standing()).toBeNull()
  })
})

describe('POST /held-clicks/:id/lead-id: add or correct the lead id of a sale marked sent (decision 3, L1008, #2139)', () => {
  const amendRow = (claim: SaleState, auditRows: Array<Record<string, unknown>> = []) => {
    const sb = supabaseWith({ held_click_claims: { single: heldRow, writeRows: [{ id: ROW_ID }] }, audit_log: { list: auditRows } })
    saleStub.read.mockResolvedValue(claim)
    return sb
  }
  const post = (body: unknown) => request(app, 'POST', `/held-clicks/${ROW_ID}/lead-id`, body)

  it('adds a lead id to a sale marked without one: amends the claim at the generation read, writes Salesforce with it, clears the entry, and audits old and new', async () => {
    const before: SaleWrites = { ...allWritten, buyer_lead_id: null }
    const sb = amendRow(soldAs(null, 3), [{ changed_at: '2027-09-22T18:01:00Z', changes: { salesforce_writes: { old: null, new: before } } }])
    const after: SaleWrites = { ...allWritten, buyer_lead_id: LEAD_ID }
    vi.mocked(writeHeldClickSale).mockResolvedValue(after)
    const res = await post({ generation: 3, buyer_lead_id: ` ${LEAD_ID} ` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: 'amended', generation: 4, salesforce: after, audit_recorded: true, list_cleared: true })
    // Only the reference is sent: the object keeps every other outcome field as the sale recorded it.
    expect(saleStub.amend).toHaveBeenCalledWith(3, LEAD_ID)
    expect(saleStub.heal).not.toHaveBeenCalled()
    expect(counterStub.addMember).not.toHaveBeenCalled()
    expect(vi.mocked(writeHeldClickSale)).toHaveBeenCalledWith(testEnv, expect.anything(), { orgId: 'org-abc', userId: testUser.id, row: heldRow, buyerLeadId: LEAD_ID })
    expect(saleStub.amend.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(writeHeldClickSale).mock.invocationCallOrder[0])
    expect(vi.mocked(recordAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'updated', testUser.id, {
      buyer_lead_id: { old: null, new: LEAD_ID },
      claim_generation: { old: 3, new: 4 },
      salesforce_writes: { old: before, new: after },
      subject: { partner_id: PARTNER, prospect_id: PROSPECT, reason: 'outcome_unknown', held_at: HELD_AT },
      _actor: ACTOR,
    })
    expect(sb.eqCalls.held_click_claims).toEqual(expect.arrayContaining([['id', ROW_ID], ['organization_id', 'org-abc'], ['last_execution_id', 'exec-1']]))
  })

  it('corrects a lead id: the old one is the audit row\'s old value', async () => {
    amendRow(soldAs('L1-TYPO', 3))
    const res = await post({ generation: 3, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(200)
    expect(saleStub.amend).toHaveBeenCalledWith(3, LEAD_ID)
    expect(vi.mocked(recordAuditLog)).toHaveBeenCalledWith(expect.anything(), 'org-abc', 'held_click', ROW_ID, 'updated', testUser.id, expect.objectContaining({
      buyer_lead_id: { old: 'L1-TYPO', new: LEAD_ID },
    }))
  })

  it('a stale generation is refused by name and nothing is amended or written', async () => {
    amendRow(soldAs(null, 4))
    const res = await post({ generation: 3, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'claim_changed', message: expect.stringMatching(/changed since/) })
    expect(saleStub.amend).not.toHaveBeenCalled()
    expect(vi.mocked(writeHeldClickSale)).not.toHaveBeenCalled()
    expect(vi.mocked(recordAuditLog)).not.toHaveBeenCalled()
  })

  it('a claim that moves between the read and the amend is refused the same way (the compare and set)', async () => {
    amendRow(soldAs(null, 3))
    saleStub.amend.mockRejectedValue(new GenerationMovedError(soldAs('L1-OTHER', 4)))
    const res = await post({ generation: 3, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'claim_changed' })
    expect(vi.mocked(writeHeldClickSale)).not.toHaveBeenCalled()
  })

  it('a Salesforce retry that fails shows Salesforce\'s own words, keeps the entry listed, and the new lead id stands', async () => {
    amendRow(soldAs(null, 3))
    vi.mocked(writeHeldClickSale).mockResolvedValue({ ...submissionFailed, buyer_lead_id: LEAD_ID })
    const res = await post({ generation: 3, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(200)
    const body = await res.json() as { outcome: string; generation: number; salesforce: SaleWrites; list_cleared: boolean }
    expect(body).toMatchObject({ outcome: 'amended', generation: 4, list_cleared: false })
    expect(body.salesforce.writes[1]).toEqual(expect.objectContaining({ outcome: 'failed', message: 'Salesforce refused the Submission__c update (400): FIELD_CUSTOM_VALIDATION_EXCEPTION' }))
  })

  it('Salesforce writes that throw are reported as not attempted on every record, and the amend stands', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    amendRow(soldAs(null, 3))
    vi.mocked(writeHeldClickSale).mockRejectedValue(new Error('boom'))
    const body = await (await post({ generation: 3, buyer_lead_id: LEAD_ID })).json() as { salesforce: SaleWrites; list_cleared: boolean }
    expect(body.salesforce).toMatchObject({ complete: false, buyer_lead_id: LEAD_ID })
    expect(body.salesforce.writes.every((w) => w.outcome === 'not_attempted' && /boom/.test(w.message))).toBe(true)
    expect(body.list_cleared).toBe(false)
  })

  it('a click not marked sent has no sale whose lead id could change', async () => {
    for (const claim of [inDoubt, { state: 'free', generation: 2 } as SaleState]) {
      amendRow(claim)
      const res = await post({ generation: 2, buyer_lead_id: LEAD_ID })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: 'not_sold' })
    }
    expect(saleStub.amend).not.toHaveBeenCalled()
  })

  it('a sale the buyer itself confirmed keeps the buyer\'s own reference: only a sale a person marked sent is amended here', async () => {
    amendRow({ state: 'sold', partner_id: PARTNER, outcome: { buyer_reference: 'B-REF', result_code: 'created', http_status: 200, payout_cents: 0 }, generation: 3 })
    const res = await post({ generation: 3, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'not_marked_sent' })
    expect(saleStub.amend).not.toHaveBeenCalled()
  })

  it('the lead id the claim already holds changes nothing and is refused by name', async () => {
    amendRow(soldAs(LEAD_ID, 3))
    const res = await post({ generation: 3, buyer_lead_id: LEAD_ID })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'lead_id_unchanged' })
    expect(saleStub.amend).not.toHaveBeenCalled()
    expect(vi.mocked(writeHeldClickSale)).not.toHaveBeenCalled()
  })

  it('refuses a missing or blank lead id, one with spaces inside, and a generation that is not a whole number', async () => {
    amendRow(soldAs(null, 3))
    for (const body of [{ generation: 3 }, { generation: 3, buyer_lead_id: '  ' }, { generation: 3, buyer_lead_id: 'a0B 5f' }, { generation: 'three', buyer_lead_id: LEAD_ID }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(saleStub.read).not.toHaveBeenCalled()
    expect(saleStub.amend).not.toHaveBeenCalled()
  })

  it('an audit entry that fails to land is reported', async () => {
    amendRow(soldAs(null, 3))
    vi.mocked(recordAuditLog).mockResolvedValue(false)
    expect(await (await post({ generation: 3, buyer_lead_id: LEAD_ID })).json()).toMatchObject({ outcome: 'amended', audit_recorded: false })
  })

  it('a claim that does not answer is 503 and nothing is written; another org\'s entry is 404; unauthenticated is 401', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    amendRow(soldAs(null, 3))
    saleStub.read.mockRejectedValue(new Error('did not answer'))
    expect((await post({ generation: 3, buyer_lead_id: LEAD_ID })).status).toBe(503)
    saleStub.read.mockResolvedValue(soldAs(null, 3))
    saleStub.amend.mockRejectedValue(new Error('lead sale amend did not answer within 5000 ms'))
    expect((await post({ generation: 3, buyer_lead_id: LEAD_ID })).status).toBe(503)
    supabaseWith({ held_click_claims: { single: null } })
    expect((await post({ generation: 3, buyer_lead_id: LEAD_ID })).status).toBe(404)
    expect((await request(app, 'POST', `/held-clicks/${ROW_ID}/lead-id`, { generation: 3, buyer_lead_id: LEAD_ID }, false)).status).toBe(401)
    expect(vi.mocked(writeHeldClickSale)).not.toHaveBeenCalled()
    expect(vi.mocked(recordAuditLog)).not.toHaveBeenCalled()
  })
})
