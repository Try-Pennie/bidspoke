/**
 * The production partner resolver of buyer_click_send (#1553): the node stores a
 * partner id and looks up the slug through the org's cached partner constants,
 * the same org scoped read the Constants node uses. Driven through a real
 * loadPartnerConstants over an in-memory KV and a Supabase double, so nothing is
 * mocked but the storage.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../../index'
import { buildContext } from '../../context'
import { productionDeps } from '../buyer-click-send'

const LIBERTY1 = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'

function kvOf(entries: Record<string, unknown>): KVNamespace {
  return {
    get: async (key: string) => entries[key] ?? null,
    put: async () => undefined,
    delete: async () => undefined,
  } as unknown as KVNamespace
}

/** Every read fails, as it did in the 2026-09-10 Supabase outage. */
function failingSupabase(): SupabaseClient {
  const chain: unknown = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'eq') return () => Promise.resolve({ data: null, error: { message: 'pool timeout' } })
      return () => chain
    },
  })
  return { from: () => chain } as unknown as SupabaseClient
}

const envWith = (kv: KVNamespace) => ({ WORKFLOW_CACHE: kv, APP_URL: 'https://app.test' }) as unknown as Env
const ctxFor = (org: string) => buildContext({}, 'liberty-proxy', 'wf-1', 'trace-1', {}, org, 'exec-1')

describe('productionDeps.resolvePartner (#1553)', () => {
  it('answers the slug the org currently gives the partner id', async () => {
    const org = 'org-resolve-hit'
    const kv = kvOf({ [`partner-constants-v2-${org}`]: { subAccountIdsMap: {}, sellOff: {}, clickUrls: {}, activeBidding: {}, subAccountMinBids: {}, slugsById: { [LIBERTY1]: 'liberty1' } } })
    const deps = productionDeps(ctxFor(org), envWith(kv), failingSupabase())
    expect(await deps.resolvePartner(LIBERTY1)).toEqual({ slug: 'liberty1' })
  })

  it('answers null for an id the org does not hold', async () => {
    const org = 'org-resolve-miss'
    const kv = kvOf({ [`partner-constants-v2-${org}`]: { subAccountIdsMap: {}, sellOff: {}, clickUrls: {}, activeBidding: {}, subAccountMinBids: {}, slugsById: {} } })
    const deps = productionDeps(ctxFor(org), envWith(kv), failingSupabase())
    expect(await deps.resolvePartner(LIBERTY1)).toBeNull()
  })

  it('throws, rather than answering no such partner, when only a last good copy from before the id map is available', async () => {
    const org = 'org-resolve-old-lastgood'
    const kv = kvOf({ [`partner-constants-v2-${org}-lastgood`]: { subAccountIdsMap: {}, sellOff: {}, clickUrls: {}, activeBidding: {}, subAccountMinBids: {} } })
    const deps = productionDeps(ctxFor(org), envWith(kv), failingSupabase())
    await expect(deps.resolvePartner(LIBERTY1)).rejects.toThrow(/last good copy written before partner ids were recorded/)
  })

  it('throws when the read fails and there is no copy at all', async () => {
    const org = 'org-resolve-nothing'
    const deps = productionDeps(ctxFor(org), envWith(kvOf({})), failingSupabase())
    await expect(deps.resolvePartner(LIBERTY1)).rejects.toThrow(/pool timeout/)
  })
})
