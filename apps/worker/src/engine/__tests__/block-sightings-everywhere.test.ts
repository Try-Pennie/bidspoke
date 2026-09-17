/**
 * Every worker-side reader of a partner body notes a block page sighting (#1265).
 *
 * The readers are enumerated by the state they reach (a partner's non-2xx body read), not
 * from memory: the partner bid resolver, the integration node, the Salesforce node's
 * operation call, its token fetch and its query paging, the Achieve offers node, and the
 * partner dedup check. Two carriers exist because not every reader has a step result to
 * ride on: a sighting is noted on the execution context (`ctx.blockSightings`, drained by
 * the walker after each step) or attached to the thrown error where no context is in
 * scope. Each case feeds the REAL archived Achieve page through a fetch double and asserts
 * the sighting names the host we called and the step that saw it, and that a JSON error of
 * the same status notes nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { stubFetch, type FetchMock } from '../../__tests__/helpers/fetch-mock'
import { ACHIEVE_CLOUDFLARE_BLOCK_PAGE } from '../../lib/__tests__/fixtures/achieve-cloudflare-block-page'
import { executeIntegrationNode } from '../nodes/integration'
import { resolveBid } from '../bid-resolver'
import { executeSalesforceNode, getSalesforceToken } from '../nodes/salesforce'
import { executeAchieveOffersNode } from '../nodes/achieve-offers'
import { checkDedup } from '../nodes/partner-bid'
import { drainBlockSightings } from '../block-sightings'
import type { Env } from '../../index'
import type { ExecutionContext, NodeDefinition, PartnerBlockSighting } from '../../types'

const JSON_403 = JSON.stringify({ error: 'forbidden' })

function fakeResponse(status: number, body: string, headers: Record<string, string> = {}) {
  let parsed: unknown = null
  try { parsed = JSON.parse(body) } catch { parsed = body }
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(parsed),
    headers: new Headers({ 'content-type': status >= 400 ? 'text/html' : 'application/json', 'cf-ray': 'a369312f2f2faa85-EWR', ...headers }),
  }
}

function makeCtx(env: Record<string, string> = {}): ExecutionContext {
  return {
    trigger: { payload: { credit_score: 700, leadUuid: 'lead-1' }, source: 'test', workflow_id: 'wf-1', org_id: 'org-1', trace_id: 'tr-1', execution_id: 'exec-1' },
    steps: {},
    env,
    execution: { workflow_id: 'wf-1', trace_id: 'tr-1', execution_id: 'exec-1' },
  } as unknown as ExecutionContext
}

const env = {
  WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
  APP_URL: 'https://app.test',
} as unknown as Env

let fetchMock: FetchMock
beforeEach(() => { fetchMock = stubFetch(); vi.stubGlobal('btoa', (s: string) => `b64(${s})`) })
afterEach(() => { vi.unstubAllGlobals() })

const errorSightings = (e: unknown): PartnerBlockSighting[] => ((e as { blockSightings?: PartnerBlockSighting[] })?.blockSightings ?? [])

describe('integration node', () => {
  const node = (): NodeDefinition => ({ id: 'int_1', namespace: 'call_partner', type: 'webhook', config: { url: 'https://partner.test/bid', method: 'POST', body: { a: 1 } } })

  it('notes a sighting on the context for a block page, naming the host and the step', async () => {
    fetchMock.mockResolvedValue(fakeResponse(403, ACHIEVE_CLOUDFLARE_BLOCK_PAGE))
    const ctx = makeCtx()
    await expect(executeIntegrationNode(node(), ctx, env)).rejects.toBeDefined()
    const seen = drainBlockSightings(ctx)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ host: 'partner.test', status: 403, vendor: 'cloudflare', bodyRayId: 'a369312f2f2faa85', edgeRayId: 'a369312f2f2faa85-EWR', seenIn: 'call_partner' })
    expect(drainBlockSightings(ctx)).toHaveLength(0)
  })

  it('notes nothing for a JSON 403', async () => {
    fetchMock.mockResolvedValue(fakeResponse(403, JSON_403, { 'content-type': 'application/json' }))
    const ctx = makeCtx()
    await expect(executeIntegrationNode(node(), ctx, env)).rejects.toBeDefined()
    expect(drainBlockSightings(ctx)).toHaveLength(0)
  })
})

describe('partner bid resolver', () => {
  const partner = (overrides: Record<string, unknown> = {}) => ({
    slug: 'testpartner', bid_resolver_type: 'api', api_endpoint: 'https://partner.test/bid', api_method: 'POST',
    response_classification: null, alert_config: null, ...overrides,
  }) as unknown as Parameters<typeof resolveBid>[0]

  it('notes a sighting before the classification override runs, so an override cannot hide it', async () => {
    fetchMock.mockResolvedValue(fakeResponse(403, ACHIEVE_CLOUDFLARE_BLOCK_PAGE))
    const ctx = makeCtx()
    await expect(resolveBid(partner({ response_classification: { permanent_signals: [{ status_code: 403 }] } }), ctx, env)).rejects.toBeDefined()
    const seen = drainBlockSightings(ctx)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ host: 'partner.test', seenIn: 'partner:testpartner', vendor: 'cloudflare' })
  })

  it('notes nothing for a JSON 403', async () => {
    fetchMock.mockResolvedValue(fakeResponse(403, JSON_403, { 'content-type': 'application/json' }))
    const ctx = makeCtx()
    await expect(resolveBid(partner(), ctx, env)).rejects.toBeDefined()
    expect(drainBlockSightings(ctx)).toHaveLength(0)
  })
})

describe('salesforce node', () => {
  const INSTANCE = 'https://pennie.my.salesforce.com'
  const sfEnv = { SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret', SALESFORCE_INSTANCE_URL: INSTANCE }
  const node = (): NodeDefinition => ({ id: 'sf1', namespace: 'create_prospect', type: 'salesforce', config: { operation: 'create', object: 'Prospect__c', body: {} } })
  const token = () => fakeResponse(200, JSON.stringify({ access_token: 'sf-token' }), { 'content-type': 'application/json' })

  it('notes a sighting when the operation call answers with a block page', async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(fakeResponse(403, ACHIEVE_CLOUDFLARE_BLOCK_PAGE))
    const ctx = makeCtx(sfEnv)
    await expect(executeSalesforceNode(node(), ctx, { ...env, ...sfEnv } as unknown as Env)).rejects.toBeDefined()
    const seen = drainBlockSightings(ctx)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ host: 'pennie.my.salesforce.com', seenIn: 'create_prospect', vendor: 'cloudflare' })
  })

  it('attaches a sighting to the error when the token endpoint answers with a block page', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(403, ACHIEVE_CLOUDFLARE_BLOCK_PAGE))
    let caught: unknown
    try {
      await getSalesforceToken({ ...env, ...sfEnv } as unknown as Env, 'org-1', INSTANCE, 'id', 'secret')
    } catch (e) { caught = e }
    expect(caught).toBeDefined()
    expect(errorSightings(caught)).toHaveLength(1)
    expect(errorSightings(caught)[0]).toMatchObject({ host: 'pennie.my.salesforce.com', seenIn: 'salesforce:token', vendor: 'cloudflare' })
  })
})

describe('achieve offers node', () => {
  const node = (): NodeDefinition => ({ id: 'ach', namespace: 'achieve_offers', type: 'achieve_offers', config: {} } as NodeDefinition)
  const achieveEnv = { ACHIEVE_USERNAME: 'user', ACHIEVE_PASSWORD: 'pass', ACHIEVE_API_URL: 'https://api.freedomfinancialnet.com' }
  // The same complete lead the Achieve node's own tests send, so the node reaches the call.
  const payload = {
    Submission__c: 'a04Ui00000I6lTKIAZ',
    personalInformation: {
      ssn: '113-52-2922', email: 'lead@example.com', primaryPhone: '(646) 770-6541', firstName: 'Joseph', lastName: 'Guerrera',
      dateOfBirth: '1959-12-29', address1: '190 Greenleaf Avenue', address2: '14A', city: 'Staten Island', state: 'NY', zipcode: '10310',
    },
    loanInformation: { purpose: 'debt_consolidation', loanAmount: 7500 },
    financialInformation: { annualIncome: 122000, employmentStatus: 'employed_full_time' },
    creditInformation: { providedCreditRating: 'poor' },
    sessionInformation: { ipAddress: '207.29.44.2', userAgent: 'Mozilla/5.0' },
  }

  it('records the block in the result reason and notes a sighting, without failing the flow', async () => {
    fetchMock.mockResolvedValue(fakeResponse(403, ACHIEVE_CLOUDFLARE_BLOCK_PAGE))
    const ctx = { ...makeCtx(achieveEnv), trigger: { ...makeCtx().trigger, payload } } as unknown as ExecutionContext
    const result = await executeAchieveOffersNode(node(), ctx)
    const output = result.output as Record<string, unknown>
    expect(output.response_status).toBe('error')
    expect(String(output.response_reason)).toMatch(/block page/i)
    expect(String(output.response_reason)).toContain('a369312f2f2faa85')
    const seen = drainBlockSightings(ctx)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ host: 'api.freedomfinancialnet.com', seenIn: 'achieve_offers', vendor: 'cloudflare' })
  })
})

describe('partner dedup check', () => {
  it('notes a sighting for a block page and still answers not a duplicate, as it does for any non-2xx today', async () => {
    fetchMock.mockResolvedValue(fakeResponse(403, ACHIEVE_CLOUDFLARE_BLOCK_PAGE))
    const ctx = makeCtx()
    const duplicate = await checkDedup('https://dedup.partner.test/check', ctx, 'testpartner')
    expect(duplicate).toBe(false)
    const seen = drainBlockSightings(ctx)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ host: 'dedup.partner.test', seenIn: 'dedup:testpartner' })
  })
})
