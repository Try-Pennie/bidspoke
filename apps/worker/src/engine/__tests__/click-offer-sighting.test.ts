/**
 * A click sold buyer offered on a known Tripoint no (#1544) reaches the lead
 * sighting as a sale to that buyer.
 *
 * The run's step outputs are produced by the REAL kept scripts (tripoint_ping,
 * known_no_gate, build_response_body) run the way the sandbox runs them, with a
 * buyer_click_check output in the node's own shape. From them the sighting
 * finalize names the buyer the winner (so the finalize flips is_winner on its
 * row), and the bid rows carry Tripoint's decline beside one row for the buyer,
 * marked sold on click by its resolver_type. Both the live finalize and the strand
 * projection read the same two functions, so the projection is asserted too.
 */
import { describe, expect, it } from 'vitest'
import type { NodeDefinition, StepOutput } from '../../types'
import duplicate1003 from '../../../../../packages/buyer-profile/fixtures/tripoint/duplicate-1003.json'
import fixtures from '../scripts/__tests__/fixtures/engine-lead.json'
import { answerWith, runCanvasScript, type CanvasRun } from '../scripts/__tests__/canvas-script'
import { KEPT_ENGINE_SCRIPTS } from '../../lib/engine-script-drift'
import { CLICK_RESOLVER_TYPE, deriveClickOffer, deriveCodeNodeBidAttempts } from '../bid-log'
import { buildSightingFinalizeProjection, computeSightingFinalize } from '../lead-sightings'

const script = (ns: string) => KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === ns)!.script
const common = { payload: fixtures.payload, env: fixtures.env, execution: fixtures.execution }

const node = (namespace: string, type: string): NodeDefinition => ({ id: `id-${namespace}`, namespace, type, config: {} } as NodeDefinition)
const NODES: NodeDefinition[] = [
  node('create_prospect', 'salesforce'),
  node('prospect_trades', 'salesforce'),
  node('buyer_select', 'buyer_select'),
  node('tripoint_ping', 'code'),
  node('known_no_gate', 'code'),
  node('route_known_no', 'branch'),
  node('buyer_click_check', 'buyer_click_check'),
  node('route_known_no_end', 'branch_end'),
  node('build_response_body', 'code'),
  node('offer_response', 'response'),
  node('patch_prospect_body', 'code'),
  node('patch_prospect', 'salesforce'),
]

const check = (route: 'eligible' | 'not_eligible') => ({
  _route: route, reason: route === 'eligible' ? 'eligible' : 'daily_click_cap', population: 'engine',
  partner_id: '0192a4f0-0000-7000-8000-00000000a1b1', partner_slug: 'clickbuyer', partner_name: 'Click Buyer Inc',
  click_url: 'https://portal.example-click.test/offer/{prospect_id}', external_routing_code: 4,
  count: 3, daily_lead_cap: 50, count_date: '2026-09-29', profile_served_from: 'cache', duration_ms: 4,
})

/** One Engine run through the kept scripts, the way the canvas orders them; the branch_end re-emits the check's output as it does on the canvas. */
async function run(route: 'eligible' | 'not_eligible'): Promise<Record<string, StepOutput>> {
  const steps: CanvasRun['steps'] = {
    constants: { output: fixtures.constants },
    prospect_trades: { output: { body: fixtures.prospect_trades_sell_off } },
    create_prospect: { output: { body: fixtures.create_prospect } },
  }
  steps.tripoint_ping = { output: await runCanvasScript(script('tripoint_ping'), { ...common, steps, fetch: answerWith(duplicate1003.httpStatus, duplicate1003.body) }) }
  steps.known_no_gate = { output: await runCanvasScript(script('known_no_gate'), { ...common, steps }) }
  steps.route_known_no = { output: { matched_branch: 'known_no', _route: 'known_no' } }
  steps.buyer_click_check = { output: check(route) }
  steps.route_known_no_end = { output: check(route) }
  steps.build_response_body = { output: await runCanvasScript(script('build_response_body'), { ...common, steps }) }
  const out: Record<string, StepOutput> = {}
  for (const [ns, s] of Object.entries(steps)) out[ns] = { output: s!.output, status: 'completed' }
  if (route === 'eligible') out.offer_response = { output: { body: (out.build_response_body.output as { body: unknown }).body }, status: 'completed' }
  return out
}

const meta = { sighting_id: 'sight-1', trace_id: 'trace-1', execution_id: 'exec-1', attempted_at_utc: new Date('2026-09-29T16:00:00Z'), is_test: false }
const finalizeOpts = (last: string) => ({ lastCompletedNamespace: last, walkStatus: 200, executionStatus: 'completed', successNamespaces: ['patch_prospect'] })

describe('the click sold buyer on the lead sighting (#1544)', () => {
  it('lead_sightings: the buyer is the winner, the quoted rate is the offer, and there is no reject reason', async () => {
    const steps = await run('eligible')
    steps.patch_prospect = { output: { status: 204 }, status: 'completed' }
    const row = computeSightingFinalize(steps, NODES, finalizeOpts('patch_prospect'))
    expect(row).toMatchObject({
      winning_partner_slug: 'clickbuyer',
      winning_bid_cents: null,
      partners_attempted: 2,
      partners_responded: 1,
      reject_reason: null,
      quoted_rate_cents: 65,
      prospect_id: fixtures.create_prospect.id,
      outcome: 'successful',
    })
  })

  it('lead_sighting_bids: Tripoint\'s decline, then one accepted row for the buyer marked sold on click', async () => {
    const rows = deriveCodeNodeBidAttempts(await run('eligible'), meta, NODES)
    expect(rows.map((r) => [r.partner_slug, r.classification, r.decline_reason, r.skip_reason, r.resolver_type, r.bid_cents])).toEqual([
      ['tripoint', 'decline', 'result_code_1003', 'duplicate', 'api', null],
      ['clickbuyer', 'accept', null, null, CLICK_RESOLVER_TYPE, null],
    ])
    expect(CLICK_RESOLVER_TYPE).toBe('click')
    expect(rows[1]).toMatchObject({ sighting_id: 'sight-1', trace_id: 'trace-1', execution_id: 'exec-1', is_test: false })
  })

  it('the strand projection carries the same winner and the same two rows', async () => {
    const steps = await run('eligible')
    const projection = buildSightingFinalizeProjection(steps, NODES, finalizeOpts('offer_response'), { sightingId: 'sight-1', isTest: false })
    expect(projection?.winning_partner_slug).toBe('clickbuyer')
    expect(projection?.bid_attempts.map((a) => [a.partner_slug, a.classification, a.resolver_type])).toEqual([
      ['tripoint', 'decline', 'api'],
      ['clickbuyer', 'accept', 'click'],
    ])
  })

  it('a check that routed not_eligible leaves only Tripoint\'s decline and no winner', async () => {
    const steps = await run('not_eligible')
    expect(deriveClickOffer(steps, NODES)).toBeNull()
    expect(deriveCodeNodeBidAttempts(steps, meta, NODES).map((r) => r.partner_slug)).toEqual(['tripoint'])
    expect(computeSightingFinalize(steps, NODES, finalizeOpts('build_response_body')).winning_partner_slug).toBeNull()
  })

  it('an eligible check whose offer was not made (the response was rejected) records no sale', async () => {
    const steps = await run('eligible')
    steps.build_response_body = { output: { isRejected: true, body: { status: 'rejected' }, sale: null }, status: 'completed' }
    expect(deriveClickOffer(steps, NODES)).toBeNull()
  })

  it('the offer is found from the check node itself, never from a branch_end that re-emits its output', async () => {
    const steps = await run('eligible')
    delete steps.buyer_click_check
    expect(deriveClickOffer(steps, NODES)).toBeNull()
  })

  it('a click sale beside a check that did not route eligible is not recorded: both nodes must agree', async () => {
    const steps = await run('eligible')
    steps.buyer_click_check = { output: check('not_eligible'), status: 'completed' }
    expect(deriveClickOffer(steps, NODES)).toBeNull()
  })

  it('an offer naming a different buyer than the check is not a sale to either', async () => {
    const steps = await run('eligible')
    const brb = steps.build_response_body.output as { sale: Record<string, unknown> }
    steps.build_response_body = { output: { ...brb, sale: { ...brb.sale, partner_slug: 'someone_else' } }, status: 'completed' }
    expect(deriveClickOffer(steps, NODES)).toBeNull()
  })
})
