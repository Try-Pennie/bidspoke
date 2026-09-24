/**
 * The Liberty1 click workflow's kept scripts (#1545), against Brian's Pipedream
 * flow they replace.
 *
 * build_liberty1_request must post byte for byte the body his buildPayload
 * built, to the DV1 or DI4 URL his pickRoute chose, for the same prospect
 * record. liberty1_click_patch must write his three Salesforce bodies, with
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
import { KEPT_LIBERTY1_CLICK_SCRIPTS } from '../../../lib/engine-script-drift'
import { runCanvasScript } from './canvas-script'
import { ROUTES, buildPayload, pickRoute, updateBodies } from './liberty1-pipedream-oracle'

type Rec = Record<string, unknown>
const RECORDS = fixtures.records as Record<string, Rec>

const kept = (namespace: string): string => {
  const k = KEPT_LIBERTY1_CLICK_SCRIPTS.find((s) => s.namespace === namespace)
  if (!k) throw new Error(`no kept script for ${namespace}`)
  return k.script
}
const RESOLVE = kept('resolve_input')
const BUILD = kept('build_request')
const PATCH = kept('click_patch')

/** The Salesforce query node's output: `{ status, body }`, with the records under body. */
const queried = (record: Rec | null) => ({ output: { status: 200, body: { totalSize: record ? 1 : 0, done: true, records: record ? [record] : [] } } })

async function build(record: Rec) {
  return (await runCanvasScript(BUILD, { payload: {}, steps: { query_prospect: queried(record) } })) as { url: string; body: Rec; prospect_id: string; route: string; state: string | null }
}

describe("build_liberty1_request against Brian's buildPayload", () => {
  for (const [name, record] of Object.entries(RECORDS)) {
    it(`${name}: the body and the URL are exactly what his flow sent`, async () => {
      const out = await build(record)
      const theirs = buildPayload(record)
      // Byte for byte: key order and every null included, as JSON on the wire.
      expect(JSON.stringify(out.body)).toBe(JSON.stringify(theirs))
      expect(out.url).toBe(ROUTES[pickRoute(theirs.state)])
      expect(out.route).toBe(pickRoute(theirs.state))
      expect(out.prospect_id).toBe(record.Id)
    })
  }

  it('the fixtures cover both routes, every apartment form, an 11 digit phone and blanks', async () => {
    const routes = await Promise.all(Object.values(RECORDS).map(async (r) => (await build(r)).route))
    expect(new Set(routes)).toEqual(new Set(['DV1', 'DI4']))
    expect((await build(RECORDS.eleven_digit_phone_dv1)).body.primaryPhone).toBe('5035550199')
    expect((await build(RECORDS.di4_state_apt_bare)).body.address1).toBe('45 Sample Rd Apt 4B')
    expect((await build(RECORDS.apt_with_suite_prefix)).body.address1).toBe('9 Demo Blvd Suite 200')
    expect((await build(RECORDS.apt_with_hash)).body.address1).toBe('77 Fake Way #12')
    expect((await build(RECORDS.missing_optionals)).body.address1).toBe('Apt 3')
    expect((await build(RECORDS.apt_with_suite_prefix)).body.providedCreditRating).toBe('excellent')
    expect((await build(RECORDS.lowercase_dv1_state)).url).toMatch(/\/DV1$/)
    expect((await build(RECORDS.missing_optionals)).url).toMatch(/\/DI4$/)
  })

  it('refuses by name when the query found no prospect, rather than posting a body of nulls', async () => {
    await expect(runCanvasScript(BUILD, { payload: {}, steps: { query_prospect: queried(null) } })).rejects.toThrow(/no prospect record/)
    await expect(runCanvasScript(BUILD, { payload: {}, steps: {} })).rejects.toThrow(/no prospect record/)
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
    })) as { write: boolean; exchange_status: string | null; prospect: Rec | null; submission: Rec | null; lead: Rec | null; response: { success: boolean; outcome: string } }
  }

  it('sent: Completed bodies byte for byte, with the partner lead id and the Bidspoke execution link where he wrote his inspect URL', async () => {
    const out = await patch('sent', LEAD_ID)
    const theirs = updateBodies({ ok: true, text: `Records created successfully : ${LEAD_ID}` }, NOW, LINK)
    expect(out.write).toBe(true)
    expect(out.exchange_status).toBe('Completed')
    expect(JSON.stringify(out.prospect)).toBe(JSON.stringify(theirs.prospect))
    expect(JSON.stringify(out.submission)).toBe(JSON.stringify(theirs.submission))
    expect(JSON.stringify(out.lead)).toBe(JSON.stringify(theirs.lead))
    expect(out.response).toEqual({ success: true, outcome: 'sent' })
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
    expect(out.response).toEqual({ success: false, outcome: 'refused' })
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
      expect(out.response.outcome).toBe(route)
    })
  }

  it('a missing click_send step writes nothing', async () => {
    const out = (await runCanvasScript(PATCH, { payload: {}, steps: {} })) as { write: boolean }
    expect(out.write).toBe(false)
  })
})

describe('resolve_click_input', () => {
  const PROSPECT_18 = 'a0P5f00000TestA1AA'
  const SUBMISSION_15 = 'a0S5f00000TestZ'
  type Resolved = { valid: boolean; reason: string | null; source: string | null; prospect_id: string | null; submission_id: string | null; prospect_soql: string | null }
  const resolve = async (payload: unknown) => (await runCanvasScript(RESOLVE, { payload, steps: {} })) as Resolved

  it('uses a valid Prospect__c directly and queries it by id, with every field his flow read plus the two offer fields', async () => {
    const r = await resolve({ Prospect__c: PROSPECT_18 })
    expect(r).toMatchObject({ valid: true, reason: null, source: 'prospect', prospect_id: PROSPECT_18, submission_id: null })
    expect(r.prospect_soql).toMatch(new RegExp(`FROM Prospect__c WHERE Id = '${PROSPECT_18}'$`))
    for (const f of ['SocialSecurityNumber__c', 'User_IP__c', 'ExternalRoutingCode__c', 'ExternalExchangeStatus__c']) expect(r.prospect_soql).toContain(f)
  })

  it('a valid Submission__c resolves the prospect through the submission, and keeps the submission for the patch', async () => {
    const r = await resolve({ Submission__c: SUBMISSION_15 })
    expect(r).toMatchObject({ valid: true, source: 'submission', prospect_id: null, submission_id: SUBMISSION_15 })
    expect(r.prospect_soql).toMatch(new RegExp(`WHERE Id IN \\(SELECT Prospect__c FROM Submission__c WHERE Id = '${SUBMISSION_15}'\\)$`))
  })

  it('a valid Prospect__c wins over a Submission__c, which is then ignored: nothing ties that submission to this prospect', async () => {
    const r = await resolve({ Prospect__c: PROSPECT_18, Submission__c: SUBMISSION_15 })
    expect(r).toMatchObject({ source: 'prospect', prospect_id: PROSPECT_18, submission_id: null })
  })

  it('an invalid Prospect__c falls back to a valid Submission__c, as his run() did', async () => {
    const r = await resolve({ Prospect__c: 'nope', Submission__c: SUBMISSION_15 })
    expect(r).toMatchObject({ valid: true, source: 'submission', submission_id: SUBMISSION_15 })
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
      expect(r).toEqual({ valid: false, reason, source: null, prospect_id: null, submission_id: null, prospect_soql: null })
    })
  }
})
