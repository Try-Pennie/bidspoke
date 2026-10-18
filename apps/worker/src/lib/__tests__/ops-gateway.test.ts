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

  // #2333: the secrets a not_configured report names pick the page's remedy, so
  // a list that cannot be trusted is refused, and the report pages as unreadable.
  it.each([
    ['names no secret on a not_configured report', { outcome: 'not_configured', problems: ['x'], not_configured_secrets: [] }],
    ['names a secret on an ok report', { outcome: 'ok', problems: [], not_configured_secrets: ['OPS_CONNECTIONS_PRIVATE_KEY'] }],
    ['names something that is not a secret name', { outcome: 'not_configured', problems: ['x'], not_configured_secrets: ['see the logs'] }],
    ['is not a list', { outcome: 'not_configured', problems: ['x'], not_configured_secrets: 'OPS_CONNECTIONS_PRIVATE_KEY' }],
  ])('keeps a report whose secret list %s as unreadable', async (_label, over) => {
    const store = kv()
    const report = {
      tick_id: 't', mode: 'observe', scheduled_time: null, started_at: '2026-10-17T10:02:30Z', finished_at: '2026-10-17T10:02:31Z',
      db_now: null, counts: {}, ...over,
    }
    await recordOpsTickCompleted(store as unknown as KVNamespace, report, NOW)
    const kept = JSON.parse(store.m.get(OPS_TICK_REPORT_KEY)!)
    expect(kept.outcome).toBe('problems')
    expect(kept.problems[0]).toMatch(/could not be read/)
  })

  it('keeps the secrets a not_configured report names', async () => {
    const store = kv()
    const report = {
      tick_id: 't', mode: 'observe', scheduled_time: null, started_at: '2026-10-17T10:02:30Z', finished_at: '2026-10-17T10:02:31Z',
      db_now: null, outcome: 'not_configured', problems: ['x'], counts: {}, not_configured_secrets: ['OPS_CONNECTIONS_PRIVATE_KEY'],
    }
    await recordOpsTickCompleted(store as unknown as KVNamespace, report, NOW)
    expect(JSON.parse(store.m.get(OPS_TICK_REPORT_KEY)!).not_configured_secrets).toEqual(['OPS_CONNECTIONS_PRIVATE_KEY'])
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

  // A report from an ops release before #2333 names no secret; the only cause such
  // a release could report was the ops database, so its remedy is the database one.
  it('pages on not configured with the fix that configures it', async () => {
    const store = kv()
    store.m.set(OPS_TICK_REPORT_KEY, stored({ outcome: 'not_configured', problems: ['The ops tick cannot reach its database: OPS_SUPABASE_SECRET_KEY is not set on bidspoke-worker-ops.'] }))
    const d = deps()
    await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW, d)
    expect(d.sent[0].title).toBe('The ops minute cron is not configured')
    expect(d.sent[0].fixHint).toMatch(/OPS_SUPABASE_SECRET_KEY/)
  })

  // #2333: the page's remedy follows the secret the tick named, so a missing ops
  // private key is never answered with the database's steps.
  it('pages on a missing ops private key with the private key\'s remedy, not the database one', async () => {
    const store = kv()
    store.m.set(OPS_TICK_REPORT_KEY, stored({
      outcome: 'not_configured',
      problems: ['OPS_CONNECTIONS_PRIVATE_KEY is not set on bidspoke-worker-ops, so no ops connection can be opened.'],
      not_configured_secrets: ['OPS_CONNECTIONS_PRIVATE_KEY'],
    }))
    const d = deps()
    expect(await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW, d)).toBe('alerted')
    expect(d.sent[0].title).toBe('The ops minute cron is not configured')
    expect(d.sent[0].fixHint).toMatch(/Bidspoke recovery keys/)
    expect(d.sent[0].fixHint).toMatch(/wrangler secret put OPS_CONNECTIONS_PRIVATE_KEY --config wrangler\.ops\.toml/)
    expect(d.sent[0].fixHint).not.toMatch(/OPS_SUPABASE/)
    // The escrowed copy is a file attached to the item, not a field (#2333): the
    // remedy names the file and reads it with op read, so following it works.
    expect(d.sent[0].fixHint).toMatch(/op read "op:\/\/<vault>\/Bidspoke recovery keys\/ops-connections-private\.pem"/)
    expect(d.sent[0].fixHint).not.toMatch(/field/)
  })

  it('names the remedy of every secret reported, once each, in the order reported', async () => {
    const store = kv()
    store.m.set(OPS_TICK_REPORT_KEY, stored({
      outcome: 'not_configured',
      problems: ['a', 'b', 'c'],
      not_configured_secrets: ['OPS_SUPABASE_URL', 'OPS_CONNECTIONS_PRIVATE_KEY', 'OPS_SUPABASE_SECRET_KEY'],
    }))
    const d = deps()
    await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW, d)
    const fix = d.sent[0].fixHint ?? ''
    expect(fix.indexOf('OPS_SUPABASE_URL')).toBeGreaterThanOrEqual(0)
    expect(fix.indexOf('OPS_SUPABASE_URL')).toBeLessThan(fix.indexOf('Bidspoke recovery keys'))
    // The two database secrets share one remedy, said once.
    expect(fix.match(/Create a secret key for bidspoke-worker-ops/g)).toHaveLength(1)
  })

  // The report goes through KV between the two parses: kept by
  // recordOpsTickCompleted, read back here. An older release's report names no
  // secret, and the kept copy must still page with the database's remedy.
  it('pages an older release\'s not configured report with the database remedy after it is kept and read back', async () => {
    const store = kv()
    await recordOpsTickCompleted(store as unknown as KVNamespace, {
      tick_id: 't', mode: 'observe', scheduled_time: null, started_at: '2026-10-17T10:02:00Z', finished_at: '2026-10-17T10:02:01Z',
      db_now: null, outcome: 'not_configured', problems: ['The ops tick cannot reach its database: OPS_SUPABASE_URL is not set.'], counts: {},
    }, NOW - 30_000)
    const d = deps()
    expect(await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW, d)).toBe('alerted')
    expect(d.sent[0].title).toBe('The ops minute cron is not configured')
    expect(d.sent[0].errors).toEqual(['The ops tick cannot reach its database: OPS_SUPABASE_URL is not set.'])
    expect(d.sent[0].fixHint).toMatch(/OPS_SUPABASE_SECRET_KEY/)
  })

  it('pages a not configured report naming the private key with its remedy after it is kept and read back', async () => {
    const store = kv()
    await recordOpsTickCompleted(store as unknown as KVNamespace, {
      tick_id: 't', mode: 'observe', scheduled_time: null, started_at: '2026-10-17T10:02:00Z', finished_at: '2026-10-17T10:02:01Z',
      db_now: null, outcome: 'not_configured', problems: ['x'], counts: {}, not_configured_secrets: ['OPS_CONNECTIONS_PRIVATE_KEY'],
    }, NOW - 30_000)
    const d = deps()
    await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW, d)
    expect(d.sent[0].fixHint).toMatch(/Bidspoke recovery keys/)
  })

  it('names the NEXT key\'s own remedy, which includes deleting it when no rotation is under way', async () => {
    const store = kv()
    store.m.set(OPS_TICK_REPORT_KEY, stored({
      outcome: 'not_configured', problems: ['x'], not_configured_secrets: ['OPS_CONNECTIONS_PRIVATE_KEY_NEXT'],
    }))
    const d = deps()
    await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW, d)
    expect(d.sent[0].fixHint).toMatch(/wrangler secret delete OPS_CONNECTIONS_PRIVATE_KEY_NEXT --config wrangler\.ops\.toml/)
    expect(d.sent[0].fixHint).not.toMatch(/OPS_SUPABASE/)
  })

  it('names a secret it has no written remedy for, rather than offering another secret\'s steps', async () => {
    const store = kv()
    store.m.set(OPS_TICK_REPORT_KEY, stored({ outcome: 'not_configured', problems: ['x'], not_configured_secrets: ['OPS_SOMETHING_NEW'] }))
    const d = deps()
    await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW, d)
    expect(d.sent[0].fixHint).toMatch(/Set OPS_SOMETHING_NEW on bidspoke-worker-ops/)
    expect(d.sent[0].fixHint).not.toMatch(/OPS_SUPABASE|Bidspoke recovery keys/)
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

// #2410: one start stamp that ran past the gateway deadline paged at 15:02:29 UTC
// on 2026-10-18, two minutes after a deploy, and nothing failed after it. A lone
// missed stamp is held for one tick; the second in a row pages.
describe('a missed start stamp', () => {
  const STAMP = 'The ops tick could not stamp its start with the bidding Worker (the bidding Worker\'s heartbeat did not answer within 15 s).'
  const MIN = 60_000
  const report = (n: number, over: Record<string, unknown> = {}) => ({
    tick_id: `t${n}`, mode: 'observe', scheduled_time: null,
    started_at: new Date(NOW + n * MIN).toISOString(), finished_at: new Date(NOW + n * MIN + 1000).toISOString(),
    db_now: null, outcome: 'ok', problems: [], counts: {}, start_stamp_failed: false, ...over,
  })
  const missed = (n: number, over: Record<string, unknown> = {}) => report(n, { outcome: 'problems', problems: [STAMP], start_stamp_failed: true, ...over })

  function deps() {
    const sent: Array<{ errors: string[]; title: string; context?: string }> = []
    const recovered: string[] = []
    return {
      sent,
      recovered,
      notifyFailure: async (_s: unknown, _job: string, errors: string[], _k: unknown, remedy: { title: string; context?: string }) => {
        sent.push({ errors, title: remedy.title, context: remedy.context })
      },
      notifyRecovery: async (_k: unknown, job: string) => { recovered.push(job) },
    }
  }

  /** One tick: its report arrives, then the bidding Worker's minute check judges it. */
  async function tick(store: ReturnType<typeof kv>, d: ReturnType<typeof deps>, n: number, r: Record<string, unknown>) {
    await recordOpsTickCompleted(store as unknown as KVNamespace, r, NOW + n * MIN + 2000)
    return runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW + n * MIN + 30_000, d)
  }

  it('does not page on one missed stamp followed by a clean tick', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 0, report(0))).toBe('healthy')
    expect(await tick(store, d, 1, missed(1))).toBe('held')
    expect(await tick(store, d, 2, report(2))).toBe('healthy')
    expect(d.sent).toEqual([])
  })

  it('holds the same report however many times the check reads it, because it counts ticks, not checks', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, missed(1))).toBe('held')
    expect(await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW + MIN + 60_000, d)).toBe('held')
    expect(await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW + MIN + 90_000, d)).toBe('held')
    expect(d.sent).toEqual([])
  })

  it('pages on the second missed stamp in a row, saying it was two or more in a row', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, missed(1))).toBe('held')
    expect(await tick(store, d, 2, missed(2))).toBe('alerted')
    expect(d.sent).toEqual([{
      errors: [STAMP], title: 'The ops minute cron reported a problem',
      context: 'The start stamp failed on 2 or more ticks in a row.',
    }])
  })

  it('pages a sustained failure no more than one tick later than before #2410, and keeps paging it', async () => {
    const store = kv()
    const d = deps()
    const verdicts: string[] = []
    for (let n = 1; n <= 5; n++) verdicts.push(await tick(store, d, n, missed(n)))
    // Before #2410 the first was 'alerted'; the alerter's own reminder schedule
    // decides what reaches Slack after that, as it does for every job.
    expect(verdicts).toEqual(['held', 'alerted', 'alerted', 'alerted', 'alerted'])
    // The words do not change as the run lengthens, so the alerter reads it as one standing problem.
    expect(new Set(d.sent.map((s) => JSON.stringify(s))).size).toBe(1)
  })

  it('pages at once when the missed stamp is not the only problem', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, missed(1, { problems: [STAMP, 'The lease_expiry sweep failed: lock timeout.'] }))).toBe('alerted')
    expect(d.sent[0].errors).toEqual([STAMP, 'The lease_expiry sweep failed: lock timeout.'])
  })

  it('pages at once on a report from an ops release that does not say whether the stamp failed', async () => {
    const store = kv()
    const d = deps()
    const { start_stamp_failed: _omitted, ...older } = missed(1)
    expect(await tick(store, d, 1, older)).toBe('alerted')
  })

  it('does not count a missed stamp from a report too old to say anything about now as the one before', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 0, missed(0))).toBe('held')
    const later = Math.ceil(OPS_TICK_REPORT_FRESH_MS / MIN) + 1
    expect(await tick(store, d, later, missed(later))).toBe('held')
    expect(d.sent).toEqual([])
  })

  it('still keeps the report when the run before it cannot be read, and pages the miss rather than holding it', async () => {
    const store = kv()
    const d = deps()
    const failingRead = { ...store, get: async () => { throw new Error('KV GET failed: 503') } }
    await recordOpsTickCompleted(failingRead as unknown as KVNamespace, missed(1), NOW + MIN + 2000)
    expect(JSON.parse(store.m.get(OPS_TICK_REPORT_KEY)!).tick_id).toBe('t1')
    expect(await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW + MIN + 30_000, d)).toBe('alerted')
  })

  it('refuses a report that says the stamp failed but reports no problem, so it pages as unreadable', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, report(1, { start_stamp_failed: true }))).toBe('alerted')
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
    // storeRotatedEnvelope: the ConnectionTokenObject's write back (#2335), tested in ops-gateway-rotated-envelope.test.ts.
    expect(Object.getOwnPropertyNames(OpsGateway.prototype).sort()).toEqual(['constructor', 'opsTickCompleted', 'opsTickStarted', 'opsWorkflows', 'storeRotatedEnvelope'])
  })
})
