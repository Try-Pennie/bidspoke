/**
 * The live wiring of connectionFetch's budget reading (#2336): recordSfBudget
 * reads the connection generation's measured org from the ops database, writes
 * record_sf_budget_reading with source sforce_limit_info and remaining = max
 * minus used, and remembers both across calls in one isolate.
 */
import { describe, expect, it } from 'vitest'
import type { OpsEnv } from '../index'
import { organizationIdFrom } from '../ops-db'
import { liveOpsConnectionsDeps } from '../ops-connections-live'
import { SF_BUDGET_READING_MIN_INTERVAL_MS, SfBudgetMemory } from '../connections/sf-budget-reading'

const ORG = organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60')
const CONN = '0199f0a0-0000-7000-8000-000000000001'
const SF_ORG = '00Dcs0000000001EAA'
const T0 = Date.parse('2026-10-19T12:00:00.000Z')
const configured: Partial<OpsEnv> = { LANE: 'ops', OPS_SUPABASE_URL: 'https://zwihpjxouklvkvngkvmw.supabase.co', OPS_SUPABASE_SECRET_KEY: 'sb_secret_test_not_real' }

/** The ops database: the measured identity table read and the record rpc, recorded. */
function opsDatabase(measured: unknown[]) {
  const calls: Array<{ path: string; query: Record<string, string>; body: unknown }> = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.pathname === '/rest/v1/connection_measured_identity') return Response.json(measured)
    if (url.pathname === '/rest/v1/rpc/record_sf_budget_reading') return Response.json('recorded')
    return Response.json({ message: 'unexpected' }, { status: 500 })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

describe('recordSfBudget on the live wiring', () => {
  it('reads the measured org, then writes the reading for it as sforce_limit_info, and only once a minute per org', async () => {
    const db = opsDatabase([{ sf_org_id: SF_ORG, organization_id: ORG }])
    const memory = new SfBudgetMemory()
    const deps = liveOpsConnectionsDeps(configured as OpsEnv, { opensLogins: false, opsFetch: db.fetch, sfBudgetMemory: memory }).connection

    await deps.recordSfBudget(ORG, CONN, 3, { used: 10018, max: 100000 }, T0)
    expect(db.calls.map((c) => c.path)).toEqual(['/rest/v1/connection_measured_identity', '/rest/v1/rpc/record_sf_budget_reading'])
    expect(db.calls[0].query).toMatchObject({ organization_id: `eq.${ORG}`, connection_id: `eq.${CONN}`, generation: 'eq.3' })
    expect(db.calls[1].body).toEqual({ p_sf_org_id: SF_ORG, p_daily_api_max: 100000, p_daily_api_remaining: 89982, p_source: 'sforce_limit_info' })

    // A second call within the minute, through a fresh set of deps (the next request in this isolate), writes nothing and reads nothing.
    const next = liveOpsConnectionsDeps(configured as OpsEnv, { opensLogins: false, opsFetch: db.fetch, sfBudgetMemory: memory }).connection
    await next.recordSfBudget(ORG, CONN, 3, { used: 10019, max: 100000 }, T0 + 1_000)
    expect(db.calls).toHaveLength(2)

    await next.recordSfBudget(ORG, CONN, 3, { used: 10100, max: 100000 }, T0 + SF_BUDGET_READING_MIN_INTERVAL_MS)
    expect(db.calls.map((c) => c.path).slice(2)).toEqual(['/rest/v1/rpc/record_sf_budget_reading'])
  })

  it('writes nothing for a connection generation verify has not measured', async () => {
    const db = opsDatabase([])
    const deps = liveOpsConnectionsDeps(configured as OpsEnv, { opensLogins: false, opsFetch: db.fetch, sfBudgetMemory: new SfBudgetMemory() }).connection
    await deps.recordSfBudget(ORG, CONN, 1, { used: 1, max: 100 }, T0)
    expect(db.calls.map((c) => c.path)).toEqual(['/rest/v1/connection_measured_identity'])
  })
})
