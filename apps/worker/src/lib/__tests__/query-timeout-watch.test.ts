import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  CRITICAL_MAX_SHARE,
  WARN_MEAN_SHARE,
  QUERY_TIMEOUT_WARN_COOLDOWN_KEY,
  queryTimeoutMaxSeenKey,
  judgeStatement,
  judgeStatements,
  runQueryTimeoutWatch,
  runQueryCancellationWatch,
  type CancellationReport,
  type QueryCancellationWatchDeps,
  type SlowStatement,
  type StatementVerdict,
  type QueryTimeoutWatchDeps,
} from '../query-timeout-watch'
import { readCancellations, withCancellationRecord, type CancellationStore } from '../query-cancellations'

/**
 * Warn when a query approaches the statement timeout, instead of failing at it (#1043).
 *
 * Postgres cancels a statement at its role's `statement_timeout` (service_role 30s,
 * authenticated/authenticator 8s) with a 57014 and no signal before that. The archive's
 * steps count ran 7.1s warm for weeks, then one run took 30.2s and was cancelled (#1040):
 * nothing between "fine" and "outage". `pg_stat_statements` already records each statement's
 * mean and max execution time per role, so this reads them and reports the slowest paths as a
 * fraction of their ceiling, giving weeks of notice as a query's cost climbs with volume.
 */
const SERVICE = 30_000
const BROWSER = 8_000

const stmt = (over: Partial<SlowStatement> = {}): SlowStatement => ({
  role: 'service_role',
  queryid: 1,
  calls: 100,
  meanMs: 1_000,
  maxMs: 5_000,
  timeoutMs: SERVICE,
  ...over,
})

describe('judgeStatement: a statement near its role ceiling', () => {
  it('is critical when the slowest single run crosses the max share of the ceiling', () => {
    // 29.0s of a 30s ceiling: one unlucky run from a 57014. This is the live #1040 shape.
    const v = judgeStatement(stmt({ maxMs: 29_000, meanMs: 1_600 }))
    expect(v.severity).toBe('critical')
    expect(v.maxPct).toBeCloseTo(29_000 / SERVICE, 5)
    expect(v.meanPct).toBeCloseTo(1_600 / SERVICE, 5)
  })

  it('is a warning when the TYPICAL run is past the mean share, even with the max well under the cliff', () => {
    // 16s mean of a 30s ceiling: systematically more than halfway there, which climbs with
    // volume. Max 20s is under the 90% critical line, so this is the early, trend signal.
    const v = judgeStatement(stmt({ meanMs: 16_000, maxMs: 20_000 }))
    expect(v.severity).toBe('warn')
  })

  it('is ok when both the typical and the slowest run sit well under the ceiling', () => {
    expect(judgeStatement(stmt({ meanMs: 5_000, maxMs: 10_000 })).severity).toBe('ok')
  })

  it('judges each role against ITS OWN ceiling, not a single 30s', () => {
    // 7.5s on the 8s browser ceiling is a near-cliff; the same 7.5s on service_role is not.
    expect(judgeStatement(stmt({ role: 'authenticated', timeoutMs: BROWSER, maxMs: 7_500, meanMs: 1_000 })).severity).toBe('critical')
    expect(judgeStatement(stmt({ timeoutMs: SERVICE, maxMs: 7_500, meanMs: 1_000 })).severity).toBe('ok')
  })

  it('reads a non-positive ceiling as unmeasurable (ok, zero share), never a divide-by-zero', () => {
    const v = judgeStatement(stmt({ timeoutMs: 0, maxMs: 9_999 }))
    expect(v.severity).toBe('ok')
    expect(v.maxPct).toBe(0)
    expect(v.meanPct).toBe(0)
  })

  it('exposes the two shares the thresholds are set in', () => {
    expect(CRITICAL_MAX_SHARE).toBeGreaterThan(WARN_MEAN_SHARE)
    expect(CRITICAL_MAX_SHARE).toBeLessThanOrEqual(1)
  })
})

describe('judgeStatements: ordering', () => {
  it('returns the most severe, and within a severity the closest to its ceiling, first', () => {
    const rows: SlowStatement[] = [
      stmt({ queryid: 1, meanMs: 1_000, maxMs: 10_000 }), // ok
      stmt({ queryid: 2, meanMs: 16_000, maxMs: 20_000 }), // warn (66% max)
      stmt({ queryid: 3, meanMs: 2_000, maxMs: 29_500 }), // critical (98%)
      stmt({ queryid: 4, meanMs: 1_000, maxMs: 28_000 }), // critical (93%)
    ]
    const order = judgeStatements(rows).map((v) => v.queryid)
    expect(order).toEqual([3, 4, 2, 1])
  })
})

// A minimal in-memory KV with just the get/put this check uses.
function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    store,
  }
}

const criticalRow = stmt({ queryid: 9, meanMs: 2_000, maxMs: 29_000 })
const warnRow = stmt({ queryid: 5, meanMs: 16_000, maxMs: 20_000 })

function deps(over: Partial<QueryTimeoutWatchDeps> = {}): QueryTimeoutWatchDeps & { lines: string[]; send: Mock } {
  const lines: string[] = []
  const send: Mock = (over.send as Mock) ?? vi.fn(async (_v: StatementVerdict[], _n: number) => true)
  return {
    read: async () => [criticalRow],
    kv: fakeKv(),
    now: () => Date.parse('2026-10-13T12:00:00Z'),
    log: (l: string) => void lines.push(l),
    ...over,
    send,
    lines,
  }
}

describe('runQueryTimeoutWatch', () => {
  it('logs every statement it read, so the thresholds can be calibrated against real data (L172)', async () => {
    const d = deps({ read: async () => [criticalRow, stmt({ queryid: 1, meanMs: 1_000, maxMs: 10_000 })] })
    await runQueryTimeoutWatch(d)
    const logged = d.lines.filter((l) => l.includes('event=query_timeout_watch'))
    expect(logged).toHaveLength(2)
    expect(logged.some((l) => l.includes('queryid=9') && l.includes('severity=critical'))).toBe(true)
    expect(logged.some((l) => l.includes('queryid=1') && l.includes('severity=ok'))).toBe(true)
  })

  it('alerts on a critical and records the max it paged, using no shared cooldown', async () => {
    const d = deps() // criticalRow, maxMs 29000
    const r = await runQueryTimeoutWatch(d)
    expect(r.alerted).toBe(true)
    expect(d.send).toHaveBeenCalledOnce()
    expect(d.send.mock.calls[0][0][0].queryid).toBe(9)
    expect(await d.kv.get(queryTimeoutMaxSeenKey('service_role', 9))).toBe('29000')
    // Criticals are rate-limited per statement by maxseen, never by the warn cooldown.
    expect(await d.kv.get(QUERY_TIMEOUT_WARN_COOLDOWN_KEY)).toBeNull()
  })

  it('does NOT re-page a critical whose slowest run is no higher than the one already paged (a resolved spike, L36/L182)', async () => {
    // The cumulative max never falls, so without this a fixed one-off spike pages every
    // cooldown for ever. maxseen equal to the current max means nothing new happened.
    const d = deps({ kv: fakeKv({ [queryTimeoutMaxSeenKey('service_role', 9)]: '29000' }) })
    const r = await runQueryTimeoutWatch(d)
    expect(r.alerted).toBe(false)
    expect(d.send).not.toHaveBeenCalled()
  })

  it('re-pages a critical that has reached a NEW slowest run above the one already paged', async () => {
    const d = deps({ kv: fakeKv({ [queryTimeoutMaxSeenKey('service_role', 9)]: '28000' }) })
    const r = await runQueryTimeoutWatch(d)
    expect(r.alerted).toBe(true)
    expect(await d.kv.get(queryTimeoutMaxSeenKey('service_role', 9))).toBe('29000')
  })

  it('does NOT re-page a fractional max that round-trips unchanged (the stored value is not rounded)', async () => {
    // A float max stored rounded would read as below itself next run and re-page for ever.
    const frac = stmt({ queryid: 9, meanMs: 2_000, maxMs: 29_122.7 })
    const first = deps({ read: async () => [frac] })
    expect((await runQueryTimeoutWatch(first)).alerted).toBe(true)
    const stored = await first.kv.get(queryTimeoutMaxSeenKey('service_role', 9))
    const second = deps({ read: async () => [frac], kv: fakeKv({ [queryTimeoutMaxSeenKey('service_role', 9)]: stored! }) })
    const r = await runQueryTimeoutWatch(second)
    expect(r.alerted).toBe(false)
    expect(second.send).not.toHaveBeenCalled()
  })

  it('re-pages after a stats reset, when the current max is BELOW the stale stored high (L174)', async () => {
    // pg_stat_statements_reset() or a DB restart restarts max_exec_time from 0, so a stored
    // high from before the reset must not silence a real near-cliff for its 30 day life.
    const d = deps({ kv: fakeKv({ [queryTimeoutMaxSeenKey('service_role', 9)]: '35000' }) }) // current 29000 < 35000
    const r = await runQueryTimeoutWatch(d)
    expect(r.alerted).toBe(true)
    expect(await d.kv.get(queryTimeoutMaxSeenKey('service_role', 9))).toBe('29000')
  })

  it('keys the paged high on role AND queryid, so the same statement under two roles does not cross-suppress', async () => {
    // pg_stat_statements' queryid hashes the text, not the role, so the same SQL run by
    // service_role (30s) and by the browser (8s) shares queryid 9 but is two rows. Both are
    // criticals against their own ceiling; both must page and record separate highs.
    const browser = stmt({ role: 'authenticated', queryid: 9, timeoutMs: BROWSER, meanMs: 1_000, maxMs: 7_600 })
    const d = deps({ read: async () => [criticalRow, browser] })
    const r = await runQueryTimeoutWatch(d)
    expect(r.alerted).toBe(true)
    expect(d.send.mock.calls[0][0]).toHaveLength(2)
    expect(await d.kv.get(queryTimeoutMaxSeenKey('service_role', 9))).toBe('29000')
    expect(await d.kv.get(queryTimeoutMaxSeenKey('authenticated', 9))).toBe('7600')
  })

  it('stays silent, and does not send, when every statement is under its band', async () => {
    const d = deps({ read: async () => [stmt({ meanMs: 1_000, maxMs: 10_000 })] })
    const r = await runQueryTimeoutWatch(d)
    expect(r.alerted).toBe(false)
    expect(d.send).not.toHaveBeenCalled()
  })

  it('rate-limits a warn with the warn cooldown: suppressed while it is set', async () => {
    const d = deps({ read: async () => [warnRow], kv: fakeKv({ [QUERY_TIMEOUT_WARN_COOLDOWN_KEY]: '1' }) })
    const r = await runQueryTimeoutWatch(d)
    expect(r.alerted).toBe(false)
    expect(d.send).not.toHaveBeenCalled()
  })

  it('arms the warn cooldown after a delivered warn alert', async () => {
    const d = deps({ read: async () => [warnRow] })
    const r = await runQueryTimeoutWatch(d)
    expect(r.alerted).toBe(true)
    expect(await d.kv.get(QUERY_TIMEOUT_WARN_COOLDOWN_KEY)).not.toBeNull()
  })

  it('still pages a CRITICAL while a WARN cooldown is set, so a new near-cliff is never silenced by a warn window', async () => {
    const d = deps({ kv: fakeKv({ [QUERY_TIMEOUT_WARN_COOLDOWN_KEY]: '1' }) }) // criticalRow
    const r = await runQueryTimeoutWatch(d)
    expect(r.alerted).toBe(true)
    expect(d.send).toHaveBeenCalledOnce()
    expect(await d.kv.get(queryTimeoutMaxSeenKey('service_role', 9))).toBe('29000')
  })

  it('does NOT record the paged max when delivery failed, so the next run retries (L36/L12)', async () => {
    const d = deps({ send: vi.fn(async () => false) })
    const r = await runQueryTimeoutWatch(d)
    expect(r.alerted).toBe(false)
    expect(await d.kv.get(queryTimeoutMaxSeenKey('service_role', 9))).toBeNull()
  })

  it('throws on a read failure, so an outage of the check is never a clean bill of health (L98)', async () => {
    const d = deps({ read: async () => { throw new Error('rpc down') } })
    await expect(runQueryTimeoutWatch(d)).rejects.toThrow('rpc down')
  })
})

/**
 * The cancellations themselves (#2651, L800). pg_stat_statements records a statement only
 * when it finishes, so one cancelled at its ceiling never counts above; the Worker records
 * each cancellation it is answered with (query-cancellations.ts), and this half of the watch
 * pages on any it has not already paged for, naming the statement.
 */
describe('runQueryCancellationWatch', () => {
  const at = (iso: string) => Date.parse(iso)
  const HEAD_COUNT = 'HEAD workflow_executions?select=id&workflow_id=eq.?'

  function cdeps(over: Partial<QueryCancellationWatchDeps> = {}): QueryCancellationWatchDeps & { lines: string[]; send: Mock; kv: ReturnType<typeof fakeKv> } {
    const lines: string[] = []
    const send: Mock = (over.send as Mock) ?? vi.fn(async (_r: CancellationReport, _n: number) => true)
    const kv = (over.kv as ReturnType<typeof fakeKv>) ?? fakeKv()
    return {
      read: async () => ({ events: [{ statement: HEAD_COUNT, atMs: at('2026-10-22T04:01:04Z') }], truncated: false }),
      now: () => at('2026-10-22T05:00:00Z'),
      log: (l: string) => void lines.push(l),
      ...over,
      kv,
      send,
      lines,
    }
  }

  it('pages on a cancellation, naming the statement, how many times and when it was last cancelled', async () => {
    const d = cdeps()
    const r = await runQueryCancellationWatch(d)
    expect(r.alerted).toBe(true)
    const report: CancellationReport = d.send.mock.calls[0][0]
    expect(report.unread).toBeNull()
    expect(report.groups).toEqual([{ statement: HEAD_COUNT, count: 1, lastAtMs: at('2026-10-22T04:01:04Z') }])
  })

  it('does not page again for cancellations it has already paged for, and pages for a newer one', async () => {
    const d = cdeps()
    await runQueryCancellationWatch(d)
    const again = cdeps({ kv: d.kv })
    expect((await runQueryCancellationWatch(again)).alerted).toBe(false)
    expect(again.send).not.toHaveBeenCalled()

    const later = cdeps({
      kv: d.kv,
      read: async () => ({
        events: [
          { statement: HEAD_COUNT, atMs: at('2026-10-22T04:01:04Z') },
          { statement: HEAD_COUNT, atMs: at('2026-10-22T09:01:47Z') },
        ],
        truncated: false,
      }),
    })
    expect((await runQueryCancellationWatch(later)).alerted).toBe(true)
    // Only the cancellation since the last page is counted.
    expect(later.send.mock.calls[0][0].groups).toEqual([{ statement: HEAD_COUNT, count: 1, lastAtMs: at('2026-10-22T09:01:47Z') }])
  })

  it('does not record that it paged when the page was not delivered, so the next run tries again (L12)', async () => {
    const d = cdeps({ send: vi.fn(async () => false) })
    expect((await runQueryCancellationWatch(d)).alerted).toBe(false)
    const next = cdeps({ kv: d.kv })
    expect((await runQueryCancellationWatch(next)).alerted).toBe(true)
  })

  it('pages when it cannot read what it last paged for, rather than staying silent (L168)', async () => {
    const kv = fakeKv()
    kv.get = async () => {
      throw new Error('kv down')
    }
    const d = cdeps({ kv })
    expect((await runQueryCancellationWatch(d)).alerted).toBe(true)
  })

  it('stays silent with no cancellations recorded, and logs that it looked', async () => {
    const d = cdeps({ read: async () => ({ events: [], truncated: false }) })
    const r = await runQueryCancellationWatch(d)
    expect(r.alerted).toBe(false)
    expect(d.send).not.toHaveBeenCalled()
    expect(d.lines.some((l) => l.includes('event=query_cancellations') && l.includes('recorded=0'))).toBe(true)
  })

  it('SAYS it could not read the record, never reads it as no cancellations (L98)', async () => {
    const d = cdeps({
      read: async () => {
        throw new Error('list failed')
      },
    })
    const r = await runQueryCancellationWatch(d)
    expect(r.unread).toBe(true)
    expect(r.alerted).toBe(true)
    const report: CancellationReport = d.send.mock.calls[0][0]
    expect(report.groups).toEqual([])
    expect(report.unread).toContain('list failed')
    expect(d.lines.some((l) => l.includes('event=query_cancellations_unread') && l.includes('list failed'))).toBe(true)
  })

  it('says an unreadable record at most once in six hours, but always logs it', async () => {
    const failing = async () => {
      throw new Error('list failed')
    }
    const d = cdeps({ read: failing })
    await runQueryCancellationWatch(d)
    const again = cdeps({ read: failing, kv: d.kv })
    expect((await runQueryCancellationWatch(again)).alerted).toBe(false)
    expect(again.lines.some((l) => l.includes('event=query_cancellations_unread'))).toBe(true)
  })

  it('carries a truncated listing through, so the count is shown as a floor', async () => {
    const d = cdeps({ read: async () => ({ events: [{ statement: HEAD_COUNT, atMs: at('2026-10-22T04:01:04Z') }], truncated: true }) })
    await runQueryCancellationWatch(d)
    expect(d.send.mock.calls[0][0].truncated).toBe(true)
  })

  it('would have paged for the 2026-10-22 LendSwift cancellations at 05:00 and 10:00 UTC, and not between', async () => {
    // The twelve cancellations in that day's edge and Postgres logs: six counts at 04:00 and
    // six at 09:00, each run of the rejection watch. Recorded through the real Supabase fetch
    // wrapper, read through the real lister, judged by the real watch.
    const records = new Map<string, { metadata: unknown }>()
    const store: CancellationStore = {
      put: async (key, _v, opts) => void records.set(key, { metadata: opts?.metadata }),
      list: async ({ prefix }) => ({
        keys: [...records.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, r]) => ({ name, metadata: r.metadata })),
        list_complete: true,
      }),
    }
    const base =
      'https://xvrmivmpfykwwtriqwpg.supabase.co/rest/v1/workflow_executions?select=id&workflow_id=eq.e1b810da-16c0-49eb-bf12-ba1c9b67c914&is_test=eq.false&status=neq.running&started_at=gte.2026-10-15T01%3A58%3A30.891Z&started_at=lt.2026-10-22T01%3A58%3A30.891Z'
    const ns = base + '&final_node_namespace=eq.validate_bidding_and_state'
    const reason = (r: string) => ns + `&status=neq.failed&response_body-%3E%3Ereason=eq.${r}`
    const run = [base, ns, reason('bidding+not+active'), reason('ineligible+state'), reason('loan+amount+exceeds+maximum'), reason('invalid+name')]
    let clock = 0
    const fetchFn = withCancellationRecord(
      async () => new Response(null, { status: 500, headers: { 'proxy-status': 'PostgREST; error=57014' } }),
      { store, now: () => clock, log: () => {} },
    )
    clock = at('2026-10-22T04:01:04Z')
    for (const u of run) await fetchFn(u, { method: 'HEAD' })

    const kv = fakeKv()
    const watch = (iso: string) => cdeps({ kv, read: () => readCancellations(store), now: () => at(iso) })

    const five = watch('2026-10-22T05:00:00Z')
    expect((await runQueryCancellationWatch(five)).alerted).toBe(true)
    const groups: CancellationReport['groups'] = five.send.mock.calls[0][0].groups
    expect(groups.map((g) => g.count)).toEqual([4, 1, 1])
    expect(groups[0].statement).toContain('response_body->>reason=eq.?')

    const six = watch('2026-10-22T06:00:00Z')
    expect((await runQueryCancellationWatch(six)).alerted).toBe(false)

    clock = at('2026-10-22T09:01:47Z')
    for (const u of run) await fetchFn(u, { method: 'HEAD' })
    const ten = watch('2026-10-22T10:00:00Z')
    expect((await runQueryCancellationWatch(ten)).alerted).toBe(true)
    expect(ten.send.mock.calls[0][0].groups.map((g: { count: number }) => g.count)).toEqual([4, 1, 1])
  })
})
