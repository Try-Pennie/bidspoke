/**
 * The hardest part first (L246, #1411 PR B): the buyer_select node builds the
 * sale body from CONFIG, not a code node, so every one of the six fields the
 * live tripoint_ping script derives must resolve through the engine's own
 * template resolver, including `{{execution.trace_id}}` and a plain literal
 * with no braces, and the SSN rule must be one named normaliser. If any of
 * them cannot, the resolver is what gets fixed. A code node is not the fallback.
 *
 * Parity is asserted against the script as it runs in production today
 * (bidspoke-workflows, Engine Bidding Workflow, tripoint_ping, read 2026-09-22):
 *
 *   { ...payload,
 *     personalInformation: { ...payload.personalInformation, ssn: digits, at most 9 },
 *     unsecuredDebt: pt.tradeCalculations.engineDebt,
 *     maxUnsecuredDebt: pt.tradeCalculations.enrollableDebt,
 *     workflowId: 'engine-bidding',
 *     pennieLeadId: steps.create_prospect.output.body.id,
 *     executionId: execution.trace_id,
 *     leadType: 'prospect' }
 */
import { describe, expect, it } from 'vitest'
import { buildSalePayload, type SalePayloadSpec } from '@bidspoke/buyer-profile'
import { buildContext, resolveValue } from '../../context'
import { ENGINE_TRIPOINT_SALE_PAYLOAD, resolveSalePayload } from '../buyer-select-payload'

const PAYLOAD = {
  leadUuid: 'lead-abc',
  subAccountUuid: 'uuid-sofi',
  personalInformation: { firstName: 'John', lastName: 'Doe', ssn: '123-45-6789', state: 'TX' },
  financialInformation: { annualIncome: 85000 },
}

function engineCtx() {
  const ctx = buildContext(PAYLOAD, 'engine', 'wf-engine', 'trace-engine-1', {}, 'org-1', 'exec-1')
  ctx.steps.prospect_trades = {
    status: 'completed',
    output: { body: { sellOff: true, engineBid: 0.65, tradeCalculations: { engineDebt: 18250, enrollableDebt: 22100 } } },
  }
  ctx.steps.create_prospect = { status: 'completed', output: { body: { id: '003SF000001' } } }
  return ctx
}

/** What the live script produces for the same inputs, written out rather than derived. */
function scriptBody(payload: typeof PAYLOAD, pt: { tradeCalculations: { engineDebt: number; enrollableDebt: number } }, prospectId: string, traceId: string) {
  return {
    ...payload,
    personalInformation: {
      ...payload.personalInformation,
      ssn: String(payload.personalInformation?.ssn || '').replace(/\D/g, '').slice(0, 9),
    },
    unsecuredDebt: pt.tradeCalculations.engineDebt,
    maxUnsecuredDebt: pt.tradeCalculations.enrollableDebt,
    workflowId: 'engine-bidding',
    pennieLeadId: prospectId,
    executionId: traceId,
    leadType: 'prospect',
  }
}

describe('the six derived sale payload fields resolve through the engine resolver', () => {
  it('each source resolves to the value the live script derives, including execution.trace_id and a bare literal', () => {
    const ctx = engineCtx()
    const resolve = (template: string) => resolveValue(template, ctx)
    expect(resolve('{{trigger.payload}}')).toEqual(PAYLOAD)
    expect(resolve('{{steps.prospect_trades.output.body.tradeCalculations.engineDebt}}')).toBe(18250)
    expect(resolve('{{steps.prospect_trades.output.body.tradeCalculations.enrollableDebt}}')).toBe(22100)
    expect(resolve('engine-bidding')).toBe('engine-bidding')
    expect(resolve('{{steps.create_prospect.output.body.id}}')).toBe('003SF000001')
    expect(resolve('{{execution.trace_id}}')).toBe('trace-engine-1')
    expect(resolve('prospect')).toBe('prospect')
  })

  it('the configured Engine sale payload deep equals the body tripoint_ping sends', () => {
    const ctx = engineCtx()
    const body = resolveSalePayload(ENGINE_TRIPOINT_SALE_PAYLOAD, ctx)
    expect(body).toEqual(scriptBody(PAYLOAD, { tradeCalculations: { engineDebt: 18250, enrollableDebt: 22100 } }, '003SF000001', 'trace-engine-1'))
    expect((body.personalInformation as { ssn: string }).ssn).toBe('123456789')
  })

  it('does not mutate the trigger payload the rest of the workflow reads', () => {
    const ctx = engineCtx()
    resolveSalePayload(ENGINE_TRIPOINT_SALE_PAYLOAD, ctx)
    expect((ctx.trigger.payload as typeof PAYLOAD).personalInformation.ssn).toBe('123-45-6789')
    expect('unsecuredDebt' in (ctx.trigger.payload as Record<string, unknown>)).toBe(false)
  })

  it('the SSN normaliser matches the script on every shape the payload can carry', () => {
    const spec: SalePayloadSpec = { base: '{{trigger.payload}}', set: [], normalise: [{ path: 'personalInformation.ssn', normaliser: 'ssn_digits_9' }] }
    for (const [raw, expected] of [['123-45-6789', '123456789'], ['123456789012', '123456789'], [123456789, '123456789'], ['', ''], [undefined, ''], [null, '']] as const) {
      const ctx = buildContext({ personalInformation: { ssn: raw } }, 'engine', 'wf', 't', {}, 'org', 'e')
      const body = buildSalePayload(spec, (t) => resolveValue(t, ctx))
      expect((body.personalInformation as { ssn: string }).ssn, String(raw)).toBe(expected)
    }
  })

  it('a set entry whose source resolves to nothing is a named failure, never a hole in the body (L505)', () => {
    const ctx = engineCtx()
    delete ctx.steps.create_prospect
    expect(() => resolveSalePayload(ENGINE_TRIPOINT_SALE_PAYLOAD, ctx)).toThrow(/sale_payload_field_unresolved: pennieLeadId/)
  })
})
