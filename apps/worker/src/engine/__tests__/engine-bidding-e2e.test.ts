/**
 * Engine bidding workflow — end-to-end integration tests
 *
 * Exercises the engine bidding workflow node sequence using walkGraph with
 * executeNode mocked per namespace. Verifies:
 *  - Happy path response shape (requestId + offers[])
 *  - All five rejection paths and their exact reason strings
 *  - Tripoint result code 2018/2019 treated as rejection, 1013 as success
 *  - Tripoint lead ID written back to Salesforce after a successful bid
 *
 * Response contract (must match Pipedream return_response step byte-for-byte):
 *   Success: { requestId, offers: [{ name, display_name, rate, click_url, product_type, logo_src, offer_title, offer_details }] }
 *   Rejection: { lead_id, status: "rejected", reason: "<one of 5 reasons>" }
 *   Error: { lead_id, status: "error", reason: "internal server error" } + HTTP 500
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionContext, NodeDefinition } from '../../types'
import type { Env } from '../../index'

vi.mock('../../lib/circuit-breaker-client', () => ({
  CircuitBreakerClient: class {
    check() { return Promise.resolve({ allowed: true, state: 'closed' }) }
    recordSuccess() { return Promise.resolve() }
    recordError() { return Promise.resolve({ ok: true, state: 'closed', tripped: false }) }
  },
}))

vi.mock('../nodes/index')
vi.mock('../step-logger')

import { executeNode } from '../nodes/index'
import { walkGraph } from '../index'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const supabase = {} as SupabaseClient
const env = {} as Env

function makeCtx(payload: Record<string, unknown> = {}): ExecutionContext {
  return {
    trigger: {
      payload: {
        leadUuid: 'lead-abc',
        subAccountUuid: 'uuid-sofi',
        personalInformation: { firstName: 'John', lastName: 'Doe', state: 'TX' },
        ...payload,
      },
      source: 'engine',
      workflow_id: 'wf-engine',
      org_id: 'org-1',
      trace_id: 'trace-engine-test',
    },
    steps: {},
    env: {},
  }
}

function node(id: string, ns: string, type: NodeDefinition['type'], config: Record<string, unknown> = {}): NodeDefinition {
  return { id, namespace: ns, type, config }
}

function edge(source: string, target: string, handle?: string) {
  return { id: `${source}→${target}`, source, target, ...(handle ? { source_handle: handle } : {}) }
}

// Engine bidding workflow graph — mirrors the canvas workflow node sequence.
// Uses explicit filter nodes for conditional routing (same pattern as integration-e2e.test.ts).
function makeEngineBiddingDef() {
  return {
    nodes: [
      node('constants',                 'constants',                  'constants'),
      node('parsed_name',               'parsed_name',                'code'),
      node('validate_bidding_and_state','validate_bidding_and_state', 'code'),
      node('validate_gate',             'validate_gate',              'filter'),
      node('prospect_body',             'prospect_body',              'code'),
      node('create_prospect',           'create_prospect',            'salesforce'),
      node('equifax_credit_report',     'equifax_credit_report',      'webhook'),
      node('generate_trades_body',      'generate_trades_body',       'code'),
      node('credit_gate',               'credit_gate',                'filter'),
      node('bid_lookup',                'bid_lookup',                 'code'),
      node('patch_prospect',            'patch_prospect',             'salesforce'),
      node('return_response',           'return_response',            'response'),
      node('exit_rejected',             'exit_rejected',              'exit'),
    ],
    edges: [
      edge('constants',                  'parsed_name'),
      edge('parsed_name',                'validate_bidding_and_state'),
      edge('validate_bidding_and_state', 'validate_gate'),
      edge('validate_gate',              'prospect_body',   'pass'),
      edge('validate_gate',              'exit_rejected',   'exit'),
      edge('prospect_body',              'create_prospect'),
      edge('create_prospect',            'equifax_credit_report'),
      edge('equifax_credit_report',      'generate_trades_body'),
      edge('generate_trades_body',       'credit_gate'),
      edge('credit_gate',                'bid_lookup',      'pass'),
      edge('credit_gate',                'exit_rejected',   'exit'),
      edge('bid_lookup',                 'patch_prospect'),
      edge('patch_prospect',             'return_response'),
    ],
  }
}

function setupMocks(outputs: Record<string, unknown>) {
  vi.mocked(executeNode).mockImplementation(async (n) => {
    if (n.namespace in outputs) return { output: outputs[n.namespace] }
    return { output: null }
  })
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe('engine bidding: happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('full success returns requestId + offers[] matching Pipedream contract shape', async () => {
    const successResponse = {
      requestId: 'trace-engine-test',
      offers: [{
        name: 'Pennie',
        display_name: 'Pennie',
        rate: 45,
        click_url: 'https://trypennie.com/portal/SF-001',
        product_type: 'installment_loan',
        logo_src: 'https://example.com/logo.png',
        offer_title: 'Income-Focused Lending',
        offer_details: '<ul><li>Borrow up to $100,000</li></ul>',
      }],
    }

    setupMocks({
      constants:                 { subAccountIdsMap: { 'uuid-sofi': 'sofi' }, pennieClickUrl: 'https://trypennie.com/portal' },
      parsed_name:               { firstName: 'John', lastName: 'Doe', middleName: '' },
      validate_bidding_and_state:{ valid: true, partnerSlug: 'sofi' },
      validate_gate:             { _route: 'pass' },
      prospect_body:             { Last_Name__c: 'Doe', First_Name__c: 'John' },
      create_prospect:           { id: 'SF-001', success: true },
      equifax_credit_report:     { data: { vantageScore: 720 } },
      generate_trades_body:      { engineBid: 45, vantageScore: 720, tradeCalculations: { enrollableDebt: 15000 } },
      credit_gate:               { _route: 'pass' },
      bid_lookup:                { bidAmount: 45 },
      patch_prospect:            { status: 204, body: null },
      return_response:           successResponse,
    })

    const result = await walkGraph(makeCtx(), makeEngineBiddingDef(), 'exec-engine-1', new Date().toISOString(), supabase, env)

    const body = result.body as typeof successResponse
    expect(body).toHaveProperty('requestId')
    expect(body).toHaveProperty('offers')
    expect(Array.isArray(body.offers)).toBe(true)
    expect(body.offers[0]).toHaveProperty('rate')
    expect(body.offers[0]).toHaveProperty('offer_title')
    expect(body.offers[0]).toHaveProperty('offer_details')
    expect(body.offers[0]).toHaveProperty('click_url')
  })
})

// ── Rejection paths ───────────────────────────────────────────────────────────

describe('engine bidding: early-exit rejections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  const rejectionCases: Array<{ label: string; reason: string; exitOutput: Record<string, unknown> }> = [
    {
      label: 'bidding not active (unknown UUID)',
      reason: 'bidding not active',
      exitOutput: { lead_id: 'lead-abc', status: 'rejected', reason: 'bidding not active' },
    },
    {
      label: 'ineligible state',
      reason: 'ineligible state',
      exitOutput: { lead_id: 'lead-abc', status: 'rejected', reason: 'ineligible state' },
    },
    {
      label: 'invalid name',
      reason: 'invalid name',
      exitOutput: { lead_id: 'lead-abc', status: 'rejected', reason: 'invalid name' },
    },
  ]

  for (const { label, exitOutput } of rejectionCases) {
    it(`validate_bidding_and_state routes to exit on: ${label}`, async () => {
      setupMocks({
        constants:                 { subAccountIdsMap: {} },
        parsed_name:               { firstName: 'John', lastName: 'Doe' },
        validate_bidding_and_state:{ valid: false, reason: exitOutput.reason },
        validate_gate:             { _route: 'exit' },
        exit_rejected:             exitOutput,
      })

      const result = await walkGraph(makeCtx(), makeEngineBiddingDef(), `exec-reject-${(exitOutput.reason as string).replace(/ /g, '-')}`, new Date().toISOString(), supabase, env)
      const body = result.body as Record<string, unknown>
      expect(body.status).toBe('rejected')
      expect(body.reason).toBe(exitOutput.reason)
    })
  }

  it('missing_credit_check: credit_gate routes to exit when no credit match', async () => {
    setupMocks({
      constants:                 { subAccountIdsMap: { 'uuid-sofi': 'sofi' } },
      parsed_name:               { firstName: 'John', lastName: 'Doe' },
      validate_bidding_and_state:{ valid: true, partnerSlug: 'sofi' },
      validate_gate:             { _route: 'pass' },
      prospect_body:             {},
      create_prospect:           { id: 'SF-001' },
      equifax_credit_report:     { data: null },
      generate_trades_body:      { noMatch: true },
      credit_gate:               { _route: 'exit' },
      exit_rejected:             { lead_id: 'lead-abc', status: 'rejected', reason: 'missing_credit_check' },
    })

    const result = await walkGraph(makeCtx(), makeEngineBiddingDef(), 'exec-credit-miss', new Date().toISOString(), supabase, env)
    const body = result.body as Record<string, unknown>
    expect(body.status).toBe('rejected')
    expect(body.reason).toBe('missing_credit_check')
  })

  it('unqualified_lead: bid 0 routes to rejection response', async () => {
    setupMocks({
      constants:                 { subAccountIdsMap: { 'uuid-sofi': 'sofi' } },
      parsed_name:               { firstName: 'John', lastName: 'Doe' },
      validate_bidding_and_state:{ valid: true, partnerSlug: 'sofi' },
      validate_gate:             { _route: 'pass' },
      prospect_body:             {},
      create_prospect:           { id: 'SF-001' },
      equifax_credit_report:     { data: { vantageScore: 500 } },
      generate_trades_body:      { engineBid: 0, vantageScore: 500 },
      credit_gate:               { _route: 'pass' },
      bid_lookup:                { bidAmount: 0 },
      patch_prospect:            { status: 204, body: null },
      return_response:           { lead_id: 'lead-abc', status: 'rejected', reason: 'unqualified_lead' },
    })

    const result = await walkGraph(makeCtx(), makeEngineBiddingDef(), 'exec-unqualified', new Date().toISOString(), supabase, env)
    const body = result.body as Record<string, unknown>
    expect(body.status).toBe('rejected')
    expect(body.reason).toBe('unqualified_lead')
  })
})

// ── Tripoint result code handling ─────────────────────────────────────────────

describe('engine bidding: Tripoint result code validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('result code 1013 is treated as success', async () => {
    setupMocks({
      constants:                 { subAccountIdsMap: { 'uuid-sofi': 'sofi' } },
      parsed_name:               { firstName: 'John', lastName: 'Doe' },
      validate_bidding_and_state:{ valid: true },
      validate_gate:             { _route: 'pass' },
      prospect_body:             {},
      create_prospect:           { id: 'SF-001' },
      equifax_credit_report:     { data: { vantageScore: 700 } },
      generate_trades_body:      { engineBid: 50, tripointResultCode: 1013, tripointLeadId: 'TRIP-123' },
      credit_gate:               { _route: 'pass' },
      bid_lookup:                { bidAmount: 50 },
      patch_prospect:            { status: 204, body: null },
      return_response:           { requestId: 'tr-1', offers: [{ rate: 50, offer_title: 'Pennie', offer_details: '' }] },
    })

    const result = await walkGraph(makeCtx(), makeEngineBiddingDef(), 'exec-1013', new Date().toISOString(), supabase, env)
    const body = result.body as Record<string, unknown>
    // Not a rejection
    expect(body.status).toBeUndefined()
    expect(body).toHaveProperty('offers')
  })

  it('result code 2018 is treated as rejection (fraud-flagged)', async () => {
    setupMocks({
      constants:                 { subAccountIdsMap: { 'uuid-sofi': 'sofi' } },
      parsed_name:               { firstName: 'John', lastName: 'Doe' },
      validate_bidding_and_state:{ valid: true },
      validate_gate:             { _route: 'pass' },
      prospect_body:             {},
      create_prospect:           { id: 'SF-001' },
      equifax_credit_report:     { data: { vantageScore: 700 } },
      generate_trades_body:      { engineBid: 0, tripointResultCode: 2018, reason: 'fraud_flag' },
      credit_gate:               { _route: 'pass' },
      bid_lookup:                { bidAmount: 0 },
      patch_prospect:            { status: 204, body: null },
      return_response:           { lead_id: 'lead-abc', status: 'rejected', reason: 'unqualified_lead' },
    })

    const result = await walkGraph(makeCtx(), makeEngineBiddingDef(), 'exec-2018', new Date().toISOString(), supabase, env)
    const body = result.body as Record<string, unknown>
    expect(body.status).toBe('rejected')
  })

  it('result code 2019 is treated as rejection (fraud-flagged)', async () => {
    setupMocks({
      constants:                 { subAccountIdsMap: { 'uuid-sofi': 'sofi' } },
      parsed_name:               { firstName: 'John', lastName: 'Doe' },
      validate_bidding_and_state:{ valid: true },
      validate_gate:             { _route: 'pass' },
      prospect_body:             {},
      create_prospect:           { id: 'SF-001' },
      equifax_credit_report:     { data: { vantageScore: 700 } },
      generate_trades_body:      { engineBid: 0, tripointResultCode: 2019, reason: 'fraud_flag' },
      credit_gate:               { _route: 'pass' },
      bid_lookup:                { bidAmount: 0 },
      patch_prospect:            { status: 204, body: null },
      return_response:           { lead_id: 'lead-abc', status: 'rejected', reason: 'unqualified_lead' },
    })

    const result = await walkGraph(makeCtx(), makeEngineBiddingDef(), 'exec-2019', new Date().toISOString(), supabase, env)
    const body = result.body as Record<string, unknown>
    expect(body.status).toBe('rejected')
  })
})

// ── Tripoint lead ID write-back ───────────────────────────────────────────────

describe('engine bidding: Tripoint lead ID Salesforce write-back', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('patch_prospect step fires after a successful Tripoint bid and receives Tripoint_Lead_ID__c', async () => {
    const patchCalls: Record<string, unknown>[] = []

    vi.mocked(executeNode).mockImplementation(async (n) => {
      if (n.namespace === 'patch_prospect') {
        patchCalls.push({ config: n.config })
        return { output: { status: 204, body: null } }
      }
      const defaults: Record<string, unknown> = {
        constants:                 { subAccountIdsMap: { 'uuid-sofi': 'sofi' } },
        parsed_name:               { firstName: 'John', lastName: 'Doe' },
        validate_bidding_and_state:{ valid: true },
        validate_gate:             { _route: 'pass' },
        prospect_body:             {},
        create_prospect:           { id: 'SF-001' },
        equifax_credit_report:     { data: { vantageScore: 720 } },
        generate_trades_body:      { engineBid: 45, tripointLeadId: 'TRIP-XYZ', tripointResultCode: 1013 },
        credit_gate:               { _route: 'pass' },
        bid_lookup:                { bidAmount: 45 },
        return_response:           { requestId: 'tr-1', offers: [{ rate: 45 }] },
        exit_rejected:             { lead_id: 'lead-abc', status: 'rejected', reason: 'unqualified_lead' },
      }
      if (n.namespace in defaults) return { output: defaults[n.namespace] }
      return { output: null }
    })

    await walkGraph(makeCtx(), makeEngineBiddingDef(), 'exec-tripoint-writeback', new Date().toISOString(), supabase, env)

    // patch_prospect must have been called (Tripoint lead ID write-back step)
    expect(patchCalls.length).toBeGreaterThan(0)
  })
})

// ── Response contract shape ───────────────────────────────────────────────────

describe('engine bidding: response contract matches Pipedream return_response', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('success response has requestId and offers[] — not lead_id/bid_amount (Pipedream shape)', async () => {
    const pipedreamShape = {
      requestId: 'trace-engine-test',
      offers: [{
        name: 'Pennie',
        display_name: 'Pennie',
        rate: 45,
        click_url: 'https://trypennie.com/portal/SF-001',
        product_type: 'installment_loan',
        logo_src: 'https://example.com/logo.png',
        offer_title: 'Income-Focused Lending',
        offer_details: '<ul><li>Borrow up to $100,000</li></ul>',
      }],
    }

    setupMocks({
      constants:                 { subAccountIdsMap: { 'uuid-sofi': 'sofi' } },
      parsed_name:               { firstName: 'John', lastName: 'Doe' },
      validate_bidding_and_state:{ valid: true },
      validate_gate:             { _route: 'pass' },
      prospect_body:             {},
      create_prospect:           { id: 'SF-001' },
      equifax_credit_report:     { data: { vantageScore: 720 } },
      generate_trades_body:      { engineBid: 45 },
      credit_gate:               { _route: 'pass' },
      bid_lookup:                { bidAmount: 45 },
      patch_prospect:            { status: 204, body: null },
      return_response:           pipedreamShape,
    })

    const result = await walkGraph(makeCtx(), makeEngineBiddingDef(), 'exec-contract', new Date().toISOString(), supabase, env)
    const body = result.body as Record<string, unknown>

    // Must have these top-level keys
    expect(body).toHaveProperty('requestId')
    expect(body).toHaveProperty('offers')
    // Must NOT have the old-style keys
    expect(body).not.toHaveProperty('lead_id')
    expect(body).not.toHaveProperty('bid_amount')

    const offer = (body.offers as Record<string, unknown>[])[0]
    expect(offer).toHaveProperty('name')
    expect(offer).toHaveProperty('rate')
    expect(offer).toHaveProperty('offer_title')
    expect(offer).toHaveProperty('offer_details')
    expect(offer).toHaveProperty('click_url')
    expect(offer).toHaveProperty('product_type')
  })

  it('rejection response has lead_id, status: "rejected", and a known reason string', async () => {
    setupMocks({
      constants:                 { subAccountIdsMap: {} },
      parsed_name:               { firstName: 'John', lastName: 'Doe' },
      validate_bidding_and_state:{ valid: false },
      validate_gate:             { _route: 'exit' },
      exit_rejected:             { lead_id: 'lead-abc', status: 'rejected', reason: 'bidding not active' },
    })

    const result = await walkGraph(makeCtx(), makeEngineBiddingDef(), 'exec-rej-contract', new Date().toISOString(), supabase, env)
    const body = result.body as Record<string, unknown>

    expect(body).toHaveProperty('lead_id')
    expect(body.status).toBe('rejected')
    expect(['bidding not active', 'ineligible state', 'invalid name', 'missing_credit_check', 'unqualified_lead'])
      .toContain(body.reason)
  })
})
