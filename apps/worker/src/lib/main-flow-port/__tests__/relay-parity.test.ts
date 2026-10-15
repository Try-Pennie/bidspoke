/**
 * Relay parity (#2171, #1680 plan point 14): for each outcome post, the PATCH the
 * native step sends equals the PATCH Pipedream's Update Submission relay made
 * from what the webhook step posted.
 *
 * Both sides run the engine's real code over the same inputs:
 *  - expected: the live webhook node (from the production definition) through
 *    executeIntegrationNode, its posted body captured off the wire, then the
 *    relay as the contract records it (docs/salesforce-post-answer-write-contract.md,
 *    question 1): stop unless the body carries a submissionId, then PATCH that
 *    Submission with exactly 28 keys, 26 passed through and two renamed, a key the
 *    body lacks left out (the brief's reading of the one open point), `""` and
 *    the string `"null"` kept as they came;
 *  - actual: the ported node through executeSalesforceNode, its PATCH captured.
 * The relay model below is written from the contract, not from the transform's
 * constants, so the two cannot agree by sharing a mistake (L345).
 *
 * The inputs are fixtures/relay-parity.json: synthetic values on the key sets and
 * value types measured from production (its `about`), never shaped for the rule.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../../index'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import { buildContext } from '../../../engine/context'
import { executeIntegrationNode } from '../../../engine/nodes/integration'
import { executeSalesforceNode } from '../../../engine/nodes/salesforce'
import { stubFetch } from '../../../__tests__/helpers/fetch-mock'
import { PORT_STAGES, portMainFlow } from '../transform'
import { nodeByNamespace, productionMainFlow } from './production-fixture'
import parity from './fixtures/relay-parity.json'

/** `relay_writes: false` marks the one case whose body the relay's filter stopped; every other case must have reached Salesforce. */
interface ParityCase { post: string; name: string; steps: Record<string, unknown>; relay_writes?: boolean }
const cases = parity.cases as ParityCase[]

const APP_URL = 'https://app.example.test'
const INSTANCE = 'https://example.my.salesforce.com'

/** The 26 keys the relay passes through, and its two renames, as the contract lists them. */
const RELAY_PASSTHROUGH = [
  'ADV_SO__c', 'XBC_SO__c', 'Monthly_Creditor_Payment_ES__c', 'Unsecured_Debt_Verified_ES__c', 'Credit_Pull_Result_ES__c',
  'PDFlow_1__c', 'PDFlow_2__c', 'External_Exchange_Status__c', 'External_Partner_Name__c', 'External_Routing_Code__c',
  'External_Timestamp__c', 'EQXCreditPullStatus__c', 'InternalDebtRouting__c', 'LeadSaleType__c', 'PD_Completed_Timestamp__c',
  'VantageScore__c', 'TripointLeadID__c', 'Tripoint_Response__c', 'AmOneBid__c', 'AmOneClickURL__c', 'EnrolledPennieDebt__c',
  'ExternalDebtAmount__c', 'Prescreen_Completed__c', 'CreditFreeze__c', 'Tripoint_Create_Timestamp__c', 'Tripoint_Create_Result_Code__c',
]
const RELAY_RENAMED: Record<string, string> = { leadUUID: 'Engine_Lead_UUID_SO__c', UUID: 'Engine_UUID_SO__c' }

interface SubmissionPatch { recordId: string; body: Record<string, unknown> }

/** What the Update Submission relay wrote for a posted body, or null where its filter ended the run. */
function relayWrite(posted: string | undefined): SubmissionPatch | null {
  if (posted === undefined) return null
  const request = JSON.parse(posted) as unknown
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return null
  const r = request as Record<string, unknown>
  if (r.submissionId === undefined || r.submissionId === null) return null
  const body: Record<string, unknown> = {}
  for (const key of RELAY_PASSTHROUGH) if (Object.hasOwn(r, key)) body[key] = r[key]
  for (const [from, to] of Object.entries(RELAY_RENAMED)) if (Object.hasOwn(r, from)) body[to] = r[from]
  return { recordId: String(r.submissionId), body }
}

const env = { WORKFLOW_CACHE: { get: vi.fn().mockResolvedValue('tok'), put: vi.fn(), delete: vi.fn() } } as unknown as Env

function contextFor(c: ParityCase): ExecutionContext {
  const ctx = buildContext(parity.payload, 'mainflow', 'wf-gate', 'trace-gate', {
    SALESFORCE_CLIENT_ID: 'id', SALESFORCE_CLIENT_SECRET: 'secret', SALESFORCE_INSTANCE_URL: INSTANCE,
  }, 'org-gate', 'exec-gate-0000', APP_URL)
  for (const [ns, output] of Object.entries(c.steps)) ctx.steps[ns] = { output } as never
  return ctx
}

const production = productionMainFlow()
const ported = portMainFlow(productionMainFlow(), PORT_STAGES.inquiry)

/** The posts the production definition makes to the relay: its webhook nodes the trigger counts as success. */
const relayPostsInProduction = (production.trigger as { config: { success_node_namespaces: string[] } }).config.success_node_namespaces
  .filter((ns) => production.nodes.some((n) => n.namespace === ns && n.type === 'webhook'))

async function relaySide(c: ParityCase): Promise<SubmissionPatch | null> {
  const fetchMock = stubFetch()
  fetchMock.mockResolvedValue(new Response('{"success":true}', { status: 200 }))
  await executeIntegrationNode(nodeByNamespace(production, c.post) as unknown as NodeDefinition, contextFor(c), env)
  const posted = fetchMock.mock.calls[0]?.[1]?.body as string | undefined
  vi.unstubAllGlobals()
  return relayWrite(posted)
}

async function nativeSide(c: ParityCase): Promise<{ patch: SubmissionPatch | null; calls: number }> {
  const fetchMock = stubFetch()
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
  await executeSalesforceNode(nodeByNamespace(ported, c.post) as unknown as NodeDefinition, contextFor(c), env)
  const calls = fetchMock.mock.calls
  vi.unstubAllGlobals()
  if (calls.length === 0) return { patch: null, calls: 0 }
  const [url, init] = calls[0] as [string, { method: string; body: string }]
  const match = new RegExp(`^${INSTANCE}/services/data/v60\\.0/sobjects/Submission__c/([^/]+)$`).exec(url)
  expect({ post: c.post, method: init.method, url_is_submission: !!match }).toEqual({ post: c.post, method: 'PATCH', url_is_submission: true })
  return { patch: { recordId: decodeURIComponent(match![1]), body: JSON.parse(init.body) as Record<string, unknown> }, calls: calls.length }
}

describe('every relay post has a parity case', () => {
  it.each(relayPostsInProduction)('%s', (post) => {
    expect(cases.filter((c) => c.post === post).map((c) => c.name), `no parity case for ${post} in fixtures/relay-parity.json`).not.toEqual([])
  })

  it('the production definition makes exactly the nine relay posts the port replaces', () => {
    expect(relayPostsInProduction).toHaveLength(9)
  })
})

describe('the native PATCH is the relay PATCH, plus the Bidspoke run link in PDFlow_4__c', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each(cases.map((c) => [`${c.post}: ${c.name}`, c] as const))('%s', async (_label, c) => {
    const relay = await relaySide(c)
    const native = await nativeSide(c)
    expect({ case: c.name, relay_wrote: relay !== null }).toEqual({ case: c.name, relay_wrote: c.relay_writes !== false })
    if (relay === null) {
      expect({ post: c.post, native: native.patch }).toEqual({ post: c.post, native: null })
      return
    }
    expect(native.calls).toBe(1)
    expect(native.patch).toEqual({
      recordId: relay.recordId,
      body: { ...relay.body, PDFlow_4__c: `${APP_URL}/workflows/wf-gate?execution=exec-gate-0000` },
    })
  })

  it('the text bodies keep what the relay received: an empty string and the string null stay strings', async () => {
    const c = cases.find((x) => x.post === 'send_salesforce' && x.steps.gen_vantage_score === null)!
    const native = await nativeSide(c)
    expect(native.patch?.body.VantageScore__c).toBe('null')
    const common = cases.find((x) => x.post === 'send_salesforce' && x.steps.gen_vantage_score !== null)!
    const nativeCommon = await nativeSide(common)
    expect(nativeCommon.patch?.body.Credit_Pull_Result_ES__c).toBe('')
  })
})
