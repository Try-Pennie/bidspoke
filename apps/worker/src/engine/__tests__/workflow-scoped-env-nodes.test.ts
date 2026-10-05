/**
 * A workflow's own value reaches the templates of a Salesforce node and a Webhook
 * (integration) node, the two node types that also lay the Worker secrets into
 * their template env (#1681).
 *
 * Composed from the real pieces, so the assertion is on what the node SENDS: the
 * real env loader over a database double that applies its filters, the engine's
 * own context builder, and the real node executors. The Worker env holds the
 * org's Cloudflare copy of the secret, as production does for every org secret,
 * which is the copy that used to win in these two nodes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import type { NodeDefinition } from '../../types'
import { loadEnvVars } from '../../lib/env-loader'
import { encryptSecret, secretKeys } from '../../lib/secret-crypto'
import { buildContext } from '../context'
import { executeIntegrationNode } from '../nodes/integration'
import { executeSalesforceNode } from '../nodes/salesforce'
import { stubFetch, type FetchMock } from '../../__tests__/helpers/fetch-mock'

const ORG = 'org-1'
const WF_A = 'wf-a'
const WF_B = 'wf-b'
const KEY = btoa('0'.repeat(32))
const INSTANCE = 'https://trypennie.my.salesforce.com'

function makeKV() {
  const store = new Map<string, string>()
  return {
    async get(k: string) { return store.get(k) ?? null },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  } as unknown as KVNamespace
}

async function rows() {
  const row = (key: string, value: string, extra: Record<string, unknown> = {}) =>
    ({ organization_id: ORG, key, value, is_secret: false, scope: 'global', workflow_id: null, ...extra })
  return [
    row('SALESFORCE_INSTANCE_URL', INSTANCE),
    row('SALESFORCE_CLIENT_ID', 'client-id'),
    row('PARTNER_TOKEN', await encryptSecret('org-token', KEY), { is_secret: true }),
    row('PARTNER_TOKEN', await encryptSecret('a-token', KEY), { is_secret: true, scope: 'workflow', workflow_id: WF_A }),
  ]
}

function filteringSupabase(data: Array<Record<string, unknown>>): SupabaseClient {
  return {
    from: () => {
      const filters: Array<[string, unknown]> = []
      const chain = {
        select: () => chain,
        // Accepted, not applied: these cases hold far fewer rows than one page.
        order: () => chain,
        range: () => chain,
        eq: (col: string, val: unknown) => { filters.push([col, val]); return chain },
        then: (resolve: (r: unknown) => void) => resolve({ data: data.filter((r) => filters.every(([c, v]) => r[c] === v)), error: null }),
      }
      return chain
    },
  } as unknown as SupabaseClient
}

async function setUp() {
  const kv = makeKV()
  // A held Salesforce token, so the node goes straight to the record call.
  await kv.put(`sf-token-${ORG}`, 'sf-token')
  const env = {
    WORKFLOW_CACHE: kv,
    SECRET_ENCRYPTION_KEY: KEY,
    APP_URL: 'https://bidspoke.trypennie.dev',
    // The org secret's Cloudflare copy, and the one Salesforce credential that
    // production holds as a Worker secret as well.
    PARTNER_TOKEN: 'org-token',
    SALESFORCE_CLIENT_SECRET: 'client-secret',
  } as unknown as Env
  const sb = filteringSupabase(await rows())
  const ctxFor = async (workflowId: string) => {
    const envVars = await loadEnvVars(ORG, kv, sb, secretKeys(env), { workflowId })
    return buildContext({ lead: 1 }, 'test', workflowId, 'tr-1', envVars, ORG, 'exec-1', env.APP_URL)
  }
  return { env, ctxFor }
}

const ok = (status: number, body: string) => ({
  ok: true,
  status,
  text: () => Promise.resolve(body),
  json: () => Promise.resolve(JSON.parse(body)),
  headers: new Headers({ 'content-type': 'application/json' }),
})

describe("a workflow's own value in the Salesforce and Webhook node templates (#1681)", () => {
  let fetchMock: FetchMock
  afterEach(() => { fetchMock.mockReset() })

  it("reaches a Webhook node's template, and a sibling workflow's node gets the org value", async () => {
    fetchMock = stubFetch()
    fetchMock.mockResolvedValue(ok(200, '{}'))
    const { env, ctxFor } = await setUp()
    const node: NodeDefinition = {
      id: 'w', namespace: 'notify_partner', type: 'webhook',
      config: { url: 'https://partner.example/leads', auth: { type: 'bearer', token: '{{env.PARTNER_TOKEN}}' } },
    } as unknown as NodeDefinition

    await executeIntegrationNode(node, await ctxFor(WF_A), env)
    await executeIntegrationNode(node, await ctxFor(WF_B), env)

    expect(fetchMock.mock.calls.map((c) => c[1].headers['Authorization'])).toEqual(['Bearer a-token', 'Bearer org-token'])
  })

  it("reaches a Salesforce node's template, and a sibling workflow's node gets the org value", async () => {
    fetchMock = stubFetch()
    fetchMock.mockResolvedValue(ok(201, '{"id":"SF-1"}'))
    const { env, ctxFor } = await setUp()
    const node: NodeDefinition = {
      id: 's', namespace: 'create_prospect', type: 'salesforce',
      config: { operation: 'create', object: 'Prospect__c', body: { Partner_Token__c: '{{env.PARTNER_TOKEN}}' } },
    } as unknown as NodeDefinition

    await executeSalesforceNode(node, await ctxFor(WF_A), env)
    await executeSalesforceNode(node, await ctxFor(WF_B), env)

    const sent = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string).Partner_Token__c)
    expect(sent).toEqual(['a-token', 'org-token'])
  })
})
