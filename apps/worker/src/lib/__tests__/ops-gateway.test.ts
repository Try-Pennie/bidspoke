/**
 * The bidding Worker's side of the ops minute cron (#1949): what it serves the
 * ops Worker (decision 4: the ops workflows' state, read from the one home of
 * every definition), the heartbeat it keeps for the tick, and the check that
 * pages on the tick's report. The watchdog is here, in the Worker the tick does
 * not depend on, so it keeps judging when the ops Worker is down (L71).
 */
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { completedKey, heartbeatKey } from '../cron-heartbeat'
import {
  OPS_TICK_JOB, OPS_TICK_REPORT_KEY, OPS_TICK_REPORT_FRESH_MS, OPS_TICK_STREAKS_KEY, OPS_TICK_STREAK_TTL_SECONDS, OPS_TICK_TICKS_IN_A_ROW_TO_PAGE,
  OPS_TICK_WRITE_BACKS_KEY, readOpsWorkflows, recordOpsTickCompleted, recordOpsTickStarted, runOpsTickReportCheck,
} from '../ops-gateway'

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

  // #2340 phase 10 item 4: only the tick that owns the connection check judges
  // the write backs, so its judgement is kept apart from the report, which the
  // next minute's tick overwrites.
  it('keeps the write backs a tick judged apart from its report, and a tick that judged none leaves them as they were', async () => {
    const store = kv()
    const base = {
      tick_id: 't-owner', mode: 'observe', scheduled_time: null, started_at: '2026-10-17T10:02:30Z', finished_at: '2026-10-17T10:02:31Z',
      db_now: '2026-10-17T10:02:30Z', outcome: 'ok', problems: [], counts: {},
    }
    const writeBacks = {
      complete: true,
      pending: [{ organization_id: ORG, connection_id: '00000000-0000-4000-8000-0000000c2341', service: 'google_user', since: '2026-10-17T09:20:00.000Z', attempts: 6 }],
    }
    await recordOpsTickCompleted(store as unknown as KVNamespace, { ...base, write_backs: writeBacks }, NOW)
    expect(JSON.parse(store.m.get(OPS_TICK_WRITE_BACKS_KEY)!)).toEqual({ tick_id: 't-owner', received_at: new Date(NOW).toISOString(), write_backs: writeBacks })
    await recordOpsTickCompleted(store as unknown as KVNamespace, { ...base, tick_id: 't-next' }, NOW + 60_000)
    await recordOpsTickCompleted(store as unknown as KVNamespace, { ...base, tick_id: 't-after', write_backs: null }, NOW + 120_000)
    expect(JSON.parse(store.m.get(OPS_TICK_WRITE_BACKS_KEY)!).tick_id).toBe('t-owner')
    // An unreadable report carries no judgement, so it leaves the kept one too.
    await recordOpsTickCompleted(store as unknown as KVNamespace, { ...base, write_backs: { complete: 'yes', pending: [] } }, NOW + 180_000)
    expect(JSON.parse(store.m.get(OPS_TICK_WRITE_BACKS_KEY)!).tick_id).toBe('t-owner')
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

// #2506 (Dan's decision, 2026-10-19). On 2026-10-18 and 2026-10-19 the page
// fired on one tick each (a start stamp past its deadline, then the run_expiry
// sweep's claim_ops_sweep past its 9000 ms deadline), and each recovered by
// itself. A problem a passing tick would clear now pages only once three ticks
// in a row report it; one tick's is logged and counted. #2410 held a lone
// missed start stamp for one tick; that rule is this one now.
describe('three ticks in a row (#2506)', () => {
  const MIN = 60_000
  const SWEEP = 'The run_expiry sweep failed: claim_ops_sweep passed its 9000 ms deadline and may still have committed.'
  const LEASES = 'The lease_expiry sweep failed: lock timeout.'
  const STAMP = 'The ops tick could not stamp its start with the bidding Worker (the bidding Worker\'s heartbeat did not answer within 15 s).'
  const MISSED = 'Workflow 00000000-0000-4000-8000-0000000019a1 missed its Oct 19, 2:35 PM ET slot (catch_up_none): the tick did not see it inside its five minute window.'
  const report = (n: number, over: Record<string, unknown> = {}) => ({
    tick_id: `t${n}`, mode: 'observe', scheduled_time: null,
    started_at: new Date(NOW + n * MIN).toISOString(), finished_at: new Date(NOW + n * MIN + 1000).toISOString(),
    db_now: null, outcome: 'ok', problems: [], problem_keys: [], counts: {}, start_stamp_failed: false, ...over,
  })
  const bad = (n: number, problems: Array<[string, string]>, over: Record<string, unknown> = {}) =>
    report(n, { outcome: 'problems', problems: problems.map(([, t]) => t), problem_keys: problems.map(([k]) => k), ...over })
  const sweep: [string, string] = ['sweep_failed:run_expiry', SWEEP]
  const leases: [string, string] = ['sweep_failed:lease_expiry', LEASES]

  function deps() {
    const sent: Array<{ errors: string[]; title: string; context?: string; options?: unknown }> = []
    const recovered: string[] = []
    return {
      sent,
      recovered,
      notifyFailure: async (_s: unknown, _job: string, errors: string[], _k: unknown, remedy: { title: string; context?: string }, _now: number, options?: unknown) => {
        sent.push({ errors, title: remedy.title, context: remedy.context, options })
      },
      notifyRecovery: async (_k: unknown, job: string) => { recovered.push(job) },
    }
  }

  /** One tick: its report arrives, then the bidding Worker's minute check judges it. Both clocks are set. */
  async function tick(store: ReturnType<typeof kv> | KvShape, d: ReturnType<typeof deps>, n: number, r: Record<string, unknown>) {
    await recordOpsTickCompleted(store as unknown as KVNamespace, r, NOW + n * MIN + 2000)
    return runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW + n * MIN + 30_000, d)
  }

  /** The named lines a tick logs about its problems, captured rather than printed. */
  function heldLines() {
    const lines: Array<Record<string, unknown>> = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      if (typeof line === 'string' && line.startsWith('{')) lines.push(JSON.parse(line) as Record<string, unknown>)
    })
    return { lines, restore: () => spy.mockRestore() }
  }

  it('does not page one bad tick, and logs it by name with its count', async () => {
    const store = kv()
    const d = deps()
    const log = heldLines()
    try {
      expect(await tick(store, d, 1, bad(1, [sweep]))).toBe('held')
    } finally {
      log.restore()
    }
    expect(d.sent).toEqual([])
    expect(log.lines).toContainEqual(expect.objectContaining({ event: 'ops_tick_problem_held', tick_id: 't1', key: 'sweep_failed:run_expiry', in_a_row: 1, pages_at: OPS_TICK_TICKS_IN_A_ROW_TO_PAGE }))
  })

  it('pages once on the third tick in a row, naming that it was three in a row, and has the alerter page it without a grace of its own', async () => {
    const store = kv()
    const d = deps()
    const verdicts = [await tick(store, d, 1, bad(1, [sweep])), await tick(store, d, 2, bad(2, [sweep])), await tick(store, d, 3, bad(3, [sweep]))]
    expect(verdicts).toEqual(['held', 'held', 'alerted'])
    expect(d.sent).toEqual([{
      errors: [SWEEP], title: 'The ops minute cron reported a problem',
      context: `Reported by ${OPS_TICK_TICKS_IN_A_ROW_TO_PAGE} or more ticks in a row.`,
      options: { repeatsHeldByCaller: true },
    }])
  })

  it('resets the count on a tick without the problem: bad, good, bad pages nothing', async () => {
    const store = kv()
    const d = deps()
    const verdicts = [
      await tick(store, d, 1, bad(1, [sweep])), await tick(store, d, 2, bad(2, [sweep])), await tick(store, d, 3, report(3)),
      await tick(store, d, 4, bad(4, [sweep])), await tick(store, d, 5, bad(5, [sweep])),
    ]
    expect(verdicts).toEqual(['held', 'held', 'healthy', 'held', 'held'])
    expect(d.sent).toEqual([])
  })

  it('resets the count on a tick that reports only another problem', async () => {
    const store = kv()
    const d = deps()
    const verdicts = [
      await tick(store, d, 1, bad(1, [sweep])), await tick(store, d, 2, bad(2, [sweep])), await tick(store, d, 3, bad(3, [leases])),
      await tick(store, d, 4, bad(4, [sweep])),
    ]
    expect(verdicts).toEqual(['held', 'held', 'held', 'held'])
    expect(d.sent).toEqual([])
  })

  it('counts each problem on its own, and pages only the one that reached three', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, bad(1, [sweep]))).toBe('held')
    expect(await tick(store, d, 2, bad(2, [sweep, leases]))).toBe('held')
    expect(await tick(store, d, 3, bad(3, [sweep, leases]))).toBe('alerted')
    expect(d.sent.at(-1)?.errors).toEqual([SWEEP])
    expect(await tick(store, d, 4, bad(4, [sweep, leases]))).toBe('alerted')
    expect(d.sent.at(-1)?.errors).toEqual([SWEEP, LEASES])
  })

  // The sentence names the error's own words and figures, which move between
  // ticks; the key names the sweep and the kind, which do not.
  it('reads a problem by its key, so the same sweep failing in different words is one problem', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, bad(1, [['sweep_failed:run_expiry', 'The run_expiry sweep failed: claim_ops_sweep passed its 9000 ms deadline and may still have committed.']]))
    await tick(store, d, 2, bad(2, [['sweep_failed:run_expiry', 'The run_expiry sweep failed: expire_ops_runs failed (57014): canceling statement due to statement timeout.']]))
    expect(await tick(store, d, 3, bad(3, [['sweep_failed:run_expiry', 'The run_expiry sweep failed: error code: 522.']]))).toBe('alerted')
  })

  it('pages a sustained problem on every tick from the third, in the same words, so the alerter reads one standing problem', async () => {
    const store = kv()
    const d = deps()
    const verdicts: string[] = []
    for (let n = 1; n <= 6; n++) verdicts.push(await tick(store, d, n, bad(n, [sweep])))
    expect(verdicts).toEqual(['held', 'held', 'alerted', 'alerted', 'alerted', 'alerted'])
    // The context is a fixed sentence, never the running count (#1768).
    expect(new Set(d.sent.map((s) => JSON.stringify(s))).size).toBe(1)
  })

  it('holds the same report however many times the check reads it, because it counts ticks, not checks', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, bad(1, [sweep]))).toBe('held')
    for (const at of [60_000, 90_000, 120_000, 150_000]) {
      expect(await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW + MIN + at, d)).toBe('held')
    }
    expect(d.sent).toEqual([])
  })

  it('counts a report delivered twice once, by its tick id', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, bad(1, [sweep]))
    await tick(store, d, 2, bad(2, [sweep]))
    expect(await tick(store, d, 2, bad(2, [sweep]))).toBe('held')
    expect(d.sent).toEqual([])
  })

  it.each([
    ['a missed slot, which no later tick reports again', ['slot_missed:00000000-0000-4000-8000-0000000019a1', MISSED]],
    ['a disagreement between the run queue and the runs, which is a defect', ['queue_disagreement', 'The agreement check found 2 runs where the run queue and the runs disagree.']],
    ['a served workflow in a shape not read, which is a defect', ['workflow_refused', 'The bidding Worker served workflow row 1 in a shape the ops Worker does not read, so it was not saved.']],
    ['a kind this Worker has no rule for', ['a_kind_from_a_newer_release', 'Something new went wrong.']],
  ] as Array<[string, [string, string]]>)('pages at once on %s', async (_label, problem) => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, bad(1, [problem]))).toBe('alerted')
    expect(d.sent[0].errors).toEqual([problem[1]])
    // Not a problem held for three ticks, so no context says so.
    expect(d.sent[0].context).toBeUndefined()
  })

  it('pages at once on not configured, which is not transient', async () => {
    const store = kv()
    const d = deps()
    const r = bad(1, [['not_configured:OPS_CONNECTIONS_PRIVATE_KEY', 'OPS_CONNECTIONS_PRIVATE_KEY is not set on bidspoke-worker-ops, so no ops connection can be opened.']], {
      outcome: 'not_configured', not_configured_secrets: ['OPS_CONNECTIONS_PRIVATE_KEY'],
    })
    expect(await tick(store, d, 1, r)).toBe('alerted')
    expect(d.sent[0].title).toBe('The ops minute cron is not configured')
  })

  it('pages the at once problem of a tick at once, and holds the transient one beside it', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, bad(1, [sweep, ['slot_missed:00000000-0000-4000-8000-0000000019a1', MISSED]]))).toBe('alerted')
    expect(d.sent[0].errors).toEqual([MISSED])
  })

  it('pages an unreadable report at once', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, report(1, { start_stamp_failed: true }))).toBe('alerted')
    expect(d.sent[0].errors[0]).toMatch(/could not be read/)
  })

  describe('the all clear', () => {
    it('stands the page down on the first clean tick after it', async () => {
      const store = kv()
      const d = deps()
      for (let n = 1; n <= 3; n++) await tick(store, d, n, bad(n, [sweep]))
      expect(await tick(store, d, 4, report(4))).toBe('healthy')
      expect(d.recovered).toEqual([OPS_TICK_JOB])
    })

    // A held tick is not a clean one: the incident stays open, so the page and
    // its all clear still pair, and an all clear never says a tick with a
    // problem in it was healthy.
    it('keeps the incident open through a held tick', async () => {
      const store = kv()
      const d = deps()
      for (let n = 1; n <= 3; n++) await tick(store, d, n, bad(n, [sweep]))
      expect(await tick(store, d, 4, bad(4, [leases]))).toBe('held')
      expect(d.recovered).toEqual([])
    })
  })

  describe('the count in KV', () => {
    it('is kept with an expiry, renewed on every tick that keeps a problem standing', async () => {
      const store = kv()
      const ttls: Array<number | undefined> = []
      const watched = { ...store, put: async (k: string, v: string, o?: { expirationTtl?: number }) => { if (k === OPS_TICK_STREAKS_KEY) ttls.push(o?.expirationTtl); return store.put(k, v) } }
      const d = deps()
      for (let n = 1; n <= 3; n++) await tick(watched, d, n, bad(n, [sweep]))
      expect(ttls).toEqual([OPS_TICK_STREAK_TTL_SECONDS, OPS_TICK_STREAK_TTL_SECONDS, OPS_TICK_STREAK_TTL_SECONDS])
      // An expiry no longer than the window a report says anything about now in.
      expect(OPS_TICK_STREAK_TTL_SECONDS * 1000).toBeLessThanOrEqual(OPS_TICK_REPORT_FRESH_MS)
    })

    it('is removed by a clean tick', async () => {
      const store = kv()
      const d = deps()
      await tick(store, d, 1, bad(1, [sweep]))
      expect(store.m.has(OPS_TICK_STREAKS_KEY)).toBe(true)
      await tick(store, d, 2, report(2))
      expect(store.m.has(OPS_TICK_STREAKS_KEY)).toBe(false)
    })

    // KV's own expiry is lazy, so the age is judged on the injected clock too:
    // a count left from ticks long ago cannot make a new problem page early.
    it('starts afresh after a gap longer than the window, even if KV has not yet expired the count', async () => {
      const store = kv()
      const d = deps()
      await tick(store, d, 0, bad(0, [sweep]))
      await tick(store, d, 1, bad(1, [sweep]))
      const later = Math.ceil(OPS_TICK_REPORT_FRESH_MS / MIN) + 2
      expect(await tick(store, d, later, bad(later, [sweep]))).toBe('held')
      expect(d.sent).toEqual([])
    })

    // Fail toward paging (L71, L50): without the count, a held problem could
    // be held for ever, so the tick whose count cannot be read or carried pages.
    it('pages when the count cannot be read, and still stamps the tick completed and keeps its report', async () => {
      const store = kv()
      const d = deps()
      const failingRead = { ...store, get: async (k: string) => { if (k === OPS_TICK_STREAKS_KEY) throw new Error('KV GET failed: 503'); return store.get(k) } }
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(await tick(failingRead, d, 1, bad(1, [sweep]))).toBe('alerted')
        expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/ops_tick_count_unknown/)
      } finally {
        errors.mockRestore()
      }
      expect(store.m.get(completedKey(OPS_TICK_JOB))).toBe(new Date(NOW + MIN + 2000).toISOString())
      expect(JSON.parse(store.m.get(OPS_TICK_REPORT_KEY)!).tick_id).toBe('t1')
    })

    it('pages when the count cannot be written, since the next tick could not carry it on', async () => {
      const store = kv()
      const d = deps()
      const failingWrite = { ...store, put: async (k: string, v: string) => { if (k === OPS_TICK_STREAKS_KEY) throw new Error('KV PUT failed: 503'); return store.put(k, v) } }
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(await tick(failingWrite, d, 1, bad(1, [sweep]))).toBe('alerted')
        expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/ops_tick_count_unknown/)
      } finally {
        errors.mockRestore()
      }
    })

    it('pages when the count it reads back is unreadable', async () => {
      const store = kv()
      const d = deps()
      store.m.set(OPS_TICK_STREAKS_KEY, 'not json')
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(await tick(store, d, 1, bad(1, [sweep]))).toBe('alerted')
      } finally {
        errors.mockRestore()
      }
    })

    it('pages a kept report from before #2506, which carries no counts, rather than holding it', async () => {
      const store = kv()
      const d = deps()
      store.m.set(OPS_TICK_REPORT_KEY, JSON.stringify({ ...bad(1, [sweep]), received_at: new Date(NOW).toISOString(), start_stamp_misses: 1 }))
      expect(await runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW + 30_000, d)).toBe('alerted')
    })
  })

  // An ops release before #2506 sends no keys. It can still say its start stamp
  // failed (#2410), so a lone stamp is held like any transient problem; any
  // other sentence it sends cannot be told from a defect, so it pages at once.
  describe('a report from an ops release before #2506', () => {
    const older = (n: number, problems: string[], stamp: boolean) => {
      const { problem_keys: _none, ...r } = report(n, { outcome: 'problems', problems, start_stamp_failed: stamp })
      return r
    }

    it('holds a lone missed start stamp until three in a row', async () => {
      const store = kv()
      const d = deps()
      const verdicts = [await tick(store, d, 1, older(1, [STAMP], true)), await tick(store, d, 2, older(2, [STAMP], true)), await tick(store, d, 3, older(3, [STAMP], true))]
      expect(verdicts).toEqual(['held', 'held', 'alerted'])
    })

    it('pages any other problem at once', async () => {
      const store = kv()
      const d = deps()
      expect(await tick(store, d, 1, older(1, [SWEEP], false))).toBe('alerted')
      expect(await tick(kv(), deps(), 1, older(1, [STAMP, SWEEP], true))).toBe('alerted')
    })
  })
})

type KvShape = { get: (k: string) => Promise<string | null>; put: (k: string, v: string, o?: { expirationTtl?: number }) => Promise<void>; delete: (k: string) => Promise<void> }

describe('the OpsGateway entrypoint', () => {
  it('stamps through the methods the ops Worker calls, and has no others', async () => {
    const { OpsGateway } = await import('../ops-gateway-entrypoint')
    const store = kv()
    const gw = new OpsGateway({} as ExecutionContext, { IDEMPOTENCY: store } as never)
    expect(await gw.opsTickStarted()).toEqual({ stamped: 'started' })
    expect(store.m.has(heartbeatKey(OPS_TICK_JOB))).toBe(true)
    // storeRotatedEnvelope: the ConnectionTokenObject's write back (#2335), tested in ops-gateway-rotated-envelope.test.ts.
    // opsConnections and moneyIdentities: the serve (#2335), tested in ops-gateway-connections.test.ts and money-identity.test.ts.
    // replaceConnectionEnvelope: the reseal's write back (#2333), tested in ops-gateway-replace-envelope.test.ts.
    // opsJobStarted and opsJobCompleted: the ops jobs' stamps (#2340), tested in ops-gateway-jobs.test.ts and below.
    expect(Object.getOwnPropertyNames(OpsGateway.prototype).sort()).toEqual([
      'constructor', 'moneyIdentities', 'opsConnections', 'opsJobCompleted', 'opsJobStarted', 'opsTickCompleted', 'opsTickStarted', 'opsWorkflows',
      'replaceConnectionEnvelope', 'storeRotatedEnvelope',
    ])
  })

  it('stamps an ops job through opsJobStarted and opsJobCompleted, and refuses an id it does not watch by name (#2340)', async () => {
    const { OpsGateway } = await import('../ops-gateway-entrypoint')
    const store = kv()
    const gw = new OpsGateway({} as ExecutionContext, { IDEMPOTENCY: store } as never)
    expect(await gw.opsJobStarted('ops-sf-limits')).toEqual({ stamped: 'started', job: 'ops-sf-limits' })
    expect(store.m.has(heartbeatKey('ops-sf-limits'))).toBe(true)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const report = { started_at: '2026-10-19T18:00:01Z', finished_at: '2026-10-19T18:00:02Z', counts: { sf_limits_orgs: 0 } }
      expect(await gw.opsJobCompleted('ops-sf-limits', report)).toEqual({ stamped: 'completed', job: 'ops-sf-limits' })
    } finally {
      log.mockRestore()
    }
    expect(store.m.has(completedKey('ops-sf-limits'))).toBe(true)
    // The connection_check sweep's (#2340), under its own id.
    expect(await gw.opsJobStarted('ops-connection-check')).toEqual({ stamped: 'started', job: 'ops-connection-check' })
    expect(store.m.has(heartbeatKey('ops-connection-check'))).toBe(true)
    await expect(gw.opsJobStarted(OPS_TICK_JOB)).rejects.toThrow(/not an ops job this Worker stamps/)
    await expect(gw.opsJobCompleted('ops-owner-check', {})).rejects.toThrow(/not an ops job this Worker stamps/)
    expect(store.m.has(heartbeatKey(OPS_TICK_JOB))).toBe(false)
  })

  it('answers moneyIdentities for the organization asked about, and refuses a call naming none (#2335)', async () => {
    const { OpsGateway } = await import('../ops-gateway-entrypoint')
    const gw = new OpsGateway({} as ExecutionContext, { IDEMPOTENCY: kv() } as never)
    await expect(gw.moneyIdentities(ORG)).resolves.toMatchObject({ organization_id: ORG, salesforce: null })
    await expect(gw.moneyIdentities(undefined)).rejects.toThrow(/no organization uuid/)
  })
})
