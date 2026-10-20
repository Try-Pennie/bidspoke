/**
 * The money identities an ops connection may never declare (#2338, build PR 5).
 *
 * Each identity is read from the bidding Worker by its name at request time,
 * compared against the declared target, and answered by that name alone: the
 * value is never in the answer.
 */
import { describe, expect, it, vi } from 'vitest'
import { FEATURE_GATED_SECRETS, REQUIRED_PARTNER_SECRETS, REQUIRED_SECRETS } from '../secret-lists'
import { MONEY_SNOWFLAKE_USER_NAMES, moneyTargetIn, moneyTargetsFrom, readMoneyTargets } from '../connection-money-targets'

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
