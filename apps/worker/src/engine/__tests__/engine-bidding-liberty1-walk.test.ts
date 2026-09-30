/**
 * The #1544 canvas change, walked by the real engine.
 *
 * The base is the tail of the LIVE Engine Bidding Workflow (constants to the
 * Salesforce patches, live ids, configs and edges, read from the mirror on
 * 2026-09-24), and docs/workflows/engine-bidding/liberty1-wiring.json is applied
 * to it exactly as the guide tells Dan to: the two edges into
 * build_response_body that a known no can arrive on are removed, and the gate,
 * the Branch, the buyer_click_check node and the join are added. The walk uses
 * the REAL branch and response nodes and the REAL kept scripts (run the way the
 * sandbox runs them); only what reaches outside is doubled: Salesforce answers
 * from the synthetic lead, Tripoint answers a captured fixture, and the two
 * walker only nodes answer the route a test names.
 *
 * What it proves: a known Tripoint no the check finds eligible gets the offer at
 * the buyer's landing page and the prospect patch names the buyer; a known no the
 * check refuses, and every answer that is not a known no, gets today's reject and
 * reject patch, with the check never run for a not known no; a Tripoint sale is
 * untouched; and at Stage B a buyer_select no_sale reaches the same gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { EdgeDefinition, ExecutionContext, NodeDefinition } from '../../types'
import type { StepLogEntry } from '../step-logger'
import type { BuyerSelectResult } from '../nodes/buyer-select'
import type { BuyerClickCheckOutput } from '../nodes/buyer-click-check'
import wiring from '../../../../../docs/workflows/engine-bidding/liberty1-wiring.json'
import tail from '../scripts/__tests__/fixtures/engine-bidding-tail-v100.json'
import fixtures from '../scripts/__tests__/fixtures/engine-lead.json'
import expected from '../scripts/__tests__/fixtures/expected-live-2026-09-22.json'
import success1001 from '../../../../../packages/buyer-profile/fixtures/tripoint/success-1001.json'
import duplicate1003 from '../../../../../packages/buyer-profile/fixtures/tripoint/duplicate-1003.json'
import inProgress1009 from '../../../../../packages/buyer-profile/fixtures/tripoint/in-progress-1009.json'
import { answerWith, runCanvasScript, type CanvasRun } from '../scripts/__tests__/canvas-script'
import { KEPT_ENGINE_SCRIPTS } from '../../lib/engine-script-drift'

vi.mock('../step-logger', () => ({
  createExecutionRecord: vi.fn().mockResolvedValue(undefined),
  updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
  flushStepLogs: vi.fn().mockResolvedValue(null),
}))
vi.mock('../nodes/code', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/code')>()),
  executeCodeNode: vi.fn(),
}))
vi.mock('../nodes/constants', () => ({ executeConstantsNode: vi.fn() }))
vi.mock('../nodes/salesforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/salesforce')>()),
  executeSalesforceNode: vi.fn(),
}))
vi.mock('../nodes/buyer-select', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/buyer-select')>()),
  executeBuyerSelectNode: vi.fn(),
  productionDeps: vi.fn(() => ({})),
}))
vi.mock('../nodes/buyer-click-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../nodes/buyer-click-check')>()),
  executeBuyerClickCheckNode: vi.fn(),
  productionDeps: vi.fn(() => ({})),
}))

import { walkGraph } from '../index'
import { buildContext, resolveValue } from '../context'
import { codeSentinel, executeCodeNode } from '../nodes/code'
import { executeConstantsNode } from '../nodes/constants'
import { executeSalesforceNode } from '../nodes/salesforce'
import { executeBuyerSelectNode } from '../nodes/buyer-select'
import { executeBuyerClickCheckNode } from '../nodes/buyer-click-check'

type Rec = Record<string, unknown>
type Def = { nodes: NodeDefinition[]; edges: EdgeDefinition[] }
const PROSPECT_ID = fixtures.create_prospect.id
const kept = (ns: string) => KEPT_ENGINE_SCRIPTS.find((k) => k.namespace === ns)!.script

/** The live tail with the kept scripts in its code nodes, then the #1544 change applied the way the guide says. */
function composed(): Def {
  const base = structuredClone(tail) as unknown as Def
  const withScripts = (n: NodeDefinition): NodeDefinition => (n.type === 'code' ? { ...n, config: { ...n.config, script: kept(n.namespace) } } : n)
  const removed = new Set(wiring.remove_edges.map((e) => e.id))
  for (const e of wiring.remove_edges) {
    const live = base.edges.find((x) => x.id === e.id)
    // Each removed edge is the live one the guide names, so the guide cannot be pointing at an edge that moved.
    expect(live, e.was).toMatchObject({ source: e.source, target: e.target, source_handle: e.source_handle })
  }
  return {
    nodes: [...base.nodes, ...(wiring.add_nodes as unknown as NodeDefinition[])].map(withScripts),
    edges: [...base.edges.filter((e) => !removed.has(e.id)), ...(wiring.add_edges as EdgeDefinition[])],
  }
}

const PARTNER_ID = '0192a4f0-0000-7000-8000-00000000a1b1'
let tripointAnswer: { httpStatus: number; body: unknown }
let selectRoute: { route: BuyerSelectResult['output']['_route']; reason: BuyerSelectResult['output']['reason'] }
let checkRoute: 'eligible' | 'not_eligible'
let checkInputs: Rec[]
let sfWrites: Array<{ namespace: string; body: unknown }>

function selectOutput(): BuyerSelectResult['output'] {
  const { route, reason } = selectRoute
  const decided = route === 'sold' || route === 'no_sale'
  return {
    _route: route, reason, mode_effective: decided ? 'live' : 'decide_only', population: 'engine', lead_key: 'lead-1',
    sale: {
      skipped: !decided, accepted: route === 'sold', buyer_reference: route === 'sold' ? 'L-1' : null, result_code: route === 'sold' ? '1001' : route === 'no_sale' ? '1003' : null,
      partner_slug: decided ? 'tripoint' : null, partner_name: decided ? 'Tripoint' : null, click_url: route === 'sold' ? fixtures.constants.TripointClickUrl : null,
      routing_code: route === 'sold' ? 2 : null, response_class: route === 'sold' ? 'Success' : route === 'no_sale' ? 'Duplicate' : null,
    },
    considered: [], live_percent_in_force: decided ? 100 : 0, caps_in_force: [], duration_ms: 3,
  } as BuyerSelectResult['output']
}

beforeEach(() => {
  tripointAnswer = duplicate1003
  selectRoute = { route: 'deferred', reason: 'decide_only' }
  checkRoute = 'eligible'
  checkInputs = []
  sfWrites = []

  vi.mocked(executeConstantsNode).mockResolvedValue({ output: fixtures.constants })
  // Through the engine's own sentinel rule (codeSentinel), as the live walker does.
  vi.mocked(executeCodeNode).mockImplementation(async (node: NodeDefinition, ctx: ExecutionContext) => {
    const output = await runCanvasScript(String((node.config as Rec).script), {
      payload: ctx.trigger.payload,
      steps: ctx.steps as CanvasRun['steps'],
      env: fixtures.env,
      execution: fixtures.execution,
      fetch: answerWith(tripointAnswer.httpStatus, tripointAnswer.body),
    })
    return { output, ...codeSentinel(output) }
  })
  vi.mocked(executeSalesforceNode).mockImplementation(async (node: NodeDefinition, ctx: ExecutionContext) => {
    if (node.namespace === 'create_prospect') return { output: { status: 201, body: fixtures.create_prospect } }
    if (node.namespace === 'prospect_trades') return { output: { status: 200, body: fixtures.prospect_trades_sell_off } }
    sfWrites.push({ namespace: node.namespace, body: resolveValue((node.config as Rec).body, ctx) })
    return { output: { status: 204, body: null } }
  })
  vi.mocked(executeBuyerSelectNode).mockImplementation(async () => ({ output: selectOutput(), attempts: [] }))
  vi.mocked(executeBuyerClickCheckNode).mockImplementation(async (node: NodeDefinition, ctx: ExecutionContext) => {
    const c = node.config as Rec
    checkInputs.push({ partner_id: c.partner_id, population: c.population, state: resolveValue(c.state as string, ctx), debt: resolveValue(c.debt as string, ctx), loan_amount: resolveValue(c.loan_amount as string, ctx) })
    const output: BuyerClickCheckOutput = {
      _route: checkRoute, reason: checkRoute === 'eligible' ? 'eligible' : 'daily_click_cap', population: 'engine',
      partner_id: PARTNER_ID, partner_slug: 'clickbuyer', partner_name: 'Click Buyer Inc', click_url: 'https://portal.example-click.test/offer/{prospect_id}', external_routing_code: 4,
      count: 3, daily_lead_cap: 50, count_date: '2026-09-29', count_source: 'copy', profile_served_from: 'cache',
      judged: { lead: { state: null, debt: null, loan_amount: null }, limits: null }, duration_ms: 4,
    }
    return { output }
  })
})

const env = { PII_REDACTION_FIELDS: '' } as unknown as Env
const supabase = {} as SupabaseClient
const payload = { ...fixtures.payload, loanInformation: { loanAmount: 5000 } }

async function walk(def: Def = composed()) {
  const def2 = { ...def, nodes: def.nodes.map((n) => (n.type === 'buyer_click_check' ? { ...n, config: { ...n.config, partner_id: PARTNER_ID } } : n)) }
  const ctx = buildContext(payload, 'engine', 'da82a183-1a4a-417e-b0b8-5f3fe5e14840', 'trace-1', {}, 'org-1', 'exec-1')
  const queue: StepLogEntry[] = []
  const early: Array<{ status: number; body: unknown }> = []
  await walkGraph(ctx, def2, 'exec-1', '2026-09-29T16:00:00.000Z', supabase, env, 'v1', queue, (r) => early.push({ status: r.status, body: r.body }))
  return { early, ran: queue.map((r) => r.step_namespace), writes: sfWrites, steps: ctx.steps as Record<string, { output: unknown }> }
}

const arms = expected.arms as Record<string, { response: { body: Rec }; patch_prospect_body: Rec | null }>

describe('the #1544 wiring applied to the live Engine Bidding tail', () => {
  it('the gate node carries the kept file byte for byte, so the paste and the tested script are one text (L41)', () => {
    const gate = wiring.add_nodes.find((n) => n.namespace === 'known_no_gate')!
    expect(gate.config.script).toBe(kept('known_no_gate'))
  })

  it('Stage A, a known Tripoint no the check finds eligible: offered at the buyer landing page, the patch names the buyer', async () => {
    const r = await walk()
    expect(r.ran).toEqual(expect.arrayContaining(['tripoint_ping', 'known_no_gate', 'route_known_no', 'buyer_click_check', 'route_known_no_end', 'build_response_body', 'offer_response', 'patch_prospect_body', 'patch_prospect']))
    expect(r.ran).not.toContain('reject_response')
    const body = structuredClone(arms.sold_1001.response.body) as { offers: Rec[] }
    body.offers[0].click_url = `https://portal.example-click.test/offer/${PROSPECT_ID}`
    expect(r.early).toEqual([{ status: 200, body }])
    expect(checkInputs).toEqual([{ partner_id: PARTNER_ID, population: 'engine', state: 'TX', debt: 18250, loan_amount: 5000 }])
    expect(r.writes).toEqual([{
      namespace: 'patch_prospect',
      body: {
        BidAmount__c: 0.65, BidStatus__c: 'Bid', OfferLandingPage__c: `https://portal.example-click.test/offer/${PROSPECT_ID}`, Base_Bid__c: 0.5,
        Tripoint_Response__c: 'Duplicate', ExternalPartnerName__c: 'Click Buyer Inc', ExternalDebtAmount__c: 22100, ExternalRoutingCode__c: 4, ExternalExchangeStatus__c: 'Bid',
      },
    }])
  })

  it('a known no the check refuses gets today\'s reject response and reject patch', async () => {
    checkRoute = 'not_eligible'
    const r = await walk()
    expect(r.ran).toContain('buyer_click_check')
    expect(r.early).toEqual([{ status: 200, body: arms.declined_1003.response.body }])
    expect(r.writes).toEqual([{ namespace: 'patch_prospect_reject', body: { BidStatus__c: 'Rejected', RejectionReason__c: 'unqualified_lead', Tripoint_Response__c: 'Duplicate' } }])
  })

  it('1009 in progress is not a known no: the check never runs and the lead is rejected as today', async () => {
    tripointAnswer = inProgress1009
    const r = await walk()
    expect(r.ran).toContain('route_known_no')
    expect(r.ran).not.toContain('buyer_click_check')
    expect(checkInputs).toEqual([])
    expect((r.early[0].body as Rec).status).toBe('rejected')
    expect(r.writes.map((w) => w.namespace)).toEqual(['patch_prospect_reject'])
  })

  it('an unknown Tripoint answer (a 504) is not a known no either', async () => {
    tripointAnswer = { httpStatus: 504, body: { message: 'gateway timeout' } }
    const r = await walk()
    expect(r.ran).not.toContain('buyer_click_check')
    expect((r.early[0].body as Rec).status).toBe('rejected')
  })

  it('a Tripoint sale is untouched: the check never runs and the offer lands on Tripoint', async () => {
    tripointAnswer = success1001
    const r = await walk()
    expect(r.ran).not.toContain('buyer_click_check')
    expect(r.early).toEqual([{ status: 200, body: arms.sold_1001.response.body }])
    expect(r.writes).toEqual([{ namespace: 'patch_prospect', body: arms.sold_1001.patch_prospect_body }])
  })

  it('Stage B, buyer_select sells live and routes no_sale declined_by_buyer: the same gate offers the buyer, and tripoint_ping never runs', async () => {
    selectRoute = { route: 'no_sale', reason: 'declined_by_buyer' }
    const r = await walk()
    expect(r.ran).not.toContain('tripoint_ping')
    expect(r.ran).toContain('buyer_click_check')
    expect(((r.early[0].body as { offers: Rec[] }).offers[0]).click_url).toBe(`https://portal.example-click.test/offer/${PROSPECT_ID}`)
  })

  it('Stage B, a no_sale for any other reason is rejected without the check', async () => {
    selectRoute = { route: 'no_sale', reason: 'outcome_unknown' }
    const r = await walk()
    expect(r.ran).not.toContain('buyer_click_check')
    expect((r.early[0].body as Rec).status).toBe('rejected')
  })

  it('Stage B, a live sale still goes straight to build_response_body, past the gate', async () => {
    selectRoute = { route: 'sold', reason: 'sold' }
    const r = await walk()
    expect(r.ran).not.toContain('known_no_gate')
    expect(r.ran).toContain('build_response_body')
  })
})
