/**
 * Money's Salesforce run as identity (#2335, PR 6 of phase 5 of #1689; plan:
 * discussion #2329, part 2): measured once a day on the bidding Worker from
 * money's own token, through the unchanged getSalesforceToken, with one
 * /services/oauth2/userinfo call, and served to the ops Worker for one
 * organization at a time through OpsGateway.moneyIdentities, so ops verify can
 * refuse an ops credential that authenticates as money's user.
 *
 * Every port is injected: the credential organization, the credentials, the
 * token, the fetch and the clock. The token is a canary that must never reach
 * an error, the stored reading, or the console.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpsGatewayContractError, parseServedMoneyIdentities } from '../ops-gateway-contract'
import {
  MONEY_IDENTITY_JOB, measureMoneyIdentity, moneySalesforceIdentityKey, readMoneyIdentities, type MoneyIdentityDeps,
} from '../money-identity'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const OTHER_ORG = '7a2d3c9f-1e4b-4d2f-8b66-2c3d4e5f6071'
const NOW = Date.parse('2026-10-18T13:00:05.000Z')
const TOKEN = 'canary-money-token-5e1d9b'
const SF_ORG = '00D5f000000AbCdEAQ'
const USERNAME = 'integration@example.test'
const INSTANCE = 'https://example.my.salesforce.com'

function kv(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial))
  return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v) } }
}

const userinfo = (over: Record<string, unknown> = {}) => Response.json({ organization_id: SF_ORG, preferred_username: USERNAME, user_id: '0055f000000XyZaAAA', ...over })

function deps(over: Partial<MoneyIdentityDeps> & { store?: ReturnType<typeof kv> } = {}) {
  const store = over.store ?? kv()
  const calls: Array<{ url: string; auth: string | null; method: string }> = []
  const tokens: string[] = []
  const d: MoneyIdentityDeps = {
    kv: store,
    credentialOrg: async () => ({ orgId: ORG, error: null }),
    creds: async () => ({ instanceUrl: INSTANCE, clientId: 'money-client', clientSecret: 'money-secret' }),
    token: async (orgId) => { tokens.push(orgId); return TOKEN },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), method: init?.method ?? 'GET' })
      return userinfo()
    }) as typeof fetch,
    now: () => NOW,
    ...over,
  }
  return { d, store, calls, tokens }
}

let logged: string[]
beforeEach(() => {
  logged = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')) })
  }
})
afterEach(() => vi.restoreAllMocks())

const kept = (store: ReturnType<typeof kv>) => JSON.parse(store.m.get(moneySalesforceIdentityKey(ORG))!)

describe('measureMoneyIdentity', () => {
  it('makes one userinfo call with money\'s own token and keeps the org id and username it answers', async () => {
    const { d, store, calls, tokens } = deps()
    const r = await measureMoneyIdentity(d)
    expect(r).toEqual({ organizationId: ORG, measured: true, errors: [] })
    expect(tokens).toEqual([ORG])
    expect(calls).toEqual([{ url: `${INSTANCE}/services/oauth2/userinfo`, auth: `Bearer ${TOKEN}`, method: 'GET' }])
    expect(kept(store)).toEqual({ organization_id: ORG, sf_org_id: SF_ORG, username: USERNAME, measured_at: new Date(NOW).toISOString() })
    expect(JSON.stringify([...store.m.values()])).not.toContain(TOKEN)
  })

  it('names the job the heartbeat registry knows it by', () => {
    expect(MONEY_IDENTITY_JOB).toBe('money-identity')
  })

  const previous = { [moneySalesforceIdentityKey(ORG)]: JSON.stringify({ organization_id: ORG, sf_org_id: SF_ORG, username: USERNAME, measured_at: '2026-10-17T13:00:04.000Z' }) }

  it.each([
    ['no organization holds money\'s Salesforce credentials', { credentialOrg: async () => ({ orgId: null, error: 'no_org_holds_salesforce_credentials' }) }, /no_org_holds_salesforce_credentials/],
    ['the credentials are missing', { creds: async () => { throw new Error('Salesforce credentials missing for the money identity measurement: SALESFORCE_CLIENT_ID') } }, /SALESFORCE_CLIENT_ID/],
    ['the token endpoint refuses', { token: async () => { throw Object.assign(new Error(`Salesforce token fetch failed (400): {"error":"invalid_client","echo":"${TOKEN}"}`), { status: 400 }) } }, /token.*400/],
    ['the token endpoint does not answer', { token: async () => { throw new Error('Salesforce token fetch timed out after 10000 ms') } }, /token.*no answer/],
    ['userinfo refuses the token', { fetch: (async () => new Response(`{"error":"bad token ${TOKEN}"}`, { status: 401 })) as typeof fetch }, /userinfo.*401/],
    ['userinfo answers no org id', { fetch: (async () => userinfo({ organization_id: undefined })) as typeof fetch }, /Salesforce org id/],
    ['userinfo answers no username', { fetch: (async () => userinfo({ preferred_username: '' })) as typeof fetch }, /username/],
    ['userinfo answers something that is not JSON', { fetch: (async () => new Response('<html>blocked</html>', { status: 200 })) as typeof fetch }, /userinfo.*not JSON/],
    ['userinfo throws', { fetch: (async () => { throw new Error(`network down ${TOKEN}`) }) as typeof fetch }, /userinfo.*no answer/],
  ])('when %s, it reports the cause by name, keeps yesterday\'s reading, and never shows the token', async (_label, over, why) => {
    const store = kv(previous)
    const { d } = deps({ ...over, store })
    const r = await measureMoneyIdentity(d)
    expect(r.measured).toBe(false)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(why)
    expect(r.errors[0]).not.toContain(TOKEN)
    expect(store.m.get(moneySalesforceIdentityKey(ORG))).toBe(previous[moneySalesforceIdentityKey(ORG)])
    expect(logged.join('\n')).not.toContain(TOKEN)
  })

  it('gives up on a userinfo call that does not answer within its deadline', async () => {
    const { d } = deps({
      timeoutMs: 20,
      fetch: ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as typeof fetch,
    })
    const r = await measureMoneyIdentity(d)
    expect(r.errors[0]).toMatch(/userinfo.*20 ms/)
  })
})

describe('readMoneyIdentities, what OpsGateway.moneyIdentities serves', () => {
  const store = () => kv({ [moneySalesforceIdentityKey(ORG)]: JSON.stringify({ organization_id: ORG, sf_org_id: SF_ORG, username: USERNAME, measured_at: '2026-10-18T13:00:05.000Z' }) })

  it('answers the organization asked about with its reading, which the ops side reads back', async () => {
    const served = await readMoneyIdentities(store(), ORG, NOW)
    expect(served).toEqual({ organization_id: ORG, served_at: new Date(NOW).toISOString(), salesforce: { sf_org_id: SF_ORG, username: USERNAME, measured_at: '2026-10-18T13:00:05.000Z' } })
    expect(parseServedMoneyIdentities(served, ORG)).toEqual(served)
  })

  it('answers another organization with no reading, never this one\'s', async () => {
    expect(await readMoneyIdentities(store(), OTHER_ORG, NOW)).toEqual({ organization_id: OTHER_ORG, served_at: new Date(NOW).toISOString(), salesforce: null })
  })

  it('refuses a reading kept under this organization that names another', async () => {
    const s = kv({ [moneySalesforceIdentityKey(OTHER_ORG)]: JSON.stringify({ organization_id: ORG, sf_org_id: SF_ORG, username: USERNAME, measured_at: '2026-10-18T13:00:05.000Z' }) })
    await expect(readMoneyIdentities(s, OTHER_ORG, NOW)).rejects.toThrow(/another organization/)
  })

  it.each([
    ['an organization that is not a uuid', 'pennie'],
    ['no organization', undefined],
  ])('refuses to be asked with %s', async (_label, org) => {
    await expect(readMoneyIdentities(store(), org, NOW)).rejects.toThrow(OpsGatewayContractError)
  })

  it('refuses an unreadable kept reading by name rather than answering unmeasured', async () => {
    await expect(readMoneyIdentities(kv({ [moneySalesforceIdentityKey(ORG)]: '{not json' }), ORG, NOW)).rejects.toThrow(/unreadable/)
    await expect(readMoneyIdentities(kv({ [moneySalesforceIdentityKey(ORG)]: JSON.stringify({ organization_id: ORG, sf_org_id: 'x' }) }), ORG, NOW)).rejects.toThrow(/Salesforce org id/)
  })
})

describe('parseServedMoneyIdentities, the ops side', () => {
  const answer = { organization_id: ORG, served_at: '2026-10-18T22:00:00.000Z', salesforce: { sf_org_id: SF_ORG, username: USERNAME, measured_at: '2026-10-18T13:00:05.000Z' } }

  it('reads an unmeasured answer as unmeasured', () => {
    expect(parseServedMoneyIdentities({ ...answer, salesforce: null }, ORG).salesforce).toBeNull()
  })

  it('refuses an answer for another organization than the one asked about', () => {
    expect(() => parseServedMoneyIdentities(answer, OTHER_ORG)).toThrow(/another organization/)
  })

  it.each([
    ['a reading with a malformed org id', { ...answer, salesforce: { ...answer.salesforce, sf_org_id: '005abc' } }],
    ['a reading with no measurement time', { ...answer, salesforce: { ...answer.salesforce, measured_at: 'today' } }],
    ['no served_at', { ...answer, served_at: undefined }],
    ['not an object', 'answer'],
  ])('refuses %s', (_label, raw) => {
    expect(() => parseServedMoneyIdentities(raw, ORG)).toThrow(OpsGatewayContractError)
  })
})
