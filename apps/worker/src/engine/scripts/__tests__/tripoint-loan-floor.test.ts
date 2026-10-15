/**
 * tripoint_ping applies Tripoint's minimum loan amount (2026-10-15).
 *
 * Tripoint's buyer profile carries a 2,000 minimum loan amount (set 2026-10-13 at
 * Sam's request), and the buyer_select node judges it, but the old path is this
 * script, which never reads the profile, so it went on sending Tripoint every sell
 * off lead whatever the loan. On 2026-10-14 Tripoint accepted 74 of 1,357 leads
 * under 2,000 against 1,057 of 1,725 at 2,000 or more.
 *
 * The script refuses exactly as the node's eligibility rule does
 * (packages/buyer-profile/src/eligibility.ts): a loan under the minimum is
 * loan_amount_below_min, a loan amount that cannot be read is missing_lead_field,
 * and neither sends anything. Every live Engine lead measured on 2026-10-14 and 15
 * carried loanInformation.loanAmount as a number.
 */
import { describe, expect, it } from 'vitest'
import { parsePositiveAmount } from '@bidspoke/buyer-profile'
import success1001 from '../../../../../../packages/buyer-profile/fixtures/tripoint/success-1001.json'
import fixtures from './fixtures/engine-lead.json'
import { KEPT_ENGINE_SCRIPTS } from '../../../lib/engine-script-drift'
import { answerWith, runCanvasScript, type CanvasRun } from './canvas-script'

const keptScript = (namespace: string): string => {
  const kept = KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === namespace)
  if (!kept) throw new Error(`no kept script for ${namespace}`)
  return kept.script
}
const TRIPOINT_PING = keptScript('tripoint_ping')
const BUILD_RESPONSE_BODY = keptScript('build_response_body')

type Json = Record<string, unknown>

const sellOffSteps = (): CanvasRun['steps'] => ({
  constants: { output: fixtures.constants },
  prospect_trades: { output: { body: fixtures.prospect_trades_sell_off } },
  create_prospect: { output: { body: fixtures.create_prospect } },
})

/** The fixture lead with its loan section replaced, or removed when `loan` is undefined. */
const leadWithLoan = (loan: Json | undefined): Json => {
  const { loanInformation: _drop, ...rest } = fixtures.payload as Json
  return loan === undefined ? rest : { ...rest, loanInformation: loan }
}

async function ping(payload: Json) {
  let calls = 0
  const answer = answerWith(success1001.httpStatus, success1001.body)
  const fetch: CanvasRun['fetch'] = async (...args) => {
    calls += 1
    return answer!(...args)
  }
  const steps = sellOffSteps()
  const common = { payload, env: fixtures.env, execution: fixtures.execution }
  const tp = (await runCanvasScript(TRIPOINT_PING, { ...common, steps, fetch })) as Json
  steps.tripoint_ping = { output: tp }
  const response = (await runCanvasScript(BUILD_RESPONSE_BODY, { ...common, steps })) as { isRejected: boolean; body: Json }
  return { tp, response, calls }
}

describe('Tripoint is sent only a loan of 2,000 or more', () => {
  it('a 1,999 loan is not sent, and the lead takes the Pennie pages', async () => {
    const { tp, response, calls } = await ping(leadWithLoan({ loanAmount: 1999, purpose: 'other' }))
    expect(calls).toBe(0)
    expect(tp.skipped).toBe(true)
    expect(tp.tripoint_answer).toBe('skipped')
    expect(tp.skip_reason).toBe('loan_amount_below_min')
    expect((tp.sale as Json).skipped).toBe(true)
    expect(response.isRejected).toBe(false)
  })

  it('a 2,000 loan is sent', async () => {
    const { tp, calls } = await ping(leadWithLoan({ loanAmount: 2000, purpose: 'debt_consolidation' }))
    expect(calls).toBe(1)
    expect(tp.tripoint_answer).toBe('accepted')
    expect(tp.skip_reason).toBeUndefined()
  })

  it('a lead with no loan amount is not sent, named as a missing field', async () => {
    const { tp, calls } = await ping(leadWithLoan(undefined))
    expect(calls).toBe(0)
    expect(tp.skipped).toBe(true)
    expect(tp.skip_reason).toBe('missing_lead_field')
  })

  it('a loan amount that is not a number is a missing field, never a pass', async () => {
    const { tp, calls } = await ping(leadWithLoan({ loanAmount: 'lots', purpose: 'other' }))
    expect(calls).toBe(0)
    expect(tp.skip_reason).toBe('missing_lead_field')
  })

  it('reads an amount exactly as the node does (parsePositiveAmount), on every shape', async () => {
    const inputs: unknown[] = [1999, 2000, 2000.5, '2000', ' $2,500 ', '1,999', '$1999.99', '0', 0, -2500, '-2500', '2e3', '', 'lots', null, undefined, true, NaN, Infinity, [2500], { amount: 2500 }]
    for (const input of inputs) {
      const parsed = parsePositiveAmount(input)
      const expected = parsed === null ? 'missing_lead_field' : parsed < 2000 ? 'loan_amount_below_min' : undefined
      const { tp } = await ping(leadWithLoan({ loanAmount: input, purpose: 'other' }))
      expect({ input: String(input), reason: tp.skip_reason }).toEqual({ input: String(input), reason: expected })
    }
  })

  it('a lead that is not a sell off is skipped as before, with no loan reason', async () => {
    const steps = sellOffSteps()
    steps.prospect_trades = { output: { body: fixtures.prospect_trades_not_sell_off } }
    const tp = (await runCanvasScript(TRIPOINT_PING, { payload: leadWithLoan({ loanAmount: 500, purpose: 'other' }), env: fixtures.env, execution: fixtures.execution, steps })) as Json
    expect(tp.skipped).toBe(true)
    expect(tp.skip_reason).toBeUndefined()
  })
})
