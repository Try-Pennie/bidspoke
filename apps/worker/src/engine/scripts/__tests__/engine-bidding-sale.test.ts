/**
 * The Engine Bidding Workflow's three sale scripts, kept in the repo for the
 * buyer_select cutover (#1414, Phase 7).
 *
 * Two promises, each proved here. First, a lead that takes the legacy path
 * (tripoint_ping runs) gets byte for byte the response body Engine receives and
 * the Salesforce patch body it receives today: the expectations were recorded
 * from the LIVE scripts over the same inputs (expected-live-2026-09-22.json).
 * Second, a lead the buyer_select node decided gets the same two bodies as the
 * legacy arm it corresponds to, read from the node's `sale` output, and a lead
 * the node passed on (not_applicable, deferred) is decided by tripoint_ping as
 * today. tripoint_ping's two new fields, `sale` and `sent_body_sha256`, sit
 * beside every field it emits today, and the hash equals the one the node
 * computes for the same body so the parity report can compare them.
 */
import { describe, expect, it, vi } from 'vitest'
import { canonicalBodySha256 } from '@bidspoke/buyer-profile'
import success1001 from '../../../../../../packages/buyer-profile/fixtures/tripoint/success-1001.json'
import duplicate1003 from '../../../../../../packages/buyer-profile/fixtures/tripoint/duplicate-1003.json'
import invalid502 from '../../../../../../packages/buyer-profile/fixtures/tripoint/invalid-502.json'
import fixtures from './fixtures/engine-lead.json'
import expected from './fixtures/expected-live-2026-09-22.json'
import { KEPT_ENGINE_SCRIPTS } from '../../../lib/engine-script-drift'
import { answerWith, runCanvasScript, type CanvasRun } from './canvas-script'

// The same text the hourly drift check compares against the canvas (#1472), so
// the scripts proven here are the scripts that check confirms were pasted.
const keptScript = (namespace: string): string => {
  const kept = KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === namespace)
  if (!kept) throw new Error(`no kept script for ${namespace}`)
  return kept.script
}
const TRIPOINT_PING = keptScript('tripoint_ping')
const BUILD_RESPONSE_BODY = keptScript('build_response_body')
const PATCH_PROSPECT_BODY = keptScript('patch_prospect_body')

type Json = Record<string, unknown>
type Sale = { skipped: boolean; accepted: boolean; buyer_reference: string | null; result_code: string | null; partner_slug: string | null }
type Arm = { tripoint_ping: Json; response: { isRejected: boolean; body: Json }; patch_prospect_body: Json | null }
const ARMS = expected.arms as Record<string, Arm>

const common = { payload: fixtures.payload, env: fixtures.env, execution: fixtures.execution }
const baseSteps = (pt: Json): CanvasRun['steps'] => ({
  constants: { output: fixtures.constants },
  prospect_trades: { output: { body: pt } },
  create_prospect: { output: { body: fixtures.create_prospect } },
})

/** tripoint_ping, then build_response_body, then patch_prospect_body on the offer path: the three steps the canvas runs in that order. */
async function runChain(steps: CanvasRun['steps'], fetch: CanvasRun['fetch'] | null, runTripoint = true) {
  if (runTripoint) steps.tripoint_ping = { output: await runCanvasScript(TRIPOINT_PING, { ...common, steps, fetch: fetch ?? undefined }) }
  const response = (await runCanvasScript(BUILD_RESPONSE_BODY, { ...common, steps })) as Arm['response']
  let patch: Json | null = null
  if (!response.isRejected) {
    steps.offer_response = { output: { body: response.body } }
    patch = (await runCanvasScript(PATCH_PROSPECT_BODY, { ...common, steps })) as Json
  }
  return { tripoint_ping: steps.tripoint_ping?.output as Json | undefined, response, patch }
}

const withoutNewFields = (tp: Json): Json => {
  const { sale: _sale, sent_body_sha256: _hash, ...rest } = tp
  return rest
}

/** The recorded responses predate `reject_patch` (#1471), so byte equality is on the fields they hold; the new field has its own tests below. */
const legacyResponse = (r: Arm['response'] & { reject_patch?: unknown }): Arm['response'] => {
  const { reject_patch: _patch, ...rest } = r
  return rest
}

const sale = (over: Partial<Sale>): Sale => ({ skipped: false, accepted: false, buyer_reference: null, result_code: null, partner_slug: 'tripoint', ...over })
const nodeStep = (route: string, s: Sale) => ({ output: { _route: route, reason: route, mode_effective: 'live', population: 'engine', sale: s } })

describe('legacy arms: a lead tripoint_ping decides gets exactly what it gets today', () => {
  const legacy: Array<[string, Json, { httpStatus: number; body: unknown } | null]> = [
    ['skipped_not_sell_off', fixtures.prospect_trades_not_sell_off, null],
    ['zero_bid', fixtures.prospect_trades_zero_bid, null],
    ['sold_1001', fixtures.prospect_trades_sell_off, success1001],
    ['declined_1003', fixtures.prospect_trades_sell_off, duplicate1003],
    ['fault_null_id_502', fixtures.prospect_trades_sell_off, fixtures.tripoint_null_id_502],
    ['fault_invalid_502', fixtures.prospect_trades_sell_off, invalid502],
  ]

  for (const [name, pt, answer] of legacy) {
    it(`${name}: response body and patch body are byte for byte the live scripts' output, and every live tripoint_ping field is unchanged`, async () => {
      const got = await runChain(baseSteps(pt), answer ? answerWith(answer.httpStatus, answer.body) : null)
      expect(JSON.stringify(legacyResponse(got.response))).toBe(JSON.stringify(ARMS[name].response))
      expect(JSON.stringify(got.patch)).toBe(JSON.stringify(ARMS[name].patch_prospect_body))
      expect(JSON.stringify(withoutNewFields(got.tripoint_ping as Json))).toBe(JSON.stringify(ARMS[name].tripoint_ping))
    })
  }

  it('the sold arm writes the four External fields and Success; the declined arm is rejected before any patch body exists', () => {
    // Measured 2026-09-22: patch_prospect_body runs only on the offer path, so a
    // declined sell off lead never reaches it (issue #1414, fact 10 corrected).
    const sold = ARMS.sold_1001.patch_prospect_body as Json
    expect(sold).toMatchObject({ ExternalPartnerName__c: 'Tripoint', ExternalDebtAmount__c: 22100, ExternalRoutingCode__c: 2, ExternalExchangeStatus__c: 'Bid', Tripoint_Response__c: 'Success', TripointLeadID__c: 'masked' })
    expect(ARMS.declined_1003.response.isRejected).toBe(true)
    expect(ARMS.declined_1003.patch_prospect_body).toBeNull()
  })
})

describe("tripoint_ping's new fields", () => {
  it('a sold lead carries a sale in the shape the buyer_select node emits, beside every existing field', async () => {
    const steps = baseSteps(fixtures.prospect_trades_sell_off)
    const tp = (await runCanvasScript(TRIPOINT_PING, { ...common, steps, fetch: answerWith(success1001.httpStatus, success1001.body) })) as Json
    expect(tp.sale).toEqual({ skipped: false, accepted: true, buyer_reference: 'masked', result_code: '1001', partner_slug: 'tripoint' })
    expect(tp.qualified).toBe(true)
  })

  it('a declined lead and both 502 faults carry an unaccepted sale, with the result code when Tripoint gave one', async () => {
    const steps = baseSteps(fixtures.prospect_trades_sell_off)
    const declined = (await runCanvasScript(TRIPOINT_PING, { ...common, steps, fetch: answerWith(duplicate1003.httpStatus, duplicate1003.body) })) as Json
    expect(declined.sale).toEqual({ skipped: false, accepted: false, buyer_reference: 'masked', result_code: '1003', partner_slug: 'tripoint' })
    const fault = (await runCanvasScript(TRIPOINT_PING, { ...common, steps, fetch: answerWith(502, fixtures.tripoint_null_id_502.body) })) as Json
    expect(fault.sale).toEqual({ skipped: false, accepted: false, buyer_reference: null, result_code: null, partner_slug: 'tripoint' })
    const invalid = (await runCanvasScript(TRIPOINT_PING, { ...common, steps, fetch: answerWith(invalid502.httpStatus, invalid502.body) })) as Json
    expect(invalid.sale).toEqual({ skipped: false, accepted: false, buyer_reference: null, result_code: null, partner_slug: 'tripoint' })
  })

  it('a skipped lead carries a skipped sale and no hash, because nothing was sent', async () => {
    const tp = (await runCanvasScript(TRIPOINT_PING, { ...common, steps: baseSteps(fixtures.prospect_trades_not_sell_off) })) as Json
    expect(tp.sale).toEqual({ skipped: true, accepted: false, buyer_reference: null, result_code: null, partner_slug: null })
    expect(tp.sent_body_sha256).toBeNull()
  })

  it('the sent body hash equals the shared hash of the exact body it sent, so parity can compare it with the node', async () => {
    let sent: string | null = null
    const steps = baseSteps(fixtures.prospect_trades_sell_off)
    const fetch: CanvasRun['fetch'] = async (_url, init) => { sent = init?.body ?? null; return { status: 200, text: async () => JSON.stringify(success1001.body) } }
    const tp = (await runCanvasScript(TRIPOINT_PING, { ...common, steps, fetch })) as Json
    expect(sent).not.toBeNull()
    const body = JSON.parse(sent as unknown as string) as Json
    expect(body.pennieLeadId).toBe('a0XSF0000001ABCD')
    expect((body.personalInformation as Json).ssn).toBe('123456789')
    expect(tp.sent_body_sha256).toBe(await canonicalBodySha256(body))
  })

  it('when the sandbox has no Web Crypto the hash is null and everything else is unchanged (unmeasured, never a wrong hash)', async () => {
    const steps = baseSteps(fixtures.prospect_trades_sell_off)
    vi.stubGlobal('crypto', undefined)
    try {
      const tp = (await runCanvasScript(TRIPOINT_PING, { ...common, steps, fetch: answerWith(success1001.httpStatus, success1001.body) })) as Json
      expect(tp.sent_body_sha256).toBeNull()
      expect(tp.sale).toEqual({ skipped: false, accepted: true, buyer_reference: 'masked', result_code: '1001', partner_slug: 'tripoint' })
      expect(JSON.stringify(withoutNewFields(tp))).toBe(JSON.stringify(ARMS.sold_1001.tripoint_ping))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('node arms: a lead the buyer_select node decided gets the bodies of its legacy counterpart', () => {
  it('node sold: the same response and patch as a legacy sale, TripointLeadID__c from the buyer reference', async () => {
    const steps = baseSteps(fixtures.prospect_trades_sell_off)
    steps.buyer_select = nodeStep('sold', sale({ accepted: true, buyer_reference: 'masked', result_code: '1001' }))
    const got = await runChain(steps, null, false)
    expect(JSON.stringify(legacyResponse(got.response))).toBe(JSON.stringify(ARMS.sold_1001.response))
    expect(JSON.stringify(got.patch)).toBe(JSON.stringify(ARMS.sold_1001.patch_prospect_body))
  })

  it('node no_sale, declined by the buyer: rejected exactly as a legacy decline', async () => {
    const steps = baseSteps(fixtures.prospect_trades_sell_off)
    steps.buyer_select = nodeStep('no_sale', sale({ accepted: false, buyer_reference: 'masked', result_code: '1003' }))
    const got = await runChain(steps, null, false)
    expect(JSON.stringify(legacyResponse(got.response))).toBe(JSON.stringify(ARMS.declined_1003.response))
    expect(got.patch).toBeNull()
  })

  it('node no_sale after a buyer error, no result code: rejected exactly as a legacy 502 fault', async () => {
    const steps = baseSteps(fixtures.prospect_trades_sell_off)
    steps.buyer_select = nodeStep('no_sale', sale({ accepted: false }))
    const got = await runChain(steps, null, false)
    expect(JSON.stringify(legacyResponse(got.response))).toBe(JSON.stringify(ARMS.fault_invalid_502.response))
  })

  it('node not_applicable: tripoint_ping still runs and still decides, so a non sell off lead gets its usual offer', async () => {
    const steps = baseSteps(fixtures.prospect_trades_not_sell_off)
    steps.buyer_select = nodeStep('not_applicable', sale({ skipped: true, partner_slug: null }))
    const got = await runChain(steps, null)
    expect(JSON.stringify(legacyResponse(got.response))).toBe(JSON.stringify(ARMS.skipped_not_sell_off.response))
    expect(JSON.stringify(got.patch)).toBe(JSON.stringify(ARMS.skipped_not_sell_off.patch_prospect_body))
  })

  it('node deferred (Stage A rehearsal): tripoint_ping runs, sells, and its sale wins over the node skipped one', async () => {
    const steps = baseSteps(fixtures.prospect_trades_sell_off)
    steps.buyer_select = nodeStep('deferred', sale({ skipped: true, partner_slug: null }))
    const got = await runChain(steps, answerWith(success1001.httpStatus, success1001.body))
    expect(JSON.stringify(legacyResponse(got.response))).toBe(JSON.stringify(ARMS.sold_1001.response))
    expect(JSON.stringify(got.patch)).toBe(JSON.stringify(ARMS.sold_1001.patch_prospect_body))
  })

  it('zero engineBid is rejected before any sale is read, whichever node produced it', async () => {
    const steps = baseSteps(fixtures.prospect_trades_zero_bid)
    steps.buyer_select = nodeStep('sold', sale({ accepted: true, buyer_reference: 'masked', result_code: '1001' }))
    const got = await runChain(steps, null, false)
    expect(JSON.stringify(legacyResponse(got.response))).toBe(JSON.stringify(ARMS.zero_bid.response))
  })

  it('a duplicate code on the offer path maps to Duplicate in the patch body, kept exactly as today even though no live path reaches it', async () => {
    // Reachable only if a sale is accepted with a duplicate code, which neither
    // node does today; the branch is preserved unchanged rather than deleted.
    const steps = baseSteps(fixtures.prospect_trades_sell_off)
    steps.buyer_select = nodeStep('sold', sale({ accepted: true, buyer_reference: 'masked', result_code: '1020' }))
    const got = await runChain(steps, null, false)
    expect(got.patch).toMatchObject({ Tripoint_Response__c: 'Duplicate', TripointLeadID__c: 'masked' })
  })

})

describe('mixed versions on the canvas (L640): the new response and patch scripts beside the OLD tripoint_ping', () => {
  // The recorded tripoint_ping outputs are the live script's, which carry no `sale`.
  // Pasting build_response_body or patch_prospect_body before tripoint_ping must
  // change nothing, so the three can go in any order.
  for (const name of ['sold_1001', 'declined_1003', 'fault_invalid_502', 'skipped_not_sell_off'] as const) {
    it(`${name}: the legacy tripoint_ping output still decides the response and the patch`, async () => {
      const steps = baseSteps(name === 'skipped_not_sell_off' ? fixtures.prospect_trades_not_sell_off : fixtures.prospect_trades_sell_off)
      steps.tripoint_ping = { output: ARMS[name].tripoint_ping }
      expect('sale' in ARMS[name].tripoint_ping).toBe(false)
      const got = await runChain(steps, null, false)
      expect(JSON.stringify(legacyResponse(got.response))).toBe(JSON.stringify(ARMS[name].response))
      expect(JSON.stringify(got.patch)).toBe(JSON.stringify(ARMS[name].patch_prospect_body))
    })
  }
})

describe('the reject patch (#1471): what patch_prospect_reject writes, built where the rejection is decided', () => {
  type Rejected = Arm['response'] & { reject_patch?: Record<string, unknown> }
  const rejectPatchOf = async (steps: CanvasRun['steps'], fetch: CanvasRun['fetch'] | null, runTripoint: boolean) =>
    ((await runChain(steps, fetch, runTripoint)).response as Rejected).reject_patch

  it('a declined sell off lead carries the class of its result code beside the two fields the node writes today', async () => {
    const patch = await rejectPatchOf(baseSteps(fixtures.prospect_trades_sell_off), answerWith(duplicate1003.httpStatus, duplicate1003.body), true)
    expect(patch).toEqual({ BidStatus__c: 'Rejected', RejectionReason__c: 'unqualified_lead', Tripoint_Response__c: 'Duplicate' })
  })

  it('a rejection with no result code (a zero bid, a 502 fault) carries exactly the two fields and no response class', async () => {
    expect(await rejectPatchOf(baseSteps(fixtures.prospect_trades_zero_bid), null, true)).toEqual({ BidStatus__c: 'Rejected', RejectionReason__c: 'unqualified_lead' })
    const fault = await rejectPatchOf(baseSteps(fixtures.prospect_trades_sell_off), answerWith(502, fixtures.tripoint_null_id_502.body), true)
    expect(fault).toEqual({ BidStatus__c: 'Rejected', RejectionReason__c: 'unqualified_lead' })
    expect(fault).not.toHaveProperty('Tripoint_Response__c')
  })

  it('an offer carries no reject patch at all', async () => {
    expect(await rejectPatchOf(baseSteps(fixtures.prospect_trades_sell_off), answerWith(success1001.httpStatus, success1001.body), true)).toBeUndefined()
    expect(await rejectPatchOf(baseSteps(fixtures.prospect_trades_not_sell_off), null, true)).toBeUndefined()
  })

  it('a decline the buyer_select node recorded maps its code the same way, and a code outside success and duplicate is Fail', async () => {
    const steps = baseSteps(fixtures.prospect_trades_sell_off)
    steps.buyer_select = nodeStep('no_sale', sale({ accepted: false, buyer_reference: 'masked', result_code: '1020' }))
    expect(await rejectPatchOf(steps, null, false)).toMatchObject({ Tripoint_Response__c: 'Duplicate' })
    steps.buyer_select = nodeStep('no_sale', sale({ accepted: false, buyer_reference: null, result_code: '2001' }))
    expect(await rejectPatchOf(steps, null, false)).toMatchObject({ Tripoint_Response__c: 'Fail' })
  })

  it('the old tripoint_ping on the canvas still yields the class, from its legacy resultCode (L640)', async () => {
    const steps = baseSteps(fixtures.prospect_trades_sell_off)
    steps.tripoint_ping = { output: ARMS.declined_1003.tripoint_ping }
    expect(await rejectPatchOf(steps, null, false)).toMatchObject({ Tripoint_Response__c: 'Duplicate' })
  })

  it('maps every code exactly as patch_prospect_body does on the offer path, so the two copies of the mapping cannot drift (L370)', async () => {
    for (const code of ['1000', '1001', '1002', '1003', '1004', '1005', '1013', '1014', '1015', '1016', '1017', '1020', '2001', '9999']) {
      const rejected = baseSteps(fixtures.prospect_trades_sell_off)
      rejected.buyer_select = nodeStep('no_sale', sale({ accepted: false, buyer_reference: 'masked', result_code: code }))
      const viaReject = (await rejectPatchOf(rejected, null, false))?.Tripoint_Response__c
      const offered = baseSteps(fixtures.prospect_trades_sell_off)
      offered.buyer_select = nodeStep('sold', sale({ accepted: true, buyer_reference: 'masked', result_code: code }))
      const viaOffer = ((await runChain(offered, null, false)).patch as Json).Tripoint_Response__c
      expect(viaReject, code).toBe(viaOffer)
    }
  })
})
