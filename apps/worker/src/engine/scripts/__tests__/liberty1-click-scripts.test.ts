/**
 * The Liberty1 click workflow's kept scripts (#1545), against Brian's Pipedream
 * flow they replace.
 *
 * build_liberty1_request must post byte for byte the body his buildPayload
 * built, to the DV1 or DI4 URL his pickRoute chose, for the same prospect
 * record, and for a Submission with no Prospect the body his
 * submissionAsProspect then buildPayload built (2026-09-29), with one
 * deliberate difference: consentsToTcpa is true on every click, because the
 * button the person pressed sits under Liberty1's own TCPA disclosure (Dan,
 * 2026-09-29), where his flow copied the earlier form's flag. pick_click_record
 * decides which record a click is for and whether it may be sent. liberty1_click_patch must write his three Salesforce bodies, with
 * Completed only when buyer_click_send routed `sent` and Fail only on
 * `refused`, and nothing at all on any other route. resolve_click_input picks
 * the prospect the way his run() did, and refuses anything it cannot use as a
 * Salesforce id before a query is built from it.
 *
 * The oracle is his code (liberty1-pipedream-oracle.ts), so these compare the
 * port against what he wrote, not against a reading of it. The records are
 * invented (fixtures/liberty1-prospects.json).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtures from './fixtures/liberty1-prospects.json'
import submissionFixtures from './fixtures/liberty1-submissions.json'
import { KEPT_LIBERTY1_CLICK_SCRIPTS } from '../../../lib/engine-script-drift'
import { runCanvasScript } from './canvas-script'
import { codeSentinel } from '../../nodes/code'
import { buildPayload, pickRoute, ROUTES, SUBMISSION_FIELDS, submissionAsProspect, updateBodies } from './liberty1-pipedream-oracle'

type Rec = Record<string, unknown>
const RECORDS = fixtures.records as Record<string, Rec>
const SUBMISSIONS = submissionFixtures.records as Record<string, Rec>

const kept = (namespace: string): string => {
  const k = KEPT_LIBERTY1_CLICK_SCRIPTS.find((s) => s.namespace === namespace)
  if (!k) throw new Error(`no kept script for ${namespace}`)
  return k.script
}
const RESOLVE = kept('resolve_input')
const PICK = kept('pick_record')
const BUILD = kept('build_request')
const PATCH = kept('click_patch')

/** The Salesforce query node's output: `{ status, body }`, with the records under body. */
const queried = (record: Rec | null) => ({ output: { status: 200, body: { totalSize: record ? 1 : 0, done: true, records: record ? [record] : [] } } })

type Picked = {
  verdict: 'not_found' | 'completed' | 'open' | 'no_offer'
  not_found_outcome: string | null
  offer: 'on_record' | 'trusted' | null
  record: Rec | null
  prospect_id: string | null
  submission_id: string | null
  lead_id: string | null
  sale_key: string | null
}
async function pick(source: 'prospect' | 'submission' | null, row: Rec | null): Promise<Picked> {
  return (await runCanvasScript(PICK, { payload: {}, steps: { resolve_input: { output: { source } }, query_record: queried(row) } })) as Picked
}

async function build(record: Rec) {
  return (await runCanvasScript(BUILD, { payload: {}, steps: { pick_record: { output: { record } } } })) as { url: string; body: Rec; route: string; state: string | null }
}

/** His body with the one field the port sets differently: the click is the TCPA consent. */
const clicked = <T extends Rec>(body: T): T => ({ ...body, consentsToTcpa: true })

describe("build_liberty1_request against Brian's buildPayload", () => {
  it('a click tells Liberty1 the person consented to TCPA, even when the earlier form\'s flag was false', async () => {
    const unflagged = Object.entries(RECORDS).filter(([, r]) => r.TCPAConsentFlag__c !== true)
    // The fixture that makes this test mean something: a prospect whose own flag is not true.
    expect(unflagged.length).toBeGreaterThan(0)
    for (const [, record] of unflagged) {
      expect(buildPayload(record).consentsToTcpa).toBe(false)
      expect((await build(record)).body.consentsToTcpa).toBe(true)
    }
    for (const record of Object.values(RECORDS)) expect((await build(record)).body.consentsToTcpa).toBe(true)
  })

  for (const [name, record] of Object.entries(RECORDS)) {
    it(`${name}: the body is exactly what his flow sent, to the route the canvas now names`, async () => {
      const out = await build(record)
      const theirs = clicked(buildPayload(record))
      // Byte for byte: key order and every null included, as JSON on the wire.
      expect(JSON.stringify(out.body)).toBe(JSON.stringify(theirs))
      expect(out.url).toBe(ROUTES[pickRoute(theirs.state)])
      expect(out.route).toBe(pickRoute(theirs.state))
    })
  }

  for (const [name, row] of Object.entries(SUBMISSIONS)) {
    it(`${name}: a Submission with no Prospect sends exactly what his flow sends from the Submission`, async () => {
      const picked = await pick('submission', row)
      const out = await build(picked.record as Rec)
      const theirs = clicked(buildPayload(submissionAsProspect(row)))
      expect(JSON.stringify(out.body)).toBe(JSON.stringify(theirs))
      expect(out.url).toBe(ROUTES[pickRoute(theirs.state)])
    })
  }

  it('the Submission fixtures cover both routes, the Lead mobile over the Lead phone and the home phone, a name from the Lead, and income as text', async () => {
    const mobile = await build((await pick('submission', SUBMISSIONS.di4_lead_mobile)).record as Rec)
    expect(mobile.route).toBe('DI4')
    expect(mobile.body).toMatchObject({ leadId1: 'a04Ui00000TestS1AA', firstName: 'Casey', lastName: 'Example', primaryPhone: '4155550133', annualIncome: 65000, state: 'CA', leadId2: 'trypennie.com' })
    const home = await build((await pick('submission', SUBMISSIONS.dv1_home_phone_no_lead)).record as Rec)
    expect(home.route).toBe('DV1')
    expect(home.body).toMatchObject({ primaryPhone: '2065550144', annualIncome: null, consentsToFcra: false, leadId2: 'Website' })
  })

  it('posts to the Liberty1 Salesforce site again, one route per state group, with no doubled slash', async () => {
    expect(ROUTES).toEqual({
      DV1: 'https://liberty1financial.my.salesforce-sites.com/L1F/services/apexrest/inbound/webhooks/DV1',
      DI4: 'https://liberty1financial.my.salesforce-sites.com/L1F/services/apexrest/inbound/webhooks/DI4',
    })
    expect(BUILD).not.toContain('leadconnectorhq')
  })

  it('the fixtures cover both routes, every apartment form, an 11 digit phone and blanks', async () => {
    const routes = await Promise.all(Object.values(RECORDS).map(async (r) => (await build(r)).route))
    expect(new Set(routes)).toEqual(new Set(['DV1', 'DI4']))
    expect((await build(RECORDS.eleven_digit_phone_dv1)).body.primaryPhone).toBe('5035550199')
    expect((await build(RECORDS.di4_state_apt_bare)).body.address1).toBe('45 Sample Rd Apt 4B')
    expect((await build(RECORDS.apt_with_suite_prefix)).body.address1).toBe('9 Demo Blvd Suite 200')
    expect((await build(RECORDS.apt_with_hash)).body.address1).toBe('77 Fake Way #12')
    expect((await build(RECORDS.missing_optionals)).body.address1).toBe('Apt 3')
    expect((await build(RECORDS.apt_with_suite_prefix)).body.providedCreditRating).toBe('excellent')
    expect((await build(RECORDS.lowercase_dv1_state)).url).toBe(ROUTES.DV1)
    expect((await build(RECORDS.missing_optionals)).url).toBe(ROUTES.DI4)
  })

  it('refuses by name when no record was picked, rather than posting a body of nulls', async () => {
    await expect(runCanvasScript(BUILD, { payload: {}, steps: { pick_record: { output: { record: null } } } })).rejects.toThrow(/no record picked/)
    await expect(runCanvasScript(BUILD, { payload: {}, steps: {} })).rejects.toThrow(/no record picked/)
  })
})

describe("liberty1_click_patch against Brian's update_salesforce", () => {
  const NOW = '2026-09-29T16:04:05.000Z'
  const LINK = 'https://bidspoke.trypennie.com/workflows/wf-1/executions/exec-1'
  const LEAD_ID = '00QUy00000gtlZBMAY'
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })
  afterEach(() => vi.useRealTimers())

  const clickOutput = (route: string, partnerLeadId: string | null = null) => ({ _route: route, reason: route, partner_lead_id: partnerLeadId, status: route === 'sent' ? 200 : 400 })
  async function patch(route: string, partnerLeadId: string | null = null, link: string | null = LINK) {
    return (await runCanvasScript(PATCH, {
      payload: {},
      steps: { click_send: { output: clickOutput(route, partnerLeadId) } },
      execution: link === null ? {} : { bidspoke_link: link },
    })) as { write: boolean; exchange_status: string | null; prospect: Rec | null; submission: Rec | null; lead: Rec | null; reply: { success: boolean; outcome: string } }
  }

  it('sent: Completed bodies byte for byte, with the partner lead id and the Bidspoke execution link where he wrote his inspect URL', async () => {
    const out = await patch('sent', LEAD_ID)
    const theirs = updateBodies({ ok: true, text: `Records created successfully : ${LEAD_ID}` }, NOW, LINK)
    expect(out.write).toBe(true)
    expect(out.exchange_status).toBe('Completed')
    expect(JSON.stringify(out.prospect)).toBe(JSON.stringify(theirs.prospect))
    expect(JSON.stringify(out.submission)).toBe(JSON.stringify(theirs.submission))
    expect(JSON.stringify(out.lead)).toBe(JSON.stringify(theirs.lead))
    expect(out.reply).toEqual({ success: true, outcome: 'sent' })
  })

  it('refused: Fail bodies byte for byte, with no partner lead id so the field is not blanked', async () => {
    const out = await patch('refused')
    const theirs = updateBodies({ ok: false, text: '{"error":"Invalid state"}' }, NOW, LINK)
    expect(out.write).toBe(true)
    expect(out.exchange_status).toBe('Fail')
    expect(JSON.stringify(out.prospect)).toBe(JSON.stringify(theirs.prospect))
    expect(JSON.stringify(out.submission)).toBe(JSON.stringify(theirs.submission))
    expect(JSON.stringify(out.lead)).toBe(JSON.stringify(theirs.lead))
    expect(out.prospect).not.toHaveProperty('ExternalPartnerLeadId__c')
    expect(out.reply).toEqual({ success: false, outcome: 'refused' })
  })

  it('routing code is a Number on the Prospect and a String on the Submission and the Lead', async () => {
    const out = await patch('sent', LEAD_ID)
    expect(out.prospect?.ExternalRoutingCode__c).toBe(4)
    expect(out.submission?.External_Routing_Code__c).toBe('4')
    expect(out.lead?.External_Routing_Code__c).toBe('4')
  })

  it('an execution with no link drops PDFlow_3__c rather than blanking it', async () => {
    const out = await patch('sent', LEAD_ID, null)
    expect(out.prospect).not.toHaveProperty('PDFlow_3__c')
    expect(out.submission).not.toHaveProperty('PDFlow_3__c')
  })

  for (const route of ['unknown', 'needs_review', 'in_progress', 'already_sent', 'not_sent', 'something_new']) {
    it(`${route}: writes nothing, neither Completed nor Fail`, async () => {
      const out = await patch(route)
      expect(out.write).toBe(false)
      expect(out.exchange_status).toBeNull()
      expect([out.prospect, out.submission, out.lead]).toEqual([null, null, null])
      expect(out.reply.outcome).toBe(route)
    })
  }

  it('never returns a field the engine reads as respond now or stop (a response or exit field), on any route', async () => {
    // The engine treats a code node's returned `response` object as $.respond()
    // and ends the walk there (codeSentinel): on 2026-09-29 the first live click
    // stopped here and its Salesforce writes never ran.
    for (const route of ['sent', 'refused', 'unknown', 'needs_review', 'in_progress', 'already_sent', 'not_sent']) {
      const out = (await patch(route)) as unknown as Record<string, unknown>
      expect(codeSentinel(out), route).toEqual({})
      expect(out, route).not.toHaveProperty('response')
      expect(out, route).not.toHaveProperty('exit')
    }
  })

  it('a missing click_send step writes nothing', async () => {
    const out = (await runCanvasScript(PATCH, { payload: {}, steps: {} })) as { write: boolean }
    expect(out.write).toBe(false)
  })
})

describe('pick_click_record', () => {
  const PROSPECT = RECORDS.dv1_state_plain
  const SUB = SUBMISSIONS.di4_lead_mobile

  it('a Prospect__c click with an open Liberty1 offer (routing code 4, Bid) is open, keyed and written on the prospect alone', async () => {
    expect(await pick('prospect', PROSPECT)).toEqual({
      verdict: 'open', not_found_outcome: null, offer: 'on_record', record: PROSPECT,
      prospect_id: PROSPECT.Id, submission_id: null, lead_id: null, sale_key: PROSPECT.Id,
    })
  })

  for (const [name, code, status, verdict] of [
    ['routing code 4 Completed', 4, 'Completed', 'completed'],
    ['routing code 4 as text', '4', 'Bid', 'open'],
    ['a Tripoint offer', 2, 'Bid', 'no_offer'],
    ['a Tripoint sale', 2, 'Completed', 'no_offer'],
    ['no routing code', null, 'Bid', 'no_offer'],
    ['routing code 4 already failed', 4, 'Fail', 'no_offer'],
    ['routing code 4 with no status', 4, null, 'no_offer'],
    ['routing code 4 as Success', 4, 'Success', 'no_offer'],
  ] as const) {
    it(`a prospect with ${name} is ${verdict}`, async () => {
      expect((await pick('prospect', { ...PROSPECT, ExternalRoutingCode__c: code, ExternalExchangeStatus__c: status })).verdict).toBe(verdict)
    })
  }

  it('a prospect Salesforce does not hold is not found, as a prospect', async () => {
    expect(await pick('prospect', null)).toMatchObject({ verdict: 'not_found', not_found_outcome: 'prospect_not_found', record: null, sale_key: null })
  })

  it("a Submission with a Prospect is judged on the PROSPECT's offer, keyed on the prospect, and carries the submission and its lead for the writes", async () => {
    const row = { ...SUB, Prospect__c: PROSPECT.Id, Prospect__r: { attributes: { type: 'Prospect__c' }, ...PROSPECT } }
    const out = await pick('submission', row)
    expect(out).toMatchObject({ verdict: 'open', offer: 'on_record', prospect_id: PROSPECT.Id, submission_id: SUB.Id, lead_id: SUB.Lead__c, sale_key: PROSPECT.Id })
    expect(out.record).toMatchObject({ Id: PROSPECT.Id, State__c: 'WA' })
    const noOffer = await pick('submission', { ...row, Prospect__r: { ...PROSPECT, ExternalRoutingCode__c: 2 } })
    expect(noOffer.verdict).toBe('no_offer')
  })

  it('a Submission posted with a Prospect__c it does not belong to is refused and never sent: a posted pair must agree', async () => {
    const row = { ...SUB, Prospect__c: PROSPECT.Id, Prospect__r: { attributes: { type: 'Prospect__c' }, ...PROSPECT } }
    const out = (await runCanvasScript(PICK, { payload: {}, steps: { resolve_input: { output: { source: 'submission', prospect_id: 'a0P5f00000OtherXAAA' } }, query_record: queried(row) } })) as Picked
    expect(out).toMatchObject({ verdict: 'not_found', not_found_outcome: 'submission_not_for_prospect', record: null, sale_key: null })
    const agree = (await runCanvasScript(PICK, { payload: {}, steps: { resolve_input: { output: { source: 'submission', prospect_id: PROSPECT.Id } }, query_record: queried(row) } })) as Picked
    expect(agree).toMatchObject({ verdict: 'open', prospect_id: PROSPECT.Id, submission_id: SUB.Id, lead_id: SUB.Lead__c })
  })

  it('a Submission with no Prospect posted with a Prospect__c is refused as not that prospect\'s, never trusted as Submission-only', async () => {
    const out = (await runCanvasScript(PICK, { payload: {}, steps: { resolve_input: { output: { source: 'submission', prospect_id: PROSPECT.Id } }, query_record: queried(SUB) } })) as Picked
    expect(out).toMatchObject({ verdict: 'not_found', not_found_outcome: 'submission_not_for_prospect' })
  })

  it('a Submission that names a Prospect the query could not return is not found as a prospect, never sent from the submission instead', async () => {
    expect(await pick('submission', { ...SUB, Prospect__c: PROSPECT.Id, Prospect__r: null })).toMatchObject({ verdict: 'not_found', not_found_outcome: 'prospect_not_found' })
  })

  it('a Submission with no Prospect is TRUSTED (Dan, 2026-09-29): open with no offer mark, keyed on the submission, no prospect to write', async () => {
    const out = await pick('submission', SUB)
    expect(out).toMatchObject({ verdict: 'open', offer: 'trusted', prospect_id: null, submission_id: SUB.Id, lead_id: SUB.Lead__c, sale_key: SUB.Id })
    expect(out.record).toEqual(submissionAsProspect(SUB))
  })

  it('a trusted Submission already sold to Liberty1 (routing code 4, Completed) is completed, so a repeat click is never sent', async () => {
    expect((await pick('submission', { ...SUB, External_Routing_Code__c: '4', External_Exchange_Status__c: 'Completed' })).verdict).toBe('completed')
  })

  it('a trusted Submission already sold to ANOTHER buyer is refused as no Liberty1 offer (Dan, 2026-09-29), like a prospect sold elsewhere', async () => {
    expect((await pick('submission', { ...SUB, External_Routing_Code__c: '2', External_Exchange_Status__c: 'Completed' })).verdict).toBe('no_offer')
    expect((await pick('submission', { ...SUB, External_Routing_Code__c: null, External_Exchange_Status__c: 'Completed' })).verdict).toBe('no_offer')
  })

  it('a trusted Submission with any status short of Completed is still sent', async () => {
    for (const status of [null, 'Bid', 'Fail', 'Pending']) {
      expect((await pick('submission', { ...SUB, External_Routing_Code__c: '2', External_Exchange_Status__c: status })).verdict, String(status)).toBe('open')
    }
  })

  it('a Submission Salesforce does not hold is not found, as a submission', async () => {
    expect(await pick('submission', null)).toMatchObject({ verdict: 'not_found', not_found_outcome: 'submission_not_found' })
  })

  it('a Submission with no lead carries no lead id', async () => {
    expect((await pick('submission', SUBMISSIONS.dv1_home_phone_no_lead)).lead_id).toBeNull()
  })

  it('refuses by name when resolve_input named no source, rather than guessing which object the row is', async () => {
    await expect(pick(null, PROSPECT)).rejects.toThrow(/no source/)
  })
})

describe('resolve_click_input', () => {
  const PROSPECT_18 = 'a0P5f00000TestA1AA'
  const SUBMISSION_15 = 'a0S5f00000TestZ'
  type Resolved = { valid: boolean; reason: string | null; source: string | null; prospect_id: string | null; submission_id: string | null; soql: string | null }
  const resolve = async (payload: unknown) => (await runCanvasScript(RESOLVE, { payload, steps: {} })) as Resolved

  it('uses a valid Prospect__c directly and queries it by id, with every field his flow read plus the two offer fields', async () => {
    const r = await resolve({ Prospect__c: PROSPECT_18 })
    expect(r).toMatchObject({ valid: true, reason: null, source: 'prospect', prospect_id: PROSPECT_18, submission_id: null })
    expect(r.soql).toMatch(new RegExp(`FROM Prospect__c WHERE Id = '${PROSPECT_18}'$`))
    for (const f of ['SocialSecurityNumber__c', 'User_IP__c', 'ExternalRoutingCode__c', 'ExternalExchangeStatus__c']) expect(r.soql).toContain(f)
  })

  it("a valid Submission__c queries the submission itself: Brian's submission fields, its offer fields, and every prospect field through Prospect__r", async () => {
    const r = await resolve({ Submission__c: SUBMISSION_15 })
    expect(r).toMatchObject({ valid: true, source: 'submission', prospect_id: null, submission_id: SUBMISSION_15 })
    expect(r.soql).toMatch(new RegExp(`^SELECT .* FROM Submission__c WHERE Id = '${SUBMISSION_15}'$`))
    const selected = String(r.soql).replace(/^SELECT /, '').replace(/ FROM .*$/, '').split(', ')
    for (const f of SUBMISSION_FIELDS) expect(selected).toContain(f)
    for (const f of ['External_Routing_Code__c', 'External_Exchange_Status__c', 'Prospect__r.Id', 'Prospect__r.State__c', 'Prospect__r.ExternalRoutingCode__c', 'Prospect__r.ExternalExchangeStatus__c', 'Prospect__r.TCPAConsentFlag__c']) expect(selected).toContain(f)
    expect(new Set(selected).size).toBe(selected.length)
  })

  it('a Prospect__c posted with a Submission__c queries the submission, so its Lead is written too, and names the prospect it must belong to (Brian: the portal sends both)', async () => {
    const r = await resolve({ Prospect__c: PROSPECT_18, Submission__c: SUBMISSION_15 })
    expect(r).toMatchObject({ valid: true, source: 'submission', prospect_id: PROSPECT_18, submission_id: SUBMISSION_15 })
    expect(r.soql).toMatch(new RegExp(`FROM Submission__c WHERE Id = '${SUBMISSION_15}'$`))
  })

  it('a present but malformed Prospect__c is refused even beside a valid Submission__c, as his run() threw: it must not skip the pair check', async () => {
    const r = await resolve({ Prospect__c: 'nope', Submission__c: SUBMISSION_15 })
    expect(r).toEqual({ valid: false, reason: 'invalid_id', source: null, prospect_id: null, submission_id: null, soql: null })
  })

  it('a blank Prospect__c beside a valid Submission__c is a Submission-only click', async () => {
    const r = await resolve({ Prospect__c: '', Submission__c: SUBMISSION_15 })
    expect(r).toMatchObject({ valid: true, source: 'submission', prospect_id: null, submission_id: SUBMISSION_15 })
  })

  it('trims surrounding whitespace from an id', async () => {
    expect((await resolve({ Prospect__c: ` ${PROSPECT_18} ` })).prospect_id).toBe(PROSPECT_18)
  })

  const refusals: Array<[string, unknown, string]> = [
    ['an empty body', {}, 'no_id'],
    ['a body that is not an object', 'Prospect__c', 'no_id'],
    ['a null body', null, 'no_id'],
    ['blank ids', { Prospect__c: '', Submission__c: '  ' }, 'no_id'],
    ['a 17 character id', { Prospect__c: 'a0P5f00000TestA1E' }, 'invalid_id'],
    ['a quote in the id (SOQL injection)', { Submission__c: "a0S5f00000Test' OR Id != '" }, 'invalid_id'],
    ['an id with a space inside', { Prospect__c: 'a0P5f00000 estA' }, 'invalid_id'],
    ['a numeric id', { Prospect__c: 123456789012345 }, 'invalid_id'],
    ['an array id', { Prospect__c: [PROSPECT_18] }, 'invalid_id'],
  ]
  for (const [name, payload, reason] of refusals) {
    it(`refuses ${name} as ${reason}, with no query to run`, async () => {
      const r = await resolve(payload)
      expect(r).toEqual({ valid: false, reason, source: null, prospect_id: null, submission_id: null, soql: null })
    })
  }
})
