/**
 * The money identities an ops connection may never declare (#2338, build PR 5).
 *
 * Each identity is read from the bidding Worker by its name at request time,
 * compared against the declared target, and answered by that name alone: the
 * value is never in the answer.
 */
import { describe, expect, it, vi } from 'vitest'
import { FEATURE_GATED_SECRETS, REQUIRED_PARTNER_SECRETS, REQUIRED_SECRETS } from '../secret-lists'
import {
  MONEY_SNOWFLAKE_USER_NAMES, moneyHostOf, moneyHostsFrom, moneyTargetIn, moneyTargetsFrom, readMoneyHosts, readMoneyTargets, type MoneyHostReads,
} from '../connection-money-targets'
import { ACHIEVE_HOSTS } from '../../engine/nodes/achieve-identity'

const WORKER_ENV = {
  SUPABASE_URL: 'https://moneyref0123456789ab.supabase.co',
  SNOWFLAKE_ACCOUNT: 'MONEY12345.us-east-1',
  SNOWFLAKE_USER: 'BIDSPOKE_EXPORT',
  ARCHIVE_WRITER_USER: 'ARCHIVE_WRITER',
  ARCHIVE_READER_USER: 'ARCHIVE_READER',
  ARCHIVE_ERASER_USER: 'ARCHIVE_ERASER',
}
const MONEY_CLIENT_ID = '3MVG9-money-connected-app'

const targets = () => moneyTargetsFrom(WORKER_ENV, [MONEY_CLIENT_ID])

describe('the Snowflake users bidding signs in as', () => {
  it('are every *_USER name the secret lists hold, derived rather than listed', () => {
    const all = [...REQUIRED_SECRETS, ...REQUIRED_PARTNER_SECRETS, ...FEATURE_GATED_SECRETS] as string[]
    expect([...MONEY_SNOWFLAKE_USER_NAMES].sort()).toEqual(all.filter((n) => n.endsWith('_USER')).sort())
    expect(MONEY_SNOWFLAKE_USER_NAMES).toEqual(expect.arrayContaining(['SNOWFLAKE_USER', 'ARCHIVE_WRITER_USER', 'ARCHIVE_READER_USER', 'ARCHIVE_ERASER_USER']))
  })
})

describe('moneyTargetIn', () => {
  it.each([
    ['the money Supabase project, by its address', { url: 'https://moneyref0123456789ab.supabase.co' }, 'SUPABASE_URL'],
    ['the money Supabase project, by its ref', { project_ref: 'MoneyRef0123456789ab ' }, 'SUPABASE_URL'],
    ['the money Salesforce connected app', { instance_url: 'https://lendco.my.salesforce.com', client_id: MONEY_CLIENT_ID }, 'SALESFORCE_CLIENT_ID'],
    ['the export user', { account: 'ab99999.us-east-1', user: 'bidspoke_export' }, 'SNOWFLAKE_USER'],
    ['the archive writer', { account: 'MONEY12345.us-east-1', user: 'ARCHIVE_WRITER' }, 'ARCHIVE_WRITER_USER'],
    ['the archive reader', { account: 'MONEY12345', user: 'archive_reader' }, 'ARCHIVE_READER_USER'],
    ['the archive eraser', { user: ' ARCHIVE_ERASER' }, 'ARCHIVE_ERASER_USER'],
  ])('refuses %s, naming it by the secret it comes from', (_what, target, source) => {
    const found = moneyTargetIn(target, targets())
    expect(found?.source).toBe(source)
  })

  it('passes a target that is none of them', () => {
    expect(moneyTargetIn({ instance_url: 'https://trypennie.my.salesforce.com', client_id: '3MVG9-ops-app' }, targets())).toBeNull()
    expect(moneyTargetIn({ account: 'MONEY12345.us-east-1', user: 'OPS_READER', warehouse: 'OPS_WH' }, targets())).toBeNull()
  })

  it('never matches on a money value that is unset or blank', () => {
    const sparse = moneyTargetsFrom({ SUPABASE_URL: '', SNOWFLAKE_USER: '   ' }, [''])
    expect(sparse).toEqual([])
    expect(moneyTargetIn({ user: '', project_ref: ' ' }, sparse)).toBeNull()
  })

  it('carries no money value in what it answers', () => {
    const found = moneyTargetIn({ user: 'BIDSPOKE_EXPORT' }, targets())
    expect(JSON.stringify({ kind: found?.kind, source: found?.source })).not.toContain('BIDSPOKE_EXPORT')
  })
})

describe('readMoneyTargets', () => {
  it('reads the money Salesforce client id from the organization store beside the Worker env', async () => {
    const resolve = vi.fn(async () => ({ creds: { instanceUrl: 'https://x.my.salesforce.com', clientId: MONEY_CLIENT_ID, clientSecret: 'never-read' }, missing: [] }))
    const read = await readMoneyTargets(WORKER_ENV, 'org-1', resolve)
    expect(resolve).toHaveBeenCalledWith('org-1')
    expect(read.ok).toBe(true)
    if (read.ok) expect(moneyTargetIn({ client_id: MONEY_CLIENT_ID }, read.targets)?.source).toBe('SALESFORCE_CLIENT_ID')
  })

  it('refuses to answer, never passing, when the store cannot be read', async () => {
    const read = await readMoneyTargets(WORKER_ENV, 'org-1', async () => { throw new Error('db down SECRET') })
    expect(read).toEqual({ ok: false, detail: expect.not.stringContaining('SECRET') })
  })
})

/**
 * The hosts bidding sends to, which an HTTP connection may never declare
 * (#2337): an HTTP connection carries any key to any host, so the host is the
 * only thing that can keep it off the money lane's partners and off the
 * bidding Worker itself.
 */
describe('moneyHostsFrom and moneyHostOf', () => {
  const ENV = { ...WORKER_ENV, APP_URL: 'https://bidspoke.trypennie.dev' }
  const hosts = () => moneyHostsFrom(ENV, {
    salesforceInstanceUrls: ['https://lendco.my.salesforce.com'],
    partnerUrls: ['https://partner-proxy.trypennie.dev/bid', 'https://offers.lender.example/click?id={prospect_id}', '{{env.PARTNER_URL}}', ''],
    moneyDefinitions: [JSON.stringify({ nodes: [{ type: 'webhook', data: { config: { url: 'https://api.equifax.example/v1/report' } } }, { type: 'code', data: { code: 'await fetch("https://risk.decide.example/run")' } }] })],
  })

  it.each([
    ['the money Supabase project', 'moneyref0123456789ab.supabase.co', 'SUPABASE_URL'],
    ['a host under the money Supabase project', 'db.moneyref0123456789ab.supabase.co', 'SUPABASE_URL'],
    ['the bidding Worker itself', 'bidspoke.trypennie.dev', 'APP_URL'],
    ['a partner subdomain the bidding Worker answers (the *.trypennie.dev route)', 'tripoint.trypennie.dev', 'APP_URL'],
    ['the money Salesforce instance', 'lendco.my.salesforce.com', 'SALESFORCE_INSTANCE_URL'],
    ['a money partner endpoint', 'offers.lender.example', 'partner_configs'],
    ['a host a money workflow calls', 'api.equifax.example', 'money workflows'],
    ['a host a money code node calls', 'risk.decide.example', 'money workflows'],
    ['an Achieve host the achieve_offers node calls', ACHIEVE_HOSTS[0], 'ACHIEVE_HOSTS'],
  ])('refuses %s', (_what, host, source) => {
    expect(moneyHostOf(host, hosts())).toEqual({ host, source })
  })

  it('takes a partner or workflow host exactly, never the domain around it', () => {
    expect(moneyHostOf('sandbox.lender.example', hosts())).toBeNull()
    expect(moneyHostOf('equifax.example', hosts())).toBeNull()
    expect(moneyHostOf('api.lender-ops.example', hosts())).toBeNull()
    // A host under an exact one is another host: only the domain sources (Supabase, the bidding zone, Salesforce) reach down.
    expect(moneyHostOf('eu.api.equifax.example', hosts())).toBeNull()
    expect(moneyHostOf('beta.offers.lender.example', hosts())).toBeNull()
  })

  it('takes the bidding zone from APP_URL only when APP_URL has a zone above its host', () => {
    const bare = moneyHostsFrom({ APP_URL: 'https://bidspoke.app' }, { salesforceInstanceUrls: [], partnerUrls: [], moneyDefinitions: [] })
    expect(moneyHostOf('bidspoke.app', bare)?.source).toBe('APP_URL')
    expect(moneyHostOf('other.app', bare)).toBeNull()
  })

  it('never matches on a value that is unset, blank or not an address', () => {
    expect(moneyHostsFrom({ SUPABASE_URL: '', APP_URL: 'not a url' }, { salesforceInstanceUrls: [''], partnerUrls: ['{{env.X}}'], moneyDefinitions: ['{}'] })
      .filter((h) => h.source !== 'ACHIEVE_HOSTS')).toEqual([])
  })
})

describe('readMoneyHosts', () => {
  const reads = (over: Partial<MoneyHostReads> = {}): MoneyHostReads => ({
    salesforce: async () => ({ creds: { clientId: MONEY_CLIENT_ID, instanceUrl: 'https://lendco.my.salesforce.com' }, missing: [] }),
    partnerUrls: async () => ['https://partner-proxy.trypennie.dev/bid'],
    moneyDefinitions: async () => [],
    ...over,
  })

  it('reads every source for the organization, the Salesforce instance from the organization store', async () => {
    const read = await readMoneyHosts(WORKER_ENV, 'org-1', reads())
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(moneyHostOf('lendco.my.salesforce.com', read.hosts)?.source).toBe('SALESFORCE_INSTANCE_URL')
      expect(moneyHostOf('partner-proxy.trypennie.dev', read.hosts)?.source).toBe('partner_configs')
    }
  })

  it.each([
    ['the organization store', { salesforce: async () => { throw new Error('db down SECRET') } }],
    ['the partner endpoints', { partnerUrls: async () => { throw new Error('db down SECRET') } }],
    ['the money workflows', { moneyDefinitions: async () => { throw new Error('db down SECRET') } }],
  ])('refuses to answer, never passing, when %s cannot be read', async (_what, over) => {
    const read = await readMoneyHosts(WORKER_ENV, 'org-1', reads(over as Partial<MoneyHostReads>))
    expect(read).toEqual({ ok: false, detail: expect.not.stringContaining('SECRET') })
  })
})
