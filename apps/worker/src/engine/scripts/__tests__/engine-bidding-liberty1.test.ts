/**
 * A click sold buyer offered on a KNOWN Tripoint no (#1544, milestone "Click
 * sold buyers").
 *
 * Three kept scripts carry it. `known_no_gate` decides whether the lead is a
 * known no, reading the same node `build_response_body` reads its sale from, so
 * it keeps working when buyer_select sells live at Stage B. The canvas Branch
 * after it sends a known no to buyer_click_check. `build_response_body` offers
 * the click buyer when the gate said known no AND the check routed eligible,
 * and `patch_prospect_body` writes the buyer's own facts to the prospect,
 * keeping Tripoint's class from the decline. Every partner fact comes from the
 * check's output: no script names the buyer (EvaFi follows Liberty1).
 *
 * An UNKNOWN Tripoint answer (a timeout, a proxy 5xx, 1009 in progress) is
 * never a known no, because Tripoint may have bought the lead and a second
 * offer would sell it twice (Dan, 2026-09-24).
 */
import { describe, expect, it } from 'vitest'
import success1001 from '../../../../../../packages/buyer-profile/fixtures/tripoint/success-1001.json'
import duplicate1003 from '../../../../../../packages/buyer-profile/fixtures/tripoint/duplicate-1003.json'
import inProgress1009 from '../../../../../../packages/buyer-profile/fixtures/tripoint/in-progress-1009.json'
import invalid502 from '../../../../../../packages/buyer-profile/fixtures/tripoint/invalid-502.json'
import fixtures from './fixtures/engine-lead.json'
import expected from './fixtures/expected-live-2026-09-22.json'
import { KEPT_ENGINE_SCRIPTS } from '../../../lib/engine-script-drift'
import { answerWith, runCanvasScript, type CanvasRun } from './canvas-script'

const keptScript = (namespace: string): string => {
  const kept = KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === namespace)
  if (!kept) throw new Error(`no kept script for ${namespace}`)
  return kept.script
}
const TRIPOINT_PING = keptScript('tripoint_ping')
const KNOWN_NO_GATE = keptScript('known_no_gate')
const BUILD_RESPONSE_BODY = keptScript('build_response_body')
const PATCH_PROSPECT_BODY = keptScript('patch_prospect_body')

type Json = Record<string, unknown>
type Response = { isRejected: boolean; body: Json; reject_patch?: Json; sale?: Json; declined_sale?: Json; click_offer?: Json }
const ARMS = expected.arms as Record<string, { response: Response; patch_prospect_body: Json | null }>

const common = { payload: fixtures.payload, env: fixtures.env, execution: fixtures.execution }
const PROSPECT_ID = fixtures.create_prospect.id
const baseSteps = (pt: Json = fixtures.prospect_trades_sell_off): CanvasRun['steps'] => ({
  constants: { output: fixtures.constants },
  prospect_trades: { output: { body: pt } },
  create_prospect: { output: { body: fixtures.create_prospect } },
})

/** Invented partner facts, the shape buyer_click_check emits: no script may carry any of them. */
const CHECK_FACTS = {
  partner_id: '0192a4f0-0000-7000-8000-00000000a1b1',
  partner_slug: 'clickbuyer',
  partner_name: 'Click Buyer Inc',
  click_url: 'https://portal.example-click.test/offer/{prospect_id}',
  external_routing_code: 4,
}
const checkOutput = (route: 'eligible' | 'not_eligible', over: Json = {}): Json => ({
  _route: route,
  reason: route === 'eligible' ? 'eligible' : 'daily_click_cap',
  population: 'engine',
  ...CHECK_FACTS,
  count: 12,
  daily_lead_cap: 50,
  count_date: '2026-09-29',
  profile_served_from: 'cache',
  duration_ms: 4,
  ...over,
})

/**
 * A buyer_select output as the node emits it on a route, with the reason it gives. A
 * declined_by_buyer carries the detail the node writes for Tripoint's invalid data 502
 * ("http 502", no result code), the decline the gate can tell from a 1009 (#1653); every
 * Tripoint answer through the real node is in known-no-gate-buyer-select.test.ts.
 */
const buyerSelect = (route: string, reason: string, mode = 'live'): Json => ({
  _route: route,
  reason,
  ...(reason === 'declined_by_buyer' ? { detail: 'http 502' } : {}),
  mode_effective: mode,
  population: 'engine',
  sale: {
    skipped: route !== 'sold' && route !== 'no_sale', accepted: route === 'sold', buyer_reference: route === 'sold' ? 'L-1' : null,
    result_code: route === 'sold' ? '1001' : null, partner_slug: route === 'sold' || route === 'no_sale' ? 'tripoint' : null,
    partner_name: route === 'sold' ? 'Tripoint' : null, click_url: route === 'sold' ? fixtures.constants.TripointClickUrl : null,
    routing_code: route === 'sold' ? 2 : null, response_class: route === 'sold' ? 'Success' : route === 'no_sale' ? 'Fail' : null,
  },
  considered: [],
})

async function ping(steps: CanvasRun['steps'], answer: { httpStatus: number; body: unknown } | 'throws'): Promise<Json> {
  const fetch: CanvasRun['fetch'] = answer === 'throws' ? async () => { throw new Error('socket hang up') } : answerWith(answer.httpStatus, answer.body)
  return (await runCanvasScript(TRIPOINT_PING, { ...common, steps, fetch })) as Json
}
const gate = async (steps: CanvasRun['steps']) => (await runCanvasScript(KNOWN_NO_GATE, { ...common, steps })) as { known_no: boolean; decided_by: string | null; answer: string | null }

/**
 * The canvas in order: tripoint_ping (or buyer_select alone at Stage B), the gate, the
 * check only when the Branch sends a known no to it, then build_response_body, then
 * patch_prospect_body on the offer path.
 */
async function runChain(opts: { steps: CanvasRun['steps']; check?: Json }) {
  const { steps } = opts
  steps.known_no_gate = { output: await gate(steps) }
  if ((steps.known_no_gate.output as { known_no: boolean }).known_no && opts.check) steps.buyer_click_check = { output: opts.check }
  const response = (await runCanvasScript(BUILD_RESPONSE_BODY, { ...common, steps })) as Response
  steps.build_response_body = { output: response }
  let patch: Json | null = null
  if (!response.isRejected) {
    steps.offer_response = { output: { body: response.body } }
    patch = (await runCanvasScript(PATCH_PROSPECT_BODY, { ...common, steps })) as Json
  }
  return { response, patch, gate: steps.known_no_gate.output as { known_no: boolean } }
}

// ─── The gate ───────────────────────────────────────────────────────────────

describe('known_no_gate: a known no from tripoint_ping (Stage A, every lead today)', () => {
  const cases: Array<[string, { httpStatus: number; body: unknown } | 'throws', boolean, string]> = [
    ['1003 duplicate', duplicate1003, true, 'declined'],
    ['the known invalid data 502', invalid502, true, 'invalid_data'],
    ['the known null id 502', { httpStatus: 502, body: fixtures.tripoint_null_id_502.body }, true, 'null_id_fault'],
    ['1001 accepted', success1001, false, 'accepted'],
    ['1009 in progress', inProgress1009, false, 'in_progress'],
    ['an unrecognised 504', { httpStatus: 504, body: { message: 'gateway timeout' } }, false, 'unknown'],
    ['a fetch that throws', 'throws', false, 'unknown'],
  ]
  for (const [name, answer, knownNo, word] of cases) {
    it(`${name}: tripoint_answer ${word} is ${knownNo ? '' : 'not '}a known no`, async () => {
      const steps = baseSteps()
      steps.tripoint_ping = { output: await ping(steps, answer) }
      expect((steps.tripoint_ping.output as Json).tripoint_answer).toBe(word)
      expect(await gate(steps)).toEqual({ known_no: knownNo, decided_by: 'tripoint_ping', answer: word })
    })
  }

  it('a skipped ping (not a sell off) is not a known no', async () => {
    const steps = baseSteps(fixtures.prospect_trades_not_sell_off)
    steps.tripoint_ping = { output: await ping(steps, success1001) }
    expect(await gate(steps)).toEqual({ known_no: false, decided_by: 'tripoint_ping', answer: 'skipped' })
  })

  it('an older tripoint_ping that names no answer is not a known no, whatever its result code says', async () => {
    const steps = baseSteps()
    steps.tripoint_ping = { output: { skipped: false, qualified: false, resultCode: 1003, createLead: null } }
    expect(await gate(steps)).toEqual({ known_no: false, decided_by: 'tripoint_ping', answer: null })
  })

  it('an answer word it does not know is not a known no', async () => {
    const steps = baseSteps()
    steps.tripoint_ping = { output: { skipped: false, qualified: false, resultCode: null, sale: { skipped: false, accepted: false }, tripoint_answer: 'declined_twice' } }
    expect((await gate(steps)).known_no).toBe(false)
  })

  it('tripoint_ping decides even beside a buyer_select rehearsal, exactly as build_response_body reads the sale', async () => {
    const steps = baseSteps()
    steps.buyer_select = { output: buyerSelect('no_sale', 'declined_by_buyer', 'decide_only') }
    steps.tripoint_ping = { output: await ping(steps, success1001) }
    expect(await gate(steps)).toEqual({ known_no: false, decided_by: 'tripoint_ping', answer: 'accepted' })
  })
})

describe('known_no_gate: a known no from buyer_select (Stage B, the node sells live and tripoint_ping does not run)', () => {
  // [route, reason, known no, the answer the gate names]: a decline is named in tripoint_ping's words.
  const cases: Array<[string, string, boolean, string?]> = [
    ['no_sale', 'declined_by_buyer', true, 'declined'],
    ['no_sale', 'buyer_error', false],
    ['no_sale', 'outcome_unknown', false],
    ['no_sale', 'circuit_open', false],
    ['no_sale', 'daily_lead_cap', false],
    ['no_sale', 'hourly_lead_cap', false],
    ['no_sale', 'cap_check_error', false],
    ['no_sale', 'no_eligible_buyer', false],
    ['sold', 'sold', false],
    ['no_sale', 'already_sold', false],
    ['no_sale', 'sale_in_flight', false],
    ['no_sale', 'object_deadline', false],
    ['not_applicable', 'sell_off_false', false],
    ['deferred', 'canary_out', false],
    ['deferred', 'decide_only', false],
  ]
  for (const [route, reason, knownNo, answer] of cases) {
    it(`${route} ${reason} is ${knownNo ? '' : 'not '}a known no`, async () => {
      const steps = baseSteps()
      steps.buyer_select = { output: buyerSelect(route, reason) }
      expect(await gate(steps)).toEqual({ known_no: knownNo, decided_by: 'buyer_select', answer: answer ?? reason })
    })
  }

  it('with neither node run there is nothing to judge and no known no', async () => {
    expect(await gate(baseSteps())).toEqual({ known_no: false, decided_by: null, answer: null })
  })
})

// ─── build_response_body and patch_prospect_body ─────────────────────────────

/** The sold 1001 offer with the landing page the click buyer names, and nothing else changed. */
const expectedClickBody = (): Json => {
  const body = structuredClone(ARMS.sold_1001.response.body) as { offers: Json[] }
  body.offers[0].click_url = `https://portal.example-click.test/offer/${PROSPECT_ID}`
  return body
}

describe('a known no the check found eligible is offered to the click buyer', () => {
  it('Stage A, Tripoint declined 1003: the Tripoint sell off offer at engineBid, landing on the buyer click URL with the prospect id', async () => {
    const steps = baseSteps()
    steps.tripoint_ping = { output: await ping(steps, duplicate1003) }
    const { response, patch } = await runChain({ steps, check: checkOutput('eligible') })
    expect(response.isRejected).toBe(false)
    expect(JSON.stringify(response.body)).toBe(JSON.stringify(expectedClickBody()))
    expect((response.body.offers as Json[])[0].rate).toBe(fixtures.prospect_trades_sell_off.engineBid)
    expect(response.sale).toEqual({
      skipped: false, accepted: true, buyer_reference: null, result_code: null, partner_slug: 'clickbuyer', partner_name: 'Click Buyer Inc',
      click_url: `https://portal.example-click.test/offer/${PROSPECT_ID}`, routing_code: 4, response_class: null, sold_on: 'click',
    })
    expect(response.declined_sale).toMatchObject({ partner_slug: 'tripoint', accepted: false, response_class: 'Duplicate' })
    expect(response.click_offer).toEqual({ known_no: true, check_route: 'eligible', offered: true, reason: 'offered' })
    expect(patch).toEqual({
      BidAmount__c: 0.65,
      BidStatus__c: 'Bid',
      OfferLandingPage__c: `https://portal.example-click.test/offer/${PROSPECT_ID}`,
      Base_Bid__c: 0.5,
      Tripoint_Response__c: 'Duplicate',
      ExternalPartnerName__c: 'Click Buyer Inc',
      ExternalDebtAmount__c: 22100,
      ExternalRoutingCode__c: 4,
      ExternalExchangeStatus__c: 'Bid',
    })
  })

  it('Stage A, the invalid data 502: offered, and the patch carries no Tripoint class because Tripoint gave none', async () => {
    const steps = baseSteps()
    steps.tripoint_ping = { output: await ping(steps, invalid502) }
    const { response, patch } = await runChain({ steps, check: checkOutput('eligible') })
    expect(response.isRejected).toBe(false)
    expect(patch).not.toHaveProperty('Tripoint_Response__c')
    expect(patch).not.toHaveProperty('TripointLeadID__c')
    expect(patch).toMatchObject({ ExternalPartnerName__c: 'Click Buyer Inc', ExternalRoutingCode__c: 4, BidAmount__c: 0.65, BidStatus__c: 'Bid', ExternalExchangeStatus__c: 'Bid' })
  })

  it('Stage B, buyer_select declined_by_buyer with no tripoint_ping step: offered the same way', async () => {
    const steps = baseSteps()
    steps.buyer_select = { output: buyerSelect('no_sale', 'declined_by_buyer') }
    const { response, patch } = await runChain({ steps, check: checkOutput('eligible') })
    expect(response.isRejected).toBe(false)
    expect(JSON.stringify(response.body)).toBe(JSON.stringify(expectedClickBody()))
    expect(patch).toMatchObject({ Tripoint_Response__c: 'Fail', ExternalPartnerName__c: 'Click Buyer Inc', ExternalRoutingCode__c: 4 })
  })

  it('a click URL with the placeholder more than once gets the prospect id at every place', async () => {
    const steps = baseSteps()
    steps.tripoint_ping = { output: await ping(steps, duplicate1003) }
    const { response } = await runChain({ steps, check: checkOutput('eligible', { click_url: 'https://x.test/{prospect_id}?p={prospect_id}' }) })
    expect((response.body.offers as Json[])[0].click_url).toBe(`https://x.test/${PROSPECT_ID}?p=${PROSPECT_ID}`)
  })
})

describe('everything else is rejected exactly as today', () => {
  /** The live reject response and patch for a declined sell off lead, which a known no the check refused must still get. */
  const declinedResponse = ARMS.declined_1003.response

  it('the check routed not_eligible: the normal reject, Tripoint class kept on the reject patch', async () => {
    const steps = baseSteps()
    steps.tripoint_ping = { output: await ping(steps, duplicate1003) }
    const { response, patch } = await runChain({ steps, check: checkOutput('not_eligible') })
    expect(response.isRejected).toBe(true)
    expect(response.body).toEqual(declinedResponse.body)
    expect(response.reject_patch).toEqual({ BidStatus__c: 'Rejected', RejectionReason__c: 'unqualified_lead', Tripoint_Response__c: 'Duplicate' })
    expect(response.click_offer).toEqual({ known_no: true, check_route: 'not_eligible', offered: false, reason: 'daily_click_cap' })
    expect(patch).toBeNull()
  })

  it('an unknown Tripoint answer never reaches the check, and is rejected even if a check output is lying around', async () => {
    const steps = baseSteps()
    steps.tripoint_ping = { output: await ping(steps, { httpStatus: 504, body: {} }) }
    steps.buyer_click_check = { output: checkOutput('eligible') }
    const { response, gate: g } = await runChain({ steps })
    expect(g.known_no).toBe(false)
    expect(response.isRejected).toBe(true)
    expect(response.click_offer).toEqual({ known_no: false, check_route: 'eligible', offered: false, reason: 'not_a_known_no' })
  })

  it('1009 in progress is rejected, never offered', async () => {
    const steps = baseSteps()
    steps.tripoint_ping = { output: await ping(steps, inProgress1009) }
    const { response } = await runChain({ steps, check: checkOutput('eligible') })
    expect(response.isRejected).toBe(true)
  })

  it('a known no whose check did not run (the Branch sent it elsewhere) is rejected', async () => {
    const steps = baseSteps()
    steps.tripoint_ping = { output: await ping(steps, duplicate1003) }
    const { response } = await runChain({ steps })
    expect(response.isRejected).toBe(true)
    expect(response.click_offer).toEqual({ known_no: true, check_route: null, offered: false, reason: 'check_not_run' })
  })

  it('an eligible check with no click URL, or one with no place for the prospect id, is rejected and says why', async () => {
    for (const [click_url, reason] of [[null, 'no_click_url'], ['https://portal.example-click.test/offer', 'click_url_has_no_prospect_id']] as const) {
      const steps = baseSteps()
      steps.tripoint_ping = { output: await ping(steps, duplicate1003) }
      const { response } = await runChain({ steps, check: checkOutput('eligible', { click_url }) })
      expect(response.isRejected, String(click_url)).toBe(true)
      expect(response.click_offer, String(click_url)).toEqual({ known_no: true, check_route: 'eligible', offered: false, reason })
    }
  })

  it('an eligible check that names no buyer is rejected', async () => {
    const steps = baseSteps()
    steps.tripoint_ping = { output: await ping(steps, duplicate1003) }
    const { response } = await runChain({ steps, check: checkOutput('eligible', { partner_slug: null }) })
    expect(response.isRejected).toBe(true)
    expect(response.click_offer).toMatchObject({ offered: false, reason: 'check_names_no_buyer' })
  })

  it('a Tripoint sale is Tripoint\'s whatever the gate or a check output say: the offer lands on Tripoint', async () => {
    const steps = baseSteps()
    steps.tripoint_ping = { output: await ping(steps, success1001) }
    steps.known_no_gate = { output: { known_no: true, decided_by: 'tripoint_ping', answer: 'declined' } }
    steps.buyer_click_check = { output: checkOutput('eligible') }
    const response = (await runCanvasScript(BUILD_RESPONSE_BODY, { ...common, steps })) as Response
    expect(response.isRejected).toBe(false)
    expect(JSON.stringify(response.body)).toBe(JSON.stringify(ARMS.sold_1001.response.body))
    expect(response.sale).toMatchObject({ partner_slug: 'tripoint' })
  })

  it('a zero bid is rejected before any of this is read', async () => {
    const steps = baseSteps(fixtures.prospect_trades_zero_bid)
    steps.known_no_gate = { output: { known_no: true, decided_by: 'buyer_select', answer: 'declined_by_buyer' } }
    steps.buyer_click_check = { output: checkOutput('eligible') }
    const response = (await runCanvasScript(BUILD_RESPONSE_BODY, { ...common, steps })) as Response
    expect(response.isRejected).toBe(true)
    expect(response.body).toEqual(ARMS.zero_bid.response.body)
  })
})

describe('no script carries a partner fact', () => {
  it('the gate, build_response_body and patch_prospect_body name no click buyer and no routing code 4', () => {
    for (const [name, script] of [['known_no_gate', KNOWN_NO_GATE], ['build_response_body', BUILD_RESPONSE_BODY], ['patch_prospect_body', PATCH_PROSPECT_BODY]]) {
      expect(script, name).not.toMatch(/liberty|libertyone|evafi/i)
      expect(script, name).not.toMatch(/routing_code:\s*4|ExternalRoutingCode__c\s*=\s*4/)
    }
  })
})
