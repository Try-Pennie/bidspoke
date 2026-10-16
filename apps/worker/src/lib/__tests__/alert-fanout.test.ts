import { describe, it, expect, vi } from 'vitest'
import { slackOrgIds, forEachSlackOrg, rateLimitedOrgAlert } from '../alert-fanout'
import type { SupabaseClient } from '@supabase/supabase-js'

// Minimal Supabase double for the one query these helpers make:
//   .from('service_connections').select('organization_id').eq('service_type','slack')
// resolved by awaiting the builder. `rows` is what that query returns; `error`
// lets a test exercise the read-failure path.
function supabaseWithOrgs(rows: { organization_id: string }[], error: unknown = null): SupabaseClient {
  const builder: Record<string, unknown> = {}
  builder.select = () => builder
  builder.eq = () => builder
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: error ? null : rows, error })
  return { from: () => builder } as unknown as SupabaseClient
}

// Map-backed KV double with just get/put.
function kvDouble(seed: Record<string, string> = {}): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v)
    },
  } as unknown as KVNamespace & { store: Map<string, string> }
}

describe('slackOrgIds', () => {
  it('returns deduped org ids for slack connections', async () => {
    const supabase = supabaseWithOrgs([
      { organization_id: 'org-1' },
      { organization_id: 'org-2' },
      { organization_id: 'org-1' },
    ])
    expect(await slackOrgIds(supabase, 'test', 'tell-only')).toEqual({ kind: 'live', orgIds: ['org-1', 'org-2'] })
  })

  it('says it could not read, rather than answering an empty list, when the read fails (#1303)', async () => {
    const supabase = supabaseWithOrgs([], { message: 'boom' })
    expect(await slackOrgIds(supabase, 'test', 'tell-only')).toEqual({ kind: 'unreachable', reason: 'read_failed' })
  })

  it('answers an empty live list when the database has no Slack organizations', async () => {
    expect(await slackOrgIds(supabaseWithOrgs([]), 'test', 'tell-only')).toEqual({ kind: 'live', orgIds: [] })
  })
})

describe('forEachSlackOrg', () => {
  it('invokes perOrg once per unique org and returns each result in order', async () => {
    const supabase = supabaseWithOrgs([{ organization_id: 'a' }, { organization_id: 'b' }, { organization_id: 'a' }])
    const seen: string[] = []
    const results = await forEachSlackOrg(supabase, 'test', 'tell-only', async (orgId) => {
      seen.push(orgId)
      return orgId === 'a'
    })
    expect(seen).toEqual(['a', 'b'])
    expect(results).toEqual({ kind: 'ran', source: 'live', results: [true, false] })
  })

  it('runs nothing and says so when the org list could not be read (#1303)', async () => {
    const perOrg = vi.fn(async () => true)
    const results = await forEachSlackOrg(supabaseWithOrgs([], { message: 'boom' }), 'test', 'tell-only', perOrg)
    expect(results).toEqual({ kind: 'unreachable', reason: 'read_failed' })
    expect(perOrg).not.toHaveBeenCalled()
  })
})

describe('rateLimitedOrgAlert', () => {
  it('fans out, returns true, and sets the cooldown when any org is alerted', async () => {
    const supabase = supabaseWithOrgs([{ organization_id: 'a' }])
    const kv = kvDouble()
    const perOrg = vi.fn(async () => true)
    const alerted = await rateLimitedOrgAlert({
      kv,
      cooldownKey: 'k',
      ttlSeconds: 100,
      supabase,
      logLabel: 'test',
      use: 'tell-only',
      perOrg,
    })
    expect(alerted).toBe(true)
    expect(perOrg).toHaveBeenCalledTimes(1)
    expect(kv.store.get('k')).toBe('1')
  })

  it('does NOT set the cooldown when nothing was alerted', async () => {
    const supabase = supabaseWithOrgs([{ organization_id: 'a' }])
    const kv = kvDouble()
    const alerted = await rateLimitedOrgAlert({
      kv,
      cooldownKey: 'k',
      ttlSeconds: 100,
      supabase,
      logLabel: 'test',
      use: 'tell-only',
      perOrg: async () => false,
    })
    expect(alerted).toBe(false)
    expect(kv.store.has('k')).toBe(false)
  })

  it('is suppressed by an existing cooldown: perOrg is never called', async () => {
    const supabase = supabaseWithOrgs([{ organization_id: 'a' }])
    const kv = kvDouble({ k: '1' })
    const perOrg = vi.fn(async () => true)
    const alerted = await rateLimitedOrgAlert({
      kv,
      cooldownKey: 'k',
      ttlSeconds: 100,
      supabase,
      logLabel: 'test',
      use: 'tell-only',
      perOrg,
    })
    expect(alerted).toBe(false)
    expect(perOrg).not.toHaveBeenCalled()
  })
})
