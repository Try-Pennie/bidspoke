/**
 * The buyer_select node's sale body comes from CONFIG (#1411): a whole object
 * template as the base, target path and source template pairs, and named
 * normalisers, resolved through the engine's own template resolver only after
 * the sell off decision passes. No code node sits ahead of the decision, so the
 * 90 percent of Engine leads that are not sell off pay nothing for it.
 */
import { buildSalePayload, type SalePayloadSpec } from '@bidspoke/buyer-profile'
import type { ExecutionContext } from '../../types'
import { resolveValue } from '../context'

/** Resolves every template in the spec against the run and builds the body. Throws SalePayloadError by name. */
export function resolveSalePayload(spec: SalePayloadSpec, ctx: ExecutionContext): Record<string, unknown> {
  return buildSalePayload(spec, (template) => resolveValue(template, ctx))
}

/**
 * The Engine workflow's Tripoint sale payload as the node is configured for it,
 * field for field what the live `tripoint_ping` code node derives (read from
 * the bidspoke-workflows backup on 2026-09-22). Held here as the reference the
 * parity tests and the docs use; the live value lives in the node's config on
 * the canvas.
 */
export const ENGINE_TRIPOINT_SALE_PAYLOAD: SalePayloadSpec = {
  base: '{{trigger.payload}}',
  set: [
    { path: 'unsecuredDebt', template: '{{steps.prospect_trades.output.body.tradeCalculations.engineDebt}}' },
    { path: 'maxUnsecuredDebt', template: '{{steps.prospect_trades.output.body.tradeCalculations.enrollableDebt}}' },
    { path: 'workflowId', template: 'engine-bidding' },
    { path: 'pennieLeadId', template: '{{steps.create_prospect.output.body.id}}' },
    { path: 'executionId', template: '{{execution.trace_id}}' },
    { path: 'leadType', template: 'prospect' },
  ],
  normalise: [{ path: 'personalInformation.ssn', normaliser: 'ssn_digits_9' }],
}
