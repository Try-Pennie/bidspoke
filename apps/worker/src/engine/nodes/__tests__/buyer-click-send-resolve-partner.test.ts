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
import { createLeadSupabaseClient, noteLeadWriteUnanswered } from '../../../lib/lead-read-budget'

const LIBERTY1 = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'

// Each seeded entry is held as a load just confirmed it (#1847), so a last good
// copy is judged on what it holds rather than refused for its age.
function kvOf(entries: Record<string, unknown>): KVNamespace {
  return {
    get: async (key: string) => entries[key] ?? null,
    getWithMetadata: async (key: string) => ({
      value: key in entries ? JSON.stringify(entries[key]) : null,
      metadata: key in entries ? { confirmed_at: new Date().toISOString() } : null,
    }),
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

/**
 * The production cap read (#1543, L83): the over cap notice is judged against
 * the buyer PROFILE's daily cap, read through the one profile reader, so the
 * send and buyer_click_check can never disagree about the number.
 */
describe('productionDeps.readProfile (#1543, #1639)', () => {
  const buyerSnapshot = (org: string, cap: number | null) => ({
    org_id: org, loaded_at: new Date().toISOString(), content_hash: 'test', served_from: 'database',
    buyers: [{ partner: { id: LIBERTY1, slug: 'liberty1' }, profile: { partnerId: LIBERTY1, soldOn: 'click', isEnabled: true, dailyLeadCap: cap }, version: 1, updated_at: '2027-09-20T10:00:00.000Z' }],
  })

  it('answers the enabled profile daily cap and how the buyer is sold from the cached snapshot', async () => {
    const org = 'org-cap-hit'
    const deps = productionDeps(ctxFor(org), envWith(kvOf({ [`buyer-profiles:${org}`]: buyerSnapshot(org, 50) })), failingSupabase())
    expect(await deps.readProfile(LIBERTY1)).toEqual({ found: true, enabled: true, cap: 50, soldOn: 'click', clickDelivery: null })
  })

  it('carries the enabled profile click delivery from the same read, so the route and the cap come from one snapshot (#1639)', async () => {
    const org = 'org-delivery-hit'
    const delivery = { routes: [{ name: 'All', url: 'https://a.example/all', states: [] }], successPattern: '(?<id>\\w+)' }
    const snapshot = buyerSnapshot(org, 50)
    const withDelivery = { ...snapshot, buyers: [{ ...snapshot.buyers[0], profile: { ...snapshot.buyers[0].profile, clickDelivery: delivery } }] }
    const deps = productionDeps(ctxFor(org), envWith(kvOf({ [`buyer-profiles:${org}`]: withDelivery })), failingSupabase())
    expect(await deps.readProfile(LIBERTY1)).toEqual({ found: true, enabled: true, cap: 50, soldOn: 'click', clickDelivery: delivery })
  })

  const snapshotWithSwitchedOff = (org: string, switchedOff: unknown[] | undefined) =>
    kvOf({ [`buyer-profiles:${org}`]: { ...buyerSnapshot(org, 50), buyers: [], ...(switchedOff === undefined ? {} : { switched_off: switchedOff }) } })

  // Dan, 2026-09-30: switching a profile off stops new offers only, so a click on an
  // offer already shown is still sent through the switched off profile's delivery,
  // which the same snapshot carries (#1849), so the database is never asked.
  it('a buyer the enabled snapshot does not hold is read from its switched off profiles: switched off, with its delivery, and no cap', async () => {
    const org = 'org-switched-off'
    const doc = { routes: [{ name: 'All', url: 'https://a.example/all', states: [] }], success_pattern: '(?<id>\\w+)' }
    const deps = productionDeps(ctxFor(org), envWith(snapshotWithSwitchedOff(org, [{ partner_id: LIBERTY1, sold_on: 'click', click_delivery: doc }])), failingSupabase())
    expect(await deps.readProfile(LIBERTY1)).toEqual({ found: true, enabled: false, cap: null, soldOn: 'click', clickDelivery: { routes: doc.routes, successPattern: doc.success_pattern } })
  })

  it('answers found false when the buyer has no profile at all', async () => {
    const org = 'org-cap-none'
    const deps = productionDeps(ctxFor(org), envWith(snapshotWithSwitchedOff(org, [])), failingSupabase())
    expect(await deps.readProfile(LIBERTY1)).toEqual({ found: false })
  })

  it('throws for a snapshot written before it carried the switched off profiles, never answering no profile', async () => {
    const org = 'org-old-snapshot'
    const deps = productionDeps(ctxFor(org), envWith(snapshotWithSwitchedOff(org, undefined)), failingSupabase())
    await expect(deps.readProfile(LIBERTY1)).rejects.toThrow(/written before it carried the switched off profiles/)
  })

  it('throws when the profiles cannot be read and there is no copy, never answering no profile', async () => {
    const org = 'org-cap-unreadable'
    const deps = productionDeps(ctxFor(org), envWith(kvOf({})), failingSupabase())
    await expect(deps.readProfile(LIBERTY1)).rejects.toThrow(/buyer profiles read failed/)
  })
})

/**
 * The held click record in a database the lead has already seen fail (#1849).
 * The outage drill's hung shape found the click answering two seconds after its
 * healthy twin: a profile or partner read waited out its deadline, then the
 * record waited out its own. The record has its own repair (the next click on
 * the prospect finds the claim and records it), so once the lead knows the
 * database is down it is not sent, and is reported as not recorded.
 */
describe('productionDeps.recordHold in a database the lead has seen fail (#1849)', () => {
  const hold = { partner_id: LIBERTY1, prospect_id: 'a0B1', reason: 'outcome_unknown' as const, detail: 'http 503', partner_lead_id: null, workflow_id: 'wf-1', execution_id: 'exec-1', trace_id: 'trace-1' }
  const dbEnv = { SUPABASE_URL: 'https://db.example.test', SUPABASE_SECRET_KEY: 'k' } as unknown as Env

  function counting() {
    const state = { calls: 0 }
    const fetch = (async () => {
      state.calls++
      return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch
    return { state, fetch }
  }

  it('is not sent once a database call in the lead failed, and says why', async () => {
    const db = counting()
    const supabase = createLeadSupabaseClient(dbEnv, { fetch: db.fetch })
    noteLeadWriteUnanswered(supabase, 'buyer profiles')
    const deps = productionDeps(ctxFor('org-down'), envWith(kvOf({})), supabase)
    await expect(deps.recordHold(hold)).rejects.toThrow(/record_held_click not sent: an earlier database call in this lead failed \(buyer profiles/)
    expect(db.state.calls).toBe(0)
  })

  it('is sent as before on a lead whose database has answered', async () => {
    const db = counting()
    const deps = productionDeps(ctxFor('org-up'), envWith(kvOf({})), createLeadSupabaseClient(dbEnv, { fetch: db.fetch }))
    await deps.recordHold(hold)
    expect(db.state.calls).toBe(1)
  })
})
