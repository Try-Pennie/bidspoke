/**
 * HTTP status output key contract.
 *
 * Before 2026-06-11, node executors exposed an HTTP status under three
 * different output keys (Response -> status_code, Partner Bid -> http_status,
 * Integration/Salesforce/Achieve -> status), so {{steps.X.output.status}}
 * silently resolved to undefined against some node types. The canonical key
 * is `status` (a number); `status_code` and `http_status` are retired from
 * step outputs.
 *
 * This suite enforces the contract two ways:
 *  1. Behaviorally — each status-emitting executor runs against a mocked
 *     upstream and its output is asserted to carry `status` and neither
 *     legacy key.
 *  2. Exhaustively — STATUS_CONTRACT is a Record over the NodeType union, so
 *     adding a new node type fails `tsc` until the type is classified here.
 *     If the new node performs HTTP calls, expose the status as
 *     output.status (a number) and add a behavioral test to this file.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { executeResponseNode } from '../nodes/response'
import { executeIntegrationNode } from '../nodes/integration'
import { executeSalesforceNode } from '../nodes/salesforce'
import { executePartnerBidNode } from '../nodes/partner-bid'
import { executeAchieveOffersNode } from '../nodes/achieve-offers'
import { executeBuyerClickSendNode } from '../nodes/buyer-click-send'
import type { NodeDefinition, NodeType, ExecutionContext } from '../../types'
import type { Env } from '../../index'

// ── Node classification (compile-time exhaustive) ─────────────────────────────

const STATUS_CONTRACT: Record<NodeType, 'emits-status' | 'no-http-status'> = {
  response: 'emits-status',
  webhook: 'emits-status', // the Integration node
  salesforce: 'emits-status',
  partner_bid: 'emits-status',
  achieve_offers: 'emits-status',
  buyer_click_send: 'emits-status', // the click buyer's answer
  code: 'no-http-status', // output is the script's return value, user-controlled
  bid_group: 'no-http-status', // composes partner_bid outputs, covered via partner_bid
  buyer_click_check: 'no-http-status', // reads a profile and a counter; it calls no partner
  buyer_select: 'no-http-status', // the parent output carries the sale and the considered buyers; each attempt is a partner_bid row, covered via partner_bid
  parallel: 'no-http-status', // composes child outputs
  filter: 'no-http-status',
  branch: 'no-http-status',
  branch_end: 'no-http-status',
  parallel_end: 'no-http-status',
  transform: 'no-http-status',
  exit: 'no-http-status',
  constants: 'no-http-status',
  data_store: 'no-http-status',
  latency_gate: 'no-http-status',
  lead_validation: 'no-http-status', // calls nothing; its rejection is an answer it sends, not one it received
}

/** Node types exercised by a behavioral test in this file. */
const BEHAVIORALLY_TESTED: NodeType[] = ['response', 'webhook', 'salesforce', 'partner_bid', 'achieve_offers', 'buyer_click_send']

describe('node classification is exhaustive', () => {
  it('every status-emitting node type has a behavioral test below', () => {
    const emitting = (Object.keys(STATUS_CONTRACT) as NodeType[])
      .filter((t) => STATUS_CONTRACT[t] === 'emits-status')
      .sort()
    expect([...BEHAVIORALLY_TESTED].sort()).toEqual(emitting)
  })
})

// ── Shared assertion ──────────────────────────────────────────────────────────

function expectCanonicalStatus(output: unknown, expected: number) {
  expect(output).toBeTypeOf('object')
  const o = output as Record<string, unknown>
  expect(o.status).toBe(expected)
  expect(o).not.toHaveProperty('status_code')
  expect(o).not.toHaveProperty('http_status')
}

// ── Harness ───────────────────────────────────────────────────────────────────

function makeNode(type: NodeDefinition['type'], config: Record<string, unknown> = {}): NodeDefinition {
  return { id: 'n1', namespace: `${type}_step`, type, config }
}

function makeCtx(payload: Record<string, unknown> = {}, env: Record<string, string> = {}): ExecutionContext {
  return {
    trigger: { payload, source: 'test', workflow_id: 'wf-1', org_id: 'org-1', trace_id: 'tr-1' },
    steps: {},
    env,
  } as unknown as ExecutionContext
}

function makeEnv(extra: Record<string, unknown> = {}): Env {
  const doStub = { fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: true, state: 'closed', count: 1, cap: 100, ok: true }) }) }
  return {
    WORKFLOW_CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    DAILY_CAP: { idFromName: vi.fn().mockReturnValue('do-id'), get: vi.fn().mockReturnValue(doStub) },
    CIRCUIT_BREAKER: { idFromName: vi.fn().mockReturnValue('cb-id'), get: vi.fn().mockReturnValue(doStub) },
    ...extra,
  } as unknown as Env
}

function jsonResponse(status: number, body: unknown) {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── Behavioral tests, one per status-emitting node ────────────────────────────

describe('status output key contract', () => {
  it('response node emits output.status', () => {
    const result = executeResponseNode(makeNode('response', { status_code: 207 }), makeCtx())
    expectCanonicalStatus(result.output, 207)
  })

  it('integration node emits output.status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(207, { ok: true })))
    const result = await executeIntegrationNode(
      makeNode('webhook', { url: 'https://api.example/x', method: 'POST' }),
      makeCtx(),
      makeEnv()
    )
    expectCanonicalStatus(result.output, 207)
  })

  it('salesforce node emits output.status', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok' }))
      .mockResolvedValueOnce(jsonResponse(201, { id: 'rec-1', success: true })))
    const result = await executeSalesforceNode(
      makeNode('salesforce', { operation: 'create', object: 'Prospect__c', body: {} }),
      makeCtx({}, {
        SALESFORCE_CLIENT_ID: 'id',
        SALESFORCE_CLIENT_SECRET: 'secret',
        SALESFORCE_INSTANCE_URL: 'https://trypennie.my.salesforce.com',
      }),
      makeEnv()
    )
    expectCanonicalStatus(result.output, 201)
  })

  it('partner_bid node emits output.status (API resolver)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ bid: 9.5 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ))
    const partner = {
      id: 'p1',
      slug: 'tripoint',
      api_endpoint: 'https://partner.example/bid',
      cf_secret_key: null,
      daily_cap: null,
      min_bid: null,
      bid_formula: null,
      bid_resolver_type: 'api',
      dedup_endpoint: null,
      circuit_error_threshold: 5,
      circuit_window_seconds: 60,
      circuit_cooldown_seconds: 300,
      circuit_enabled: false,
      is_active: true,
    }
    const chain: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'single') return () => Promise.resolve({ data: partner, error: null })
        return () => chain
      },
    })
    const result = await executePartnerBidNode(
      makeNode('partner_bid', { partner_id: 'p1' }),
      makeCtx({ debt_amount: 1000 }),
      makeEnv(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from: () => chain } as any
    )
    expectCanonicalStatus(result.output, 200)
  })

  it('achieve_offers node emits output.status', async () => {
    vi.stubGlobal('btoa', (s: string) => `b64(${s})`)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { id: 1, response: 'accepted', offers: [] })))
    const payload = {
      Submission__c: 'a04Ui00000I6lTKIAZ',
      personalInformation: {
        ssn: '113-52-2922', email: 'lead@example.com', primaryPhone: '(646) 770-6541',
        firstName: 'Joseph', lastName: 'Guerrera', dateOfBirth: '1959-12-29',
        address1: '190 Greenleaf Avenue', city: 'Staten Island', state: 'NY', zipcode: '10310',
      },
      loanInformation: { purpose: 'debt_consolidation', loanAmount: 7500 },
      financialInformation: { annualIncome: 122000, employmentStatus: 'employed_full_time' },
      creditInformation: { providedCreditRating: 'poor' },
      sessionInformation: { ipAddress: '207.29.44.2', userAgent: 'Mozilla/5.0' },
    }
    const result = await executeAchieveOffersNode(
      makeNode('achieve_offers', {}),
      makeCtx(payload, { ACHIEVE_USERNAME: 'user', ACHIEVE_PASSWORD: 'pass' })
    )
    expectCanonicalStatus(result.output, 200)
  })

  it('buyer_click_send node emits output.status', async () => {
    const ctx = makeCtx({ prospect: 'p-1', body: { a: 1 } })
    const result = await executeBuyerClickSendNode(
      makeNode('buyer_click_send', {
        partner_id: '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70', prospect_id: '{{trigger.payload.prospect}}', request_body: '{{trigger.payload.body}}',
      }),
      ctx,
      {
        readProfile: async () => ({ found: true, enabled: true, cap: 50, soldOn: 'click', clickDelivery: { routes: [{ name: 'ALL', url: 'https://buyer.example/lead', states: [] }], successPattern: 'created (?<id>\\w+)' } }),
        resolvePartner: async () => ({ slug: 'buyer' }),
        saleClient: () => ({ claim: async () => ({ state: 'claimed', generation: 1 }), sold: async () => 2, free: async () => 2 }),
        counter: () => ({ date: '2027-09-20', addMember: async () => ({ added: true, count: 1 }) }),
        recordHold: async () => undefined,
        post: async () => ({ status: 201, text: 'created abc123', json: null, isHtml: false, headers: {} }),
        alert: async () => 'posted',
        clock: () => 0,
        log: () => undefined,
        writeUnanswered: () => undefined,
        localDev: false,
      }
    )
    expectCanonicalStatus(result.output, 201)
  })
})
