import { describe, expect, it } from 'vitest'
import { assertSameProject, keepJoinStatus, loadConfig } from './live.ts'

describe('loadConfig: a cleanup needs only what a cleanup uses', () => {
  const noFiles = () => ({})
  const urlAndSecret = { SUPABASE_URL: 'https://xvrmivmpfykwwtriqwpg.supabase.co', SUPABASE_SECRET_KEY: 's' }

  it('loads for a cleanup with only the URL and the secret key, so a ledger can always be cleaned up', () => {
    expect(loadConfig('cleanup', urlAndSecret, noFiles)).toMatchObject({ project: 'xvrmivmpfykwwtriqwpg', secretKey: 's' })
  })

  it('refuses a run without the publishable key and Org A\'s sign in, naming each', () => {
    expect(() => loadConfig('run', urlAndSecret, noFiles)).toThrow(/publishableKey, orgAEmail, orgAPassword/)
  })

  it('refuses even a cleanup without the URL or the secret key', () => {
    expect(() => loadConfig('cleanup', { SUPABASE_URL: 'https://x.supabase.co' }, noFiles)).toThrow(/secretKey/)
  })
})

describe('keepJoinStatus: the Worker subscriber reports how its join went, not how it ended', () => {
  it('keeps SUBSCRIBED when the channel is closed afterwards', () => {
    expect(keepJoinStatus('SUBSCRIBED', 'CLOSED')).toBe('SUBSCRIBED')
  })

  it('takes the first answer to the join', () => {
    expect(keepJoinStatus(null, 'SUBSCRIBED')).toBe('SUBSCRIBED')
    expect(keepJoinStatus(null, 'CHANNEL_ERROR')).toBe('CHANNEL_ERROR')
  })
})
import type { SpikeConfig } from './cli.ts'

const hosted = { supabaseUrl: 'https://xvrmivmpfykwwtriqwpg.supabase.co', project: 'xvrmivmpfykwwtriqwpg' } as SpikeConfig
const local = { supabaseUrl: 'http://127.0.0.1:55621', project: '127' } as SpikeConfig

describe('assertSameProject: the sender and the subscribers must use one database', () => {
  it('refuses with no PGHOST', () => {
    expect(() => assertSameProject(hosted, {})).toThrow(/PGHOST is not set/)
  })

  it('accepts a hosted project whose ref is in PGHOST or PGUSER', () => {
    expect(() => assertSameProject(hosted, { PGHOST: 'db.xvrmivmpfykwwtriqwpg.supabase.co', PGUSER: 'cli_login_postgres' })).not.toThrow()
    expect(() => assertSameProject(hosted, { PGHOST: 'aws-0-us-west-2.pooler.supabase.com', PGUSER: 'cli_login_postgres.xvrmivmpfykwwtriqwpg' })).not.toThrow()
  })

  it('refuses a hosted project with PG* naming another project', () => {
    expect(() => assertSameProject(hosted, { PGHOST: 'db.zwihpjxouklvkvngkvmw.supabase.co', PGUSER: 'postgres' })).toThrow(/do not name project/)
  })

  it('refuses a hosted project with a local database, and a local project with a remote one', () => {
    expect(() => assertSameProject(hosted, { PGHOST: '127.0.0.1', PGUSER: 'postgres' })).toThrow(/do not name project/)
    expect(() => assertSameProject(local, { PGHOST: 'db.xvrmivmpfykwwtriqwpg.supabase.co', PGUSER: 'cli_login_postgres' })).toThrow(/local/)
  })

  it('accepts a local project with a local database', () => {
    expect(() => assertSameProject(local, { PGHOST: '127.0.0.1', PGUSER: 'postgres' })).not.toThrow()
    expect(() => assertSameProject(local, { PGHOST: 'localhost', PGUSER: 'postgres' })).not.toThrow()
  })

  it('refuses any other kind of SUPABASE_URL, rather than not checking it', () => {
    expect(() => assertSameProject({ supabaseUrl: 'https://supabase.example.org', project: 'supabase' } as SpikeConfig, { PGHOST: 'db.example.org' })).toThrow(/neither/)
  })
})
