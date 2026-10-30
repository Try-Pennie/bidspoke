/**
 * The bidding Worker pages the variables problems the ops tick reports: the
 * four of #3000 (phase 4 of #2982), cases (a) to (d), and the two pages for
 * runs whose variables bidding refused (#3131), cases (e), at once with a fix
 * per reason, and (f), off the ops lane, once a refused run comes 3 minutes
 * or more after the workflow's first with no successful run between. Each is on a page of its own as Ops runs can't start
 * is (#3039): due by its kind's rule, under its own title and fix, never on
 * the minute cron's shared page, and stood down only by a report that judged
 * its kind and no longer names it.
 */
import { describe, expect, it, vi } from 'vitest'
import { OFF_LANE_FIRST_REFUSED_PREFIX, OPS_TICK_JOB, opsOwnPagePrefix, recordOpsTickCompleted, runOpsTickReportCheck } from '../ops-gateway'
import {
  MISSING_VARIABLE_PAGE, OFF_LANE_FIRST_REFUSED_TTL_SECONDS, REFUSED_OFF_LANE_PAGE, REFUSED_VARIABLES_PAGE, refusedVariablesFix, refusedVariablesText, RUN_VARIABLES_UNREADABLE_PAGE, RUNS_ON_VARIABLE_COPY_PAGE, VARIABLE_COPY_REFRESH_PAGE, missingVariableText,
  refreshFailingText, runVariablesUnreadableText, runsOnVariableCopyText,
} from '../ops-gateway-contract'

const WF = '00000000-0000-4000-8000-0000000019a1'
const OTHER = '00000000-0000-4000-8000-0000000019b2'
const NOW = Date.parse('2026-10-17T10:02:31.000Z')
const MIN = 60_000

const MISSING = missingVariableText({ runs: 2, names: ['LIST_ID'] })
const ON_COPY = runsOnVariableCopyText({ runs: 2, ageSeconds: 14 * 60 })
const REFRESH = refreshFailingText({ workflows: 12, error: 'the bidding Worker\'s run variables did not answer within 15 s' })
const UNREADABLE = runVariablesUnreadableText({ requests: 1 })
const REFUSED = refusedVariablesText([{ reason: 'secret_unreadable', keys: ['API_TOKEN'] }])
const OFF_LANE = refusedVariablesText([{ reason: 'not_ops_lane', keys: [] }])
/** Every variables kind judged whole, as a live tick that dispatched its runs, ran its refresh and read an answer reports. */
const ALL_JUDGED = { variable_copy_use_judged: 1, variable_copy_refresh_judged: 1, run_variables_answers_judged: 1, variable_missing_judged: 1, variables_refused_judged: 1, variables_refused_off_lane_judged: 1 }

function kv() {
  const m = new Map<string, string>()
  /** The expiry each put asked for, by key (#3131: the first refused time must expire). */
  const ttl = new Map<string, number | undefined>()
  return {
    m,
    ttl,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string, o?: { expirationTtl?: number }) => { m.set(k, v); ttl.set(k, o?.expirationTtl) },
    delete: async (k: string) => { m.delete(k) },
    list: async (o: { prefix: string }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(o.prefix)).sort().map((name) => ({ name })), list_complete: true }),
  }
}

const report = (n: number, problems: Array<[string, string]>, counts: Record<string, number> = ALL_JUDGED, succeeded: string[] | undefined = undefined) => ({
  tick_id: `t${n}`, mode: 'live', scheduled_time: null,
  started_at: new Date(NOW + n * MIN).toISOString(), finished_at: new Date(NOW + n * MIN + 1000).toISOString(),
  db_now: null, outcome: problems.length > 0 ? 'problems' : 'ok', problems: problems.map(([, t]) => t), problem_keys: problems.map(([k]) => k),
  counts, start_stamp_failed: false, ...(succeeded === undefined ? {} : { succeeded_workflows: succeeded }),
})

function deps(opts: { names?: Record<string, string>; failJob?: string } = {}) {
  const sent: Array<{ job: string; errors: string[]; title: string; fixHint?: string; context?: string }> = []
  const recovered: string[] = []
  return {
    sent,
    recovered,
    notifyFailure: async (_s: unknown, job: string, errors: string[], _k: unknown, remedy: { title: string; fixHint?: string; context?: string }) => {
      if (job === opts.failJob) throw new Error('Slack refused the page')
      sent.push({ job, errors, title: remedy.title, fixHint: remedy.fixHint, context: remedy.context })
    },
    notifyRecovery: async (_k: unknown, job: string) => { recovered.push(job) },
    workflowNames: async (_s: unknown, ids: readonly string[]) => new Map(Object.entries(opts.names ?? { [WF]: 'Lead intake', [OTHER]: 'Payout sync' }).filter(([id]) => ids.includes(id))),
  }
}

async function tick(store: ReturnType<typeof kv>, d: ReturnType<typeof deps>, n: number, r: Record<string, unknown>) {
  await recordOpsTickCompleted(store as unknown as KVNamespace, r, NOW + n * MIN + 2000)
  return runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW + n * MIN + 30_000, d)
}

describe('the pages about a run\'s variables (#3000)', () => {
  it('(d) pages a workflow whose runs failed on a missing variable at once, under its own title and fix, and never on the minute cron\'s page', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, report(1, [[`runs_variable_missing:${WF}`, MISSING]]))).toBe('alerted')
    expect(d.sent).toEqual([{
      job: `ops-runs-variable-missing:${WF}`, errors: [MISSING], title: 'Ops runs failed on a missing variable: Lead intake', fixHint: MISSING_VARIABLE_PAGE.fix, context: undefined,
    }])
    expect(d.recovered).toEqual([OPS_TICK_JOB])
  })

  // #3131: runs bidding refused their variables, on a page of their own beside the missing variable page.
  it('(e) pages a workflow whose runs bidding refused their variables at once, under its own title and the fix for its reason, never on the minute cron\'s page', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, report(1, [[`runs_refused_variables:${WF}.secret`, REFUSED]]))).toBe('alerted')
    expect(d.sent).toEqual([{
      job: `ops-runs-variables-refused:${WF}`, errors: [REFUSED], title: 'Ops runs failed because bidding refused their variables: Lead intake',
      fixHint: 'Enter the secret\'s value again on the Environment Variables page. Runs that already failed are not run again.', context: undefined,
    }])
    expect(d.recovered).toEqual([OPS_TICK_JOB])
    // Recorded by the workflow alone, so a later tick naming other reasons is the same page.
    expect([...store.m.keys()].filter((k) => k.startsWith(opsOwnPagePrefix('runs_refused_variables')))).toEqual([`${opsOwnPagePrefix('runs_refused_variables')}${WF}`])
  })

  it('(e) gives each reason\'s fix once, in the body\'s order, for mixed reasons, and every fix for a detail it cannot read', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, report(1, [[`runs_refused_variables:${WF}.version-placement-secret`, REFUSED], [`runs_refused_variables:${OTHER}`, REFUSED]]))
    expect(d.sent.map((p) => [p.job, p.fixHint])).toEqual([
      [`ops-runs-variables-refused:${WF}`, refusedVariablesFix('version-placement-secret')],
      [`ops-runs-variables-refused:${OTHER}`, REFUSED_VARIABLES_PAGE.fix],
    ])
    expect(d.sent[0].fixHint).toBe('Open the workflow in Bidspoke and save it again. Check the workflow\'s organization and lane in Bidspoke. Enter the secret\'s value again on the Environment Variables page. Runs that already failed are not run again.')
    expect(d.sent[1].title).toBe('Ops runs failed because bidding refused their variables: Payout sync')
  })

  it('(e) stands the refused variables page down only on a report that judged it and no longer names it, whatever reasons it named', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, report(1, [[`runs_refused_variables:${WF}.secret`, REFUSED]]))
    // The same workflow refused for another reason is the same page, paged again.
    await tick(store, d, 2, report(2, [[`runs_refused_variables:${WF}.version`, REFUSED]]))
    expect(d.sent.map((p) => p.job)).toEqual([`ops-runs-variables-refused:${WF}`, `ops-runs-variables-refused:${WF}`])
    expect(d.recovered).not.toContain(`ops-runs-variables-refused:${WF}`)
    const { variables_refused_judged: _, ...notJudged } = ALL_JUDGED
    await tick(store, d, 3, report(3, [], notJudged))
    expect(d.recovered).not.toContain(`ops-runs-variables-refused:${WF}`)
    expect(store.m.has(`${opsOwnPagePrefix('runs_refused_variables')}${WF}`)).toBe(true)
    await tick(store, d, 4, report(4, []))
    expect(d.recovered.filter((j) => j === `ops-runs-variables-refused:${WF}`)).toHaveLength(1)
    expect([...store.m.keys()].filter((k) => k.startsWith(opsOwnPagePrefix('runs_refused_variables')))).toEqual([])
  })

  it('(e) raises a refused variables page that failed to send, keeping its record so its all clear still follows', async () => {
    const store = kv()
    const d = deps({ failJob: `ops-runs-variables-refused:${WF}` })
    await recordOpsTickCompleted(store as unknown as KVNamespace, report(1, [[`runs_refused_variables:${WF}.secret`, REFUSED]]), NOW + MIN + 2000)
    await expect(runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW + MIN + 30_000, d))
      .rejects.toThrow(/the page for workflow .* runs bidding refused their variables failed: Slack refused the page/)
    expect(store.m.has(`${opsOwnPagePrefix('runs_refused_variables')}${WF}`)).toBe(true)
  })

  // Dan, 2026-10-30 ("Second refused run"): a refusal because the workflow is
  // off the ops lane pages once a refused run comes 3 minutes or more after
  // the workflow's first, with no successful run of it between, so a workflow
  // mid move does not page, one running every minute pages after 3 minutes,
  // and an hourly one pages on its second refused run.
  const LANE = `runs_refused_off_lane:${WF}`
  const FIRST = `${OFF_LANE_FIRST_REFUSED_PREFIX}${WF}`
  const lanePage = {
    job: `ops-runs-variables-refused-off-lane:${WF}`, errors: [OFF_LANE], title: 'Ops runs failed because bidding refused their variables: Lead intake',
    fixHint: REFUSED_OFF_LANE_PAGE.fix, context: undefined,
  }

  it('(f) pages a workflow refused every minute once its refused run comes 3 minutes after its first, and records the first with an expiry', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, report(1, [[LANE, OFF_LANE]]))).toBe('held')
    expect(store.m.get(FIRST)).toBe(new Date(NOW + MIN).toISOString())
    expect(store.ttl.get(FIRST)).toBe(OFF_LANE_FIRST_REFUSED_TTL_SECONDS)
    expect(await tick(store, d, 2, report(2, [[LANE, OFF_LANE]]))).toBe('held')
    expect(await tick(store, d, 3, report(3, [[LANE, OFF_LANE]]))).toBe('held')
    expect(d.sent).toEqual([])
    // The first refused time is kept, its expiry renewed, while the refusals go on.
    expect(store.m.get(FIRST)).toBe(new Date(NOW + MIN).toISOString())
    expect(await tick(store, d, 4, report(4, [[LANE, OFF_LANE]]))).toBe('alerted')
    expect(d.sent).toEqual([lanePage])
    expect(REFUSED_OFF_LANE_PAGE.pagesAfterFirstMs).toBe(3 * MIN)
  })

  it('(f) pages an hourly workflow on its second refused run, the ticks between naming nothing', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, report(1, [[LANE, OFF_LANE]]))).toBe('held')
    for (const n of [2, 30, 59]) await tick(store, d, n, report(n, [], ALL_JUDGED, []))
    expect(store.m.has(FIRST)).toBe(true)
    expect(await tick(store, d, 61, report(61, [[LANE, OFF_LANE]]))).toBe('alerted')
    expect(d.sent).toEqual([lanePage])
  })

  it('(f) starts again from a successful run of the workflow between its refused runs', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, report(1, [[LANE, OFF_LANE]]))
    await tick(store, d, 2, report(2, [], ALL_JUDGED, [OTHER, WF]))
    expect(store.m.has(FIRST)).toBe(false)
    expect(await tick(store, d, 5, report(5, [[LANE, OFF_LANE]]))).toBe('held')
    expect(store.m.get(FIRST)).toBe(new Date(NOW + 5 * MIN).toISOString())
    expect(await tick(store, d, 8, report(8, [[LANE, OFF_LANE]]))).toBe('alerted')
  })

  it('(f) takes a refused run in the same report as a successful one as the first again', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, report(1, [[LANE, OFF_LANE]]))
    expect(await tick(store, d, 5, report(5, [[LANE, OFF_LANE]], ALL_JUDGED, [WF]))).toBe('held')
    expect(store.m.get(FIRST)).toBe(new Date(NOW + 5 * MIN).toISOString())
    expect(d.sent).toEqual([])
  })

  it('(f) keeps the first refused time through a report that says nothing of successful runs', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, report(1, [[LANE, OFF_LANE]]))
    // An ops release before #3131, or a tick that judged no run: not known, never read as a successful run.
    await tick(store, d, 2, report(2, []))
    expect(store.m.has(FIRST)).toBe(true)
    expect(await tick(store, d, 4, report(4, [[LANE, OFF_LANE]]))).toBe('alerted')
  })

  it('(f) pages when the first refused time cannot be read, and raises the failure', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, report(1, [[LANE, OFF_LANE]]))
    const failing = { ...store, get: async (k: string) => { if (k === FIRST) throw new Error('KV did not answer'); return store.get(k) } }
    await recordOpsTickCompleted(failing as unknown as KVNamespace, report(2, [[LANE, OFF_LANE]]), NOW + 2 * MIN + 2000)
    await expect(runOpsTickReportCheck({} as never, failing as unknown as KVNamespace, NOW + 2 * MIN + 30_000, d))
      .rejects.toThrow(/when workflow .* runs were first refused could not be read: KV did not answer/)
    expect(d.sent).toEqual([lanePage])
  })

  it('(f) stands the lane page down on a report that judged it and no longer names it, keeping the first refused time', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, report(1, [[LANE, OFF_LANE]]))
    await tick(store, d, 4, report(4, [[LANE, OFF_LANE]]))
    await tick(store, d, 5, report(5, []))
    expect(d.recovered).toContain(`ops-runs-variables-refused-off-lane:${WF}`)
    expect(store.m.has(FIRST)).toBe(true)
  })

  it('(f) pages the other reason at once and holds the lane one, when one report names both', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, report(1, [[LANE, OFF_LANE], [`runs_refused_variables:${WF}.secret`, REFUSED]]))
    expect(d.sent.map((p) => p.job)).toEqual([`ops-runs-variables-refused:${WF}`])
  })

  it('(a) pages runs that ran on the copy while bidding answered the refresh at once, per workflow', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, report(1, [[`runs_on_variable_copy:${WF}`, ON_COPY], [`runs_on_variable_copy:${OTHER}`, ON_COPY]]))
    expect(d.sent.map((p) => [p.job, p.title, p.fixHint])).toEqual([
      [`ops-runs-on-variable-copy:${WF}`, 'Ops runs used old variables: Lead intake', RUNS_ON_VARIABLE_COPY_PAGE.fix],
      [`ops-runs-on-variable-copy:${OTHER}`, 'Ops runs used old variables: Payout sync', RUNS_ON_VARIABLE_COPY_PAGE.fix],
    ])
  })

  it('(c) pages an answer ops cannot read at once, on one page', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, report(1, [['run_variables_unreadable', UNREADABLE]]))
    expect(d.sent).toEqual([{
      job: 'ops-run-variables-unreadable', errors: [UNREADABLE], title: 'Ops can\'t read the variables bidding sent', fixHint: RUN_VARIABLES_UNREADABLE_PAGE.fix, context: undefined,
    }])
  })

  it('(b) holds a failed refresh for two ticks, pages the third in a row on its own page saying so, and stands down when a tick refreshes', async () => {
    const store = kv()
    const d = deps()
    expect(await tick(store, d, 1, report(1, [['variable_copy_refresh_failing', REFRESH]]))).toBe('held')
    expect(await tick(store, d, 2, report(2, [['variable_copy_refresh_failing', REFRESH]]))).toBe('held')
    expect(d.sent).toEqual([])
    // Held, so nothing was opened and the minute cron's page is not sent either.
    expect(d.recovered).toEqual([OPS_TICK_JOB, OPS_TICK_JOB])
    expect(await tick(store, d, 3, report(3, [['variable_copy_refresh_failing', REFRESH]]))).toBe('alerted')
    expect(d.sent).toEqual([{
      job: 'ops-variable-copy-refresh', errors: [REFRESH], title: 'Ops can\'t refresh its copy of the variables', fixHint: VARIABLE_COPY_REFRESH_PAGE.fix,
      context: 'Reported by 3 or more ticks in a row.',
    }])
    await tick(store, d, 4, report(4, []))
    expect(d.recovered).toContain('ops-variable-copy-refresh')
    expect([...store.m.keys()].filter((k) => k.startsWith(opsOwnPagePrefix('variable_copy_refresh_failing')))).toEqual([])
  })

  it('a failed refresh broken by one good tick starts its count again', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, report(1, [['variable_copy_refresh_failing', REFRESH]]))
    await tick(store, d, 2, report(2, [['variable_copy_refresh_failing', REFRESH]]))
    await tick(store, d, 3, report(3, []))
    await tick(store, d, 4, report(4, [['variable_copy_refresh_failing', REFRESH]]))
    await tick(store, d, 5, report(5, [['variable_copy_refresh_failing', REFRESH]]))
    expect(d.sent).toEqual([])
  })

  it('stands a page down only on a report that judged its kind and no longer names it', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, report(1, [[`runs_variable_missing:${WF}`, MISSING], ['run_variables_unreadable', UNREADABLE]]))
    // A tick that dispatched no runs and read no answer judged neither kind: nothing stands down.
    await tick(store, d, 2, report(2, [], {}))
    expect(d.recovered).not.toContain(`ops-runs-variable-missing:${WF}`)
    expect(d.recovered).not.toContain('ops-run-variables-unreadable')
    // One that left problems out says nothing of a kind it may have left out.
    await tick(store, d, 3, report(3, [['problems_left_out', '3 more problems were left out of this report.']]))
    expect(d.recovered).not.toContain(`ops-runs-variable-missing:${WF}`)
    // Judged, and no longer named: each stands down, once.
    await tick(store, d, 4, report(4, []))
    expect(d.recovered.filter((j) => j === `ops-runs-variable-missing:${WF}`)).toHaveLength(1)
    expect(d.recovered.filter((j) => j === 'ops-run-variables-unreadable')).toHaveLength(1)
    await tick(store, d, 5, report(5, []))
    expect(d.recovered.filter((j) => j === `ops-runs-variable-missing:${WF}`)).toHaveLength(1)
  })

  it('pages the others and raises the one page that failed, keeping its record so its all clear still follows', async () => {
    const store = kv()
    const d = deps({ failJob: `ops-runs-variable-missing:${WF}` })
    await recordOpsTickCompleted(store as unknown as KVNamespace, report(1, [[`runs_variable_missing:${WF}`, MISSING], ['run_variables_unreadable', UNREADABLE]]), NOW + MIN + 2000)
    await expect(runOpsTickReportCheck({} as never, store as unknown as KVNamespace, NOW + MIN + 30_000, d)).rejects.toThrow(/the page for workflow .* runs that failed on a missing variable failed: Slack refused the page/)
    expect(d.sent.map((p) => p.job)).toEqual(['ops-run-variables-unreadable'])
    expect(store.m.has(`${opsOwnPagePrefix('runs_variable_missing')}${WF}`)).toBe(true)
  })

  it('stands nothing down, and raises it, when the open pages cannot be listed', async () => {
    const store = kv()
    const d = deps()
    await tick(store, d, 1, report(1, [[`runs_variable_missing:${WF}`, MISSING]]))
    const failing = { ...store, list: async () => { throw new Error('KV did not answer') } }
    await recordOpsTickCompleted(failing as unknown as KVNamespace, report(2, []), NOW + 2 * MIN + 2000)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(runOpsTickReportCheck({} as never, failing as unknown as KVNamespace, NOW + 2 * MIN + 30_000, d)).rejects.toThrow(/open pages for runs that failed on a missing variable could not be read: KV did not answer/)
    } finally {
      errors.mockRestore()
    }
    expect(d.recovered).not.toContain(`ops-runs-variable-missing:${WF}`)
    expect(store.m.has(`${opsOwnPagePrefix('runs_variable_missing')}${WF}`)).toBe(true)
  })

  it('keeps the page for runs that cannot start where it was, beside the new ones', () => {
    expect(opsOwnPagePrefix('runs_unstarted')).toBe('ops-tick:unstarted-page:')
    expect(opsOwnPagePrefix('runs_variable_missing')).toBe('ops-tick:own-page:runs_variable_missing:')
  })
})
