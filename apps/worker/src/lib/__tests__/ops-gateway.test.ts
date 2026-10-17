/**
 * The bidding Worker's side of the ops minute cron (#1949): what it serves the
 * ops Worker (decision 4: the ops workflows' state, read from the one home of
 * every definition), the heartbeat it keeps for the tick, and the check that
 * pages on the tick's report. The watchdog is here, in the Worker the tick does
 * not depend on, so it keeps judging when the ops Worker is down (L71).
 */
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { completedKey, heartbeatKey } from '../cron-heartbeat'
import { OPS_TICK_JOB, OPS_TICK_REPORT_KEY, OPS_TICK_REPORT_FRESH_MS, readOpsWorkflows, recordOpsTickCompleted, recordOpsTickStarted, runOpsTickReportCheck } from '../ops-gateway'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const WF = '00000000-0000-4000-8000-0000000019a1'
const NOW = Date.parse('2026-10-17T10:02:31.000Z')

function kv() {
  const m = new Map<string, string>()
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => { m.set(k, v) },
    delete: async (k: string) => { m.delete(k) },
  }
}

/** PostgREST for the workflows read, answering `rows` and recording each query. */
function workflowsDb(rows: unknown[], opts: { status?: number } = {}) {
  const queries: URL[] = []
  const fakeFetch: typeof globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    queries.push(url)
    if (opts.status) return Response.json({ code: 'PGRST000', message: 'the database is not answering' }, { status: opts.status })
    return Response.json(rows)
  }) as typeof globalThis.fetch
  // retry off, as the gateway's own client has it (ops-gateway-entrypoint.ts): the tick is waiting.
  return { client: createClient('https://xvrmivmpfykwwtriqwpg.supabase.co', 'sb_secret_test', { global: { fetch: fakeFetch }, auth: { persistSession: false }, db: { retry: false } } as never), queries }
}

const row = (over: Record<string, unknown> = {}) => ({
  id: WF, organization_id: ORG, is_active: true, deleted_at: null, updated_at: '2026-10-17T09:00:00.123456+00:00', lane: 'ops',
  trigger: { type: 'schedule', config: { interval_seconds: 300 } }, workflow_versions: [{ version_number: 4 }], ...over,
})

describe('readOpsWorkflows', () => {
  it('serves every ops workflow, deleted and switched off ones too, with its latest version and trigger', async () => {
    const { client, queries } = workflowsDb([row(), row({ id: '00000000-0000-4000-8000-0000000019a2', is_active: false, deleted_at: '2026-10-16T00:00:00+00:00', workflow_versions: [] })])
    const list = await readOpsWorkflows(client, NOW)
    expect(list).toEqual({
      served_at: new Date(NOW).toISOString(),
      complete: true,
      workflows: [
        { id: WF, organization_id: ORG, is_active: true, deleted_at: null, updated_at: '2026-10-17T09:00:00.123456+00:00', version_number: 4, trigger: { type: 'schedule', config: { interval_seconds: 300 } } },
        { id: '00000000-0000-4000-8000-0000000019a2', organization_id: ORG, is_active: false, deleted_at: '2026-10-16T00:00:00+00:00', updated_at: '2026-10-17T09:00:00.123456+00:00', version_number: null, trigger: { type: 'schedule', config: { interval_seconds: 300 } } },
      ],
    })
    const q = queries[0]
    expect(q.pathname).toBe('/rest/v1/workflows')
    expect(q.searchParams.get('lane')).toBe('eq.ops')
    expect(q.searchParams.get('select')).toMatch(/trigger:definition->trigger/)
    expect(q.searchParams.get('select')).not.toMatch(/definition(,|$)/)
    // Soft deleted rows are served, so the ops copy learns of a delete.
    expect(q.searchParams.has('deleted_at')).toBe(false)
  })

  it('drops a row the lane filter let through, and then does not claim the list is complete', async () => {
    const { client } = workflowsDb([row(), row({ id: '00000000-0000-4000-8000-0000000019a3', lane: 'money' })])
    const list = await readOpsWorkflows(client, NOW)
    expect(list.workflows.map((w) => w.id)).toEqual([WF])
    expect(list.complete).toBe(false)
  })

  it('throws on a failed read rather than serving an empty list, which would withdraw every ops workflow', async () => {
    const { client } = workflowsDb([], { status: 503 })
    await expect(readOpsWorkflows(client, NOW)).rejects.toThrow(/ops workflows/)
  })
})

describe('the heartbeat the tick stamps through the gateway', () => {
  it('stamps started and completed on this Worker\'s clock, and keeps the report', async () => {
    const store = kv()
    await recordOpsTickStarted(store as unknown as KVNamespace, NOW)
    expect(store.m.get(heartbeatKey(OPS_TICK_JOB))).toBe(new Date(NOW).toISOString())
    const report = {
      tick_id: 't', mode: 'observe', scheduled_time: null, started_at: '2026-10-17T10:02:30Z', finished_at: '2026-10-17T10:02:31Z',
      db_now: '2026-10-17T10:02:30Z', outcome: 'ok', problems: [], counts: { fires_observed: 1 },
    }
    await recordOpsTickCompleted(store as unknown as KVNamespace, report, NOW + 1000)
    expect(store.m.get(completedKey(OPS_TICK_JOB))).toBe(new Date(NOW + 1000).toISOString())
    expect(JSON.parse(store.m.get(OPS_TICK_REPORT_KEY)!)).toMatchObject({ ...report, received_at: new Date(NOW + 1000).toISOString() })
  })

  it('keeps an unreadable report as a failing one, so it pages rather than reading as healthy', async () => {
    const store = kv()
    await recordOpsTickCompleted(store as unknown as KVNamespace, { outcome: 'ok', problems: 'none' }, NOW)
    const kept = JSON.parse(store.m.get(OPS_TICK_REPORT_KEY)!)
    expect(kept.outcome).toBe('problems')
    expect(kept.problems[0]).toMatch(/could not be read/)
  })
})

describe('runOpsTickReportCheck', () => {
  const stored = (over: Record<string, unknown>) => JSON.stringify({
    tick_id: 't', mode: 'observe', scheduled_time: null, started_at: '2026-10-17T10:02:00Z', finished_at: '2026-10-17T10:02:01Z',
    db_now: null, outcome: 'ok', problems: [], counts: {}, received_at: new Date(NOW - 30_000).toISOString(), ...over,
  })

  function deps() {
    const sent: Array<{ errors: string[]; title: string; fixHint?: string }> = []
    const recovered: string[] = []
    return {
      sent,
      recovered,
      notifyFailure: async (_s: unknown, job: string, errors: string[], _k: unknown, remedy: { title: string; fixHint?: string }) => {
        expect(job).toBe(OPS_TICK_JOB)
        sent.push({ errors, title: remedy.title, fixHint: remedy.fixHint })
      },
      notifyRecovery: async (_k: unknown, job: string) => { recovered.push(job) },
    }
  }

  it('pages on a report that names problems, with the problems as the findings', async () => {
    const store = kv()
    store.m.set(OPS_TICK_REPORT_KEY, stored({ outcome: 'problems', problems: ['The lease_expiry sweep failed: lock timeout.'] }))
    const d = deps()
    expect(await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW, d)).toBe('alerted')
    expect(d.sent).toEqual([{ errors: ['The lease_expiry sweep failed: lock timeout.'], title: 'The ops minute cron reported a problem', fixHint: expect.stringMatching(/ops_tick/) }])
  })

  it('pages on not configured with the fix that configures it', async () => {
    const store = kv()
    store.m.set(OPS_TICK_REPORT_KEY, stored({ outcome: 'not_configured', problems: ['The ops tick cannot reach its database: OPS_SUPABASE_SECRET_KEY is not set on bidspoke-worker-ops.'] }))
    const d = deps()
    await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW, d)
    expect(d.sent[0].title).toBe('The ops minute cron is not configured')
    expect(d.sent[0].fixHint).toMatch(/OPS_SUPABASE_SECRET_KEY/)
  })

  it('stands an alert down on a clean report', async () => {
    const store = kv()
    store.m.set(OPS_TICK_REPORT_KEY, stored({}))
    const d = deps()
    expect(await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW, d)).toBe('healthy')
    expect(d.recovered).toEqual([OPS_TICK_JOB])
    expect(d.sent).toEqual([])
  })

  it('leaves an old report, or none, to the heartbeat, which pages on a tick that stopped', async () => {
    const d = deps()
    expect(await runOpsTickReportCheck({} as never, kv() as unknown as KVNamespace, NOW, d)).toBe('no_report')
    const store = kv()
    store.m.set(OPS_TICK_REPORT_KEY, stored({ outcome: 'problems', problems: ['x'], received_at: new Date(NOW - OPS_TICK_REPORT_FRESH_MS - 1).toISOString() }))
    expect(await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW, d)).toBe('stale')
    expect(d.sent).toEqual([])
    expect(d.recovered).toEqual([])
  })

  it('judges a report whose received time is unreadable, rather than reading it as old and staying quiet (L50)', async () => {
    const store = kv()
    store.m.set(OPS_TICK_REPORT_KEY, stored({ outcome: 'problems', problems: ['x'], received_at: 'garbled' }))
    const d = deps()
    expect(await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW, d)).toBe('alerted')
  })

  it('pages on a stored report it cannot read', async () => {
    const store = kv()
    store.m.set(OPS_TICK_REPORT_KEY, 'not json')
    const d = deps()
    expect(await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW, d)).toBe('alerted')
    expect(d.sent[0].errors[0]).toMatch(/could not be read/)
  })
})

describe('the OpsGateway entrypoint', () => {
  it('stamps through the methods the ops Worker calls, and has no others', async () => {
    const { OpsGateway } = await import('../ops-gateway-entrypoint')
    const store = kv()
    const gw = new OpsGateway({} as ExecutionContext, { IDEMPOTENCY: store } as never)
    expect(await gw.opsTickStarted()).toEqual({ stamped: 'started' })
    expect(store.m.has(heartbeatKey(OPS_TICK_JOB))).toBe(true)
    expect(Object.getOwnPropertyNames(OpsGateway.prototype).sort()).toEqual(['constructor', 'opsTickCompleted', 'opsTickStarted', 'opsWorkflows'])
  })
})
