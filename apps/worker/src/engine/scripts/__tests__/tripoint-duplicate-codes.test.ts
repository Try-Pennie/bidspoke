/**
 * One list of Tripoint duplicate result codes for every consumer (#1549).
 *
 * Four places decide whether a Tripoint result code means Duplicate:
 *   1. the tripoint_ping canvas script, whose class reaches Salesforce's
 *      Tripoint_Response__c through build_response_body's reject_patch,
 *   2. build_response_body's transitional completion of an older tripoint_ping,
 *   3. classifyTripointResultCode in bid-resolver.ts, which bid-log.ts writes to
 *      lead_sighting_bids and so to Snowflake,
 *   4. partner_configs.duplicate_signals, which the buyer_select node reads
 *      through responseClassOf.
 * The canvas scripts run in a sandbox and cannot import, so they carry the list
 * as a literal. What keeps them one list is this test: every code in a wide
 * range is classified by all four, and all four must agree with
 * TRIPOINT_DUPLICATE_RESULT_CODES. Before #1549 the scripts said 1003, 1004 and
 * 1020 while the classifier said 1002 to 1005 and 1020, so a 1002 or a 1005 was
 * written to Salesforce as Fail and reported to Snowflake as a duplicate.
 */
import { describe, expect, it } from 'vitest'
import { responseClassOf } from '@bidspoke/buyer-profile'
import duplicate1002 from '../../../../../../packages/buyer-profile/fixtures/tripoint/duplicate-1002.json'
import duplicate1003 from '../../../../../../packages/buyer-profile/fixtures/tripoint/duplicate-1003.json'
import duplicate1005 from '../../../../../../packages/buyer-profile/fixtures/tripoint/duplicate-1005.json'
import inProgress1009 from '../../../../../../packages/buyer-profile/fixtures/tripoint/in-progress-1009.json'
import success1001 from '../../../../../../packages/buyer-profile/fixtures/tripoint/success-1001.json'
import fixtures from './fixtures/engine-lead.json'
import { KEPT_ENGINE_SCRIPTS } from '../../../lib/engine-script-drift'
import { TRIPOINT_DUPLICATE_RESULT_CODES, TRIPOINT_DUPLICATE_SIGNALS, classifyTripointResultCode } from '../../bid-resolver'
import { answerWith, runCanvasScript, type CanvasRun } from './canvas-script'

const keptScript = (namespace: string): string => {
  const kept = KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === namespace)
  if (!kept) throw new Error(`no kept script for ${namespace}`)
  return kept.script
}
const TRIPOINT_PING = keptScript('tripoint_ping')
const BUILD_RESPONSE_BODY = keptScript('build_response_body')

type Class = 'Success' | 'Duplicate' | 'Fail' | null
const common = { payload: fixtures.payload, env: fixtures.env, execution: fixtures.execution }
const steps = (): CanvasRun['steps'] => ({
  constants: { output: fixtures.constants },
  prospect_trades: { output: { body: fixtures.prospect_trades_sell_off } },
  create_prospect: { output: { body: fixtures.create_prospect } },
})
/** A 200 answer carrying one result code, in the shape of the captured fixtures. */
const answerFor = (resultCode: unknown) => ({
  ok: true,
  data: { createLead: { id: 'masked', resultCode, note: 'synthetic', partnerLeadId: 'masked', bidValue: null } },
})

/** Consumer 1: what tripoint_ping itself classes the answer as. */
async function pingClass(body: unknown, httpStatus = 200): Promise<Class> {
  const out = (await runCanvasScript(TRIPOINT_PING, { ...common, steps: steps(), fetch: answerWith(httpStatus, body) })) as { sale: { response_class: Class } }
  return out.sale.response_class
}

/** Consumer 2: build_response_body completing an older tripoint_ping that carries no sale, read from the Salesforce reject patch. */
async function transitionalClass(resultCode: number): Promise<Class> {
  const s = steps()
  const accepted = classifyTripointResultCode(resultCode) === 'Success'
  s.tripoint_ping = { output: { skipped: false, qualified: accepted, resultCode, createLead: { id: 'masked' } } }
  const out = (await runCanvasScript(BUILD_RESPONSE_BODY, { ...common, steps: s })) as {
    isRejected: boolean
    reject_patch?: { Tripoint_Response__c?: Class }
    sale: { response_class: Class }
  }
  if (out.isRejected) expect(out.reject_patch?.Tripoint_Response__c ?? null).toBe(out.sale.response_class)
  return out.sale.response_class
}

/** Consumer 4: the buyer_select node over the partner record's duplicate rules, on a decline. */
const nodeClass = (resultCode: unknown): Class =>
  classifyTripointResultCode(Number(resultCode)) === 'Success'
    ? responseClassOf('accepted', TRIPOINT_DUPLICATE_SIGNALS, answerFor(resultCode))
    : responseClassOf('declined_by_buyer', TRIPOINT_DUPLICATE_SIGNALS, answerFor(resultCode))

// Every documented code and well past them on both sides.
const CODES = Array.from({ length: 1101 - 990 }, (_, i) => 990 + i)

describe('Tripoint duplicate result codes: one list (#1549)', () => {
  it('the list is 1002 to 1005 and 1020', () => {
    expect([...TRIPOINT_DUPLICATE_RESULT_CODES].sort((a, b) => a - b)).toEqual([1002, 1003, 1004, 1005, 1020])
  })

  it('the partner record value is exactly one rule over the result code, carrying the list', () => {
    expect(TRIPOINT_DUPLICATE_SIGNALS).toEqual([{ field: 'data.createLead.resultCode', in: [...TRIPOINT_DUPLICATE_RESULT_CODES] }])
  })

  it('tripoint_ping, build_response_body, the sightings classifier and the node agree on every code 990 to 1100', async () => {
    const disagreements: string[] = []
    for (const code of CODES) {
      const want = classifyTripointResultCode(code)
      const got = {
        tripoint_ping: await pingClass(answerFor(code)),
        build_response_body: await transitionalClass(code),
        buyer_select: nodeClass(code),
      }
      for (const [who, cls] of Object.entries(got)) if (cls !== want) disagreements.push(`${code}: ${who} says ${cls}, bid-resolver says ${want}`)
    }
    expect(disagreements).toEqual([])
  })

  it('the classifier says Duplicate exactly on the list, so the list is the only home of the decision', () => {
    const dupes = CODES.filter((c) => classifyTripointResultCode(c) === 'Duplicate')
    expect(dupes).toEqual([...TRIPOINT_DUPLICATE_RESULT_CODES].sort((a, b) => a - b))
  })

  it("every captured answer whose note says Duplicate Lead is a Duplicate in every consumer, and 1009 (a submission still in progress) is not", async () => {
    for (const f of [duplicate1002, duplicate1003, duplicate1005]) {
      const code = f.body.data.createLead.resultCode
      expect(f.body.data.createLead.note).toMatch(/Duplicate Lead/)
      expect(classifyTripointResultCode(code)).toBe('Duplicate')
      expect(await pingClass(f.body, f.httpStatus)).toBe('Duplicate')
      expect(nodeClass(code)).toBe('Duplicate')
    }
    expect(await pingClass(success1001.body, success1001.httpStatus)).toBe('Success')
    expect(classifyTripointResultCode(inProgress1009.body.data.createLead.resultCode)).toBe('Fail')
    expect(await pingClass(inProgress1009.body, inProgress1009.httpStatus)).toBe('Fail')
  })

  it('a code sent as a string is classed like the number, and an answer with no code carries no class at all', async () => {
    expect(await pingClass(answerFor('1002'))).toBe('Duplicate')
    expect(await pingClass(answerFor('1005'))).toBe('Duplicate')
    expect(await pingClass(answerFor(null))).toBeNull()
    expect(classifyTripointResultCode(Number.NaN)).toBe('Fail')
  })

  it('the old script list is caught: a consumer still on 1003, 1004 and 1020 disagrees on 1002 and 1005', () => {
    const oldScript = (code: number) => ([1003, 1004, 1020].includes(code) ? 'Duplicate' : 'Fail')
    const caught = [1002, 1005].filter((code) => oldScript(code) !== classifyTripointResultCode(code))
    expect(caught).toEqual([1002, 1005])
  })
})
