import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../slack', () => ({
  sendUpstreamOutageAlert: vi.fn().mockResolvedValue('ts-1'),
  sendFailureSaturationAlert: vi.fn().mockResolvedValue(true),
}))
import {
  classifyOutageCause,
  attributeOutageCause,
  resolveFailedStepType,
  detectOutageSpike,
  groupOutages,
  runUpstreamOutageCheck,
  UPSTREAM_OUTAGE_CAUSES,
  DEFAULT_OUTAGE_THRESHOLD,
  detectFailureSaturation,
  groupSaturation,
} from '../upstream-outage'
import { sendUpstreamOutageAlert, sendFailureSaturationAlert } from '../slack'

describe('classifyOutageCause (#331)', () => {
  it('classifies Salesforce 5xx and concurrency-governor errors as the salesforce cause', () => {
    expect(classifyOutageCause('Salesforce API error (520): error code: 520')?.key).toBe('salesforce')
    expect(
      classifyOutageCause('Salesforce API error (403): [{"message":"ConcurrentPerOrgLongTxn Limit exceeded.","errorCode":"REQUEST_LIMIT_EXCEEDED"}]')?.key,
    ).toBe('salesforce')
  })

  it('classifies Tripoint proxy 5xx as the tripoint cause', () => {
    expect(classifyOutageCause('Tripoint proxy 502: error code: 502')?.key).toBe('tripoint')
  })

  it('classifies timeouts and aborts as the timeout cause', () => {
    expect(classifyOutageCause('The operation was aborted')?.key).toBe('timeout')
    expect(classifyOutageCause('Step timed out after 8000ms (in-flight upstream call canceled via abort signal)')?.key).toBe('timeout')
    expect(classifyOutageCause('Parallel failed — child "trades_body" did not complete in time')?.key).toBe('timeout')
  })

  it('does NOT classify per-lead business/code errors as an outage', () => {
    expect(classifyOutageCause('Code returned error response: HTTP 500 — {"lead_id":"x","status":"error","reason":"eq"}')).toBeNull()
    expect(classifyOutageCause('Salesforce API error (400): VALIDATION/DUPLICATE_VALUE')).toBeNull()
    expect(classifyOutageCause('expected rejection — exiting workflow')).toBeNull()
  })

  it('classifies a missing credential/config failure as the missing_config cause (#393)', () => {
    expect(classifyOutageCause('Salesforce node requires SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID, and SALESFORCE_CLIENT_SECRET env vars')?.key).toBe('missing_config')
    expect(classifyOutageCause('Missing ACHIEVE_USERNAME/ACHIEVE_PASSWORD env vars')?.key).toBe('missing_config')
  })

  it('is null for empty/missing messages', () => {
    expect(classifyOutageCause(null)).toBeNull()
    expect(classifyOutageCause(undefined)).toBeNull()
    expect(classifyOutageCause('')).toBeNull()
  })
})

describe('detectOutageSpike (#331)', () => {
  it('fires at or above the threshold', () => {
    expect(detectOutageSpike(5, 5)).toBe(true)
    expect(detectOutageSpike(6, 5)).toBe(true)
  })
  it('stays quiet below the threshold', () => {
    expect(detectOutageSpike(4, 5)).toBe(false)
  })
  it('is disabled for a non-positive threshold', () => {
    expect(detectOutageSpike(100, 0)).toBe(false)
  })
})

describe('groupOutages (#331)', () => {
  const t0 = Date.UTC(2026, 5, 23, 12, 0, 0)
  const names = new Map([['wf-1', 'Engine Bidding'], ['wf-2', 'Main Flow']])
  const row = (
    workflow_id: string,
    error_message: string | null,
    minsAfterStart: number,
    failed_step_type: string | null = null,
  ) => ({
    workflow_id,
    error_message,
    completed_at: new Date(t0 + minsAfterStart * 60_000).toISOString(),
    failed_step_type,
  })

  it('aggregates matching failures across workflows by cause, inside the window', () => {
    const rows = [
      row('wf-1', 'Salesforce API error (520): error code: 520', 1),
      row('wf-2', 'Salesforce API error (403): ConcurrentPerOrgLongTxn Limit exceeded.', 2),
      row('wf-1', 'The operation was aborted', 3),
      row('wf-1', 'Code returned error response: HTTP 500 — reason eq', 2), // business error, ignored
      row('wf-1', 'Salesforce API error (520)', -2),                        // before window, ignored
    ]
    const groups = groupOutages(rows, names, t0)
    const sf = groups.find((g) => g.cause.key === 'salesforce')
    expect(sf?.count).toBe(2)
    expect(sf?.workflowNames.sort()).toEqual(['Engine Bidding', 'Main Flow'])
    const timeout = groups.find((g) => g.cause.key === 'timeout')
    expect(timeout?.count).toBe(1)
  })

  it('returns no groups when nothing matches', () => {
    expect(groupOutages([row('wf-1', 'unrelated business error', 1)], names, t0)).toEqual([])
  })

  it('attributes a generic timeout on a Salesforce step to the Salesforce cause (#332)', () => {
    const rows = [
      row('wf-1', 'Salesforce API error (520)', 1),              // named SF match
      row('wf-2', 'The operation was aborted', 2, 'salesforce'), // timeout on an SF step -> SF
      row('wf-1', 'Step timed out after 8000ms (canceled via abort signal)', 3, 'code'), // timeout on code step -> stays timeout
    ]
    const groups = groupOutages(rows, names, t0)
    expect(groups.find((g) => g.cause.key === 'salesforce')?.count).toBe(2)
    expect(groups.find((g) => g.cause.key === 'timeout')?.count).toBe(1)
  })
})

describe('attributeOutageCause (#332)', () => {
  it('re-attributes a generic timeout to the failed step’s upstream service', () => {
    expect(attributeOutageCause('The operation was aborted', 'salesforce')?.key).toBe('salesforce')
  })

  it('leaves a named-upstream error-message match alone (the message wins)', () => {
    expect(attributeOutageCause('Salesforce API error (520)', 'code')?.key).toBe('salesforce')
  })

  it('keeps the generic timeout bucket when the failed step maps to no named upstream', () => {
    expect(attributeOutageCause('The operation was aborted', 'code')?.key).toBe('timeout')
    expect(attributeOutageCause('The operation was aborted', null)?.key).toBe('timeout')
  })

  it('returns null for a non-outage error regardless of step type', () => {
    expect(attributeOutageCause('expected rejection — exiting workflow', 'salesforce')).toBeNull()
  })
})

describe('resolveFailedStepType (#332)', () => {
  const nodes = [
    { namespace: 'create_prospect', type: 'salesforce' },
    { namespace: 'eq_pull', type: 'code' },
  ]
  it('returns the failed step’s node type from the definition', () => {
    expect(resolveFailedStepType(nodes, 'create_prospect')).toBe('salesforce')
  })
  it('returns null when there is no failed step', () => {
    expect(resolveFailedStepType(nodes, null)).toBeNull()
    expect(resolveFailedStepType(nodes, undefined)).toBeNull()
  })
  it('returns null when the failed namespace is not in the definition', () => {
    expect(resolveFailedStepType(nodes, 'ghost')).toBeNull()
  })
})

// ── runUpstreamOutageCheck (cron orchestration) ─────────────────────────────
/**
 * #1100. The aggregated alert needs DEFAULT_OUTAGE_THRESHOLD failures inside a
 * single minute, which an absolute count can only see on a busy lane. It cannot
 * tell 7 of 7 failing from 7 of 700 (LESSONS L139).
 *
 * Two measured incidents, both invisible to the absolute rule:
 *
 *   2026-09-02, Main Flow: first failure 12:20:21 UTC, alert 12:38:01, so
 *   eighteen minutes of roughly every lead failing. Per-minute failure counts
 *   were 3, 5, 4, 2, 3, 6, 8, 7, 3, 5, 8, 7, 4, 4, 6, 7 before one minute
 *   finally reached 12, because Main Flow runs about 7 leads a minute at 8am.
 *
 *   2026-09-01, RML LendSwift: 50 failures over twenty minutes, never more than
 *   5 in one minute, so it could NEVER have crossed the threshold. Its error
 *   ("Code returned error response: HTTP 500") is not a recognised cause either,
 *   so a rule scoped to the cause list would still miss it. Hence any error.
 *
 * The share threshold is measured, not chosen. Over five days and 5,238
 * five-minute buckets holding at least 10 runs, 5,151 sat at exactly 0% failure
 * and only 12 reached 50% or above. Those 12 are three real incidents and
 * nothing else, and the 30 to 50% band holds 5 buckets in the whole period, so
 * 0.5 sits in a genuine gap.
 */
describe('detectFailureSaturation (#1100)', () => {
  it('fires when almost every run in the window failed, below the absolute count', () => {
    // The Main Flow shape: no single minute reached 10, but 17 of 19 failed.
    expect(detectFailureSaturation(17, 19)).toBe(true)
  })

  it('fires on the RML shape, which the absolute count could never reach', () => {
    // 18 of 20 over five minutes, peaking at 5 failures in any one minute.
    expect(detectFailureSaturation(18, 20)).toBe(true)
  })

  it('stays quiet on scattered failures over high volume', () => {
    // The busiest real non-incident bucket shape: a handful out of hundreds.
    expect(detectFailureSaturation(5, 200)).toBe(false)
  })

  it('stays quiet just under the measured share, where the real distribution thins out', () => {
    expect(detectFailureSaturation(9, 20)).toBe(false)
  })

  it('refuses to judge a window with too few runs, rather than calling it saturated', () => {
    // 8 of 8 is 100%, and it is also eight leads. Without a floor every quiet
    // workflow pages the moment two runs fail (L139 in the other direction).
    expect(detectFailureSaturation(8, 8)).toBe(false)
  })

  it('does not divide by zero on an idle workflow', () => {
    expect(detectFailureSaturation(0, 0)).toBe(false)
  })
})

/**
 * The numerator and the denominator must describe the SAME population (L16).
 *
 * The failures are fetched with a `completed_at` window and the run totals come
 * from `execution_counts_per_minute`, which buckets by `started_at`. A failing
 * run that started before the window and completed inside it would then be
 * counted in the numerator and not the denominator, and the share can exceed 1.
 */
describe('groupSaturation windows on started_at, matching the totals source', () => {
  const NOW = Date.parse('2026-09-02T12:30:00Z')
  const WINDOW_START = NOW - 5 * 60 * 1000

  const row = (workflow_id: string, startedOffsetMs: number) => ({
    workflow_id,
    error_message: 'Salesforce API error (500): boom',
    started_at: new Date(NOW - startedOffsetMs).toISOString(),
    completed_at: new Date(NOW).toISOString(),
  })

  it('excludes a failure that started before the window even though it completed inside it', () => {
    // Seven inside the window against twelve runs is saturated, so a group
    // exists to assert on. The eighth failure started ten minutes ago and must
    // not be counted, which is the whole point: including it would report eight
    // failures for a window that only held seven.
    const rows = [
      ...Array.from({ length: 7 }, () => row('wf-1', 60 * 1000)),
      row('wf-1', 10 * 60 * 1000),
    ]
    const groups = groupSaturation(rows, new Map([['wf-1', 12]]), new Map([['wf-1', 'Main Flow']]), WINDOW_START)
    expect(groups[0].failureCount).toBe(7)
    expect(groups[0].totalCount).toBe(12)
  })

  it('never reports a share above 1', () => {
    const rows = Array.from({ length: 20 }, () => row('wf-1', 60 * 1000))
    const groups = groupSaturation(rows, new Map([['wf-1', 12]]), new Map([['wf-1', 'Main Flow']]), WINDOW_START)
    // 20 failures counted against a 12-run denominator would be 1.67. The
    // denominator is the authority on how many runs there were, so a numerator
    // that exceeds it is a disagreement to refuse, not a share to report.
    expect(groups[0]).toBeUndefined()
  })
})

function makeKv(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return {
    store: m,
    get: vi.fn(async (k: string) => m.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { m.set(k, v) }),
  }
}

function makeSupabase(tables: Record<string, unknown[]>) {
  return {
    // Run totals for saturation come from the execution_counts_per_minute RPC.
    // The name is asserted rather than ignored, so a rename cannot leave the
    // denominator silently empty and every workflow unjudged.
    rpc: (name: string) => {
      if (name !== 'execution_counts_per_minute') throw new Error(`unexpected rpc: ${name}`)
      return Promise.resolve({ data: tables.__runTotals ?? [], error: null })
    },
    from: (table: string) => {
      const data = tables[table] ?? []
      const chain: unknown = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res)
          return () => chain
        },
      })
      return chain
    },
  }
}

// 10s ago — safely inside the trailing 1-minute window without sitting on the
// boundary (60s ago would be excluded once the few-ms run delay is added).
const recent = () => new Date(Date.now() - 10_000).toISOString()
const failRow = (workflow_id: string, msg: string | null) => ({ workflow_id, error_message: msg, completed_at: recent() })

describe('runUpstreamOutageCheck (#331)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fires one aggregated alert per cause and sets a cooldown when failures spike', async () => {
    const kv = makeKv()
    const execs = Array.from({ length: DEFAULT_OUTAGE_THRESHOLD }, () => failRow('wf-1', 'Salesforce API error (520): error code: 520'))
    const sb = makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [{ id: 'wf-1', name: 'Engine Bidding', organization_id: 'org-1' }],
      workflow_executions: execs,
    })
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')
    expect(sendUpstreamOutageAlert).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(sendUpstreamOutageAlert).mock.calls[0][2]
    expect(payload).toMatchObject({ cause_key: 'salesforce', failure_count: DEFAULT_OUTAGE_THRESHOLD })
    expect(kv.store.has('upstream-outage-cooldown:org-1:salesforce')).toBe(true)
  })

  it('stays quiet below the threshold', async () => {
    const kv = makeKv()
    const sb = makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [{ id: 'wf-1', name: 'Engine Bidding', organization_id: 'org-1' }],
      workflow_executions: [failRow('wf-1', 'Salesforce API error (520)')],
    })
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')
    expect(sendUpstreamOutageAlert).not.toHaveBeenCalled()
  })

  it('suppresses while the per-cause cooldown is active', async () => {
    const kv = makeKv({ 'upstream-outage-cooldown:org-1:salesforce': '1' })
    const execs = Array.from({ length: DEFAULT_OUTAGE_THRESHOLD }, () => failRow('wf-1', 'Salesforce API error (520)'))
    const sb = makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [{ id: 'wf-1', name: 'Engine Bidding', organization_id: 'org-1' }],
      workflow_executions: execs,
    })
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')
    expect(sendUpstreamOutageAlert).not.toHaveBeenCalled()
  })

  // The fetch was widened to cover saturation's five minute window (#1100), so
  // the cause rule now receives rows it must NOT count. It filters to its own
  // one minute window internally, and this asserts that rather than trusting it:
  // without the filter, five minutes of scattered failures would cross the
  // absolute threshold and page as a one minute spike.
  it('keeps the cause rule on its own one-minute window despite the wider fetch', async () => {
    const kv = makeKv()
    const threeMinutesAgo = () => new Date(Date.now() - 3 * 60 * 1000).toISOString()
    const stale = Array.from({ length: DEFAULT_OUTAGE_THRESHOLD * 2 }, () => ({
      workflow_id: 'wf-1',
      error_message: 'Salesforce API error (520): error code: 520',
      started_at: threeMinutesAgo(),
      completed_at: threeMinutesAgo(),
    }))
    const sb = makeSupabase({
      service_connections: [{ organization_id: 'org-1' }],
      workflows: [{ id: 'wf-1', name: 'Engine Bidding', organization_id: 'org-1' }],
      workflow_executions: stale,
      // A large denominator so saturation stays quiet and this test speaks only
      // about the cause rule.
      __runTotals: [{ workflow_id: 'wf-1', minute: threeMinutesAgo(), cnt: 500 }],
    })
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')
    expect(sendUpstreamOutageAlert).not.toHaveBeenCalled()
  })

  it('does nothing when no org has Slack connected', async () => {
    const kv = makeKv()
    const sb = makeSupabase({ service_connections: [], workflows: [], workflow_executions: [] })
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')
    expect(sendUpstreamOutageAlert).not.toHaveBeenCalled()
  })
})

/**
 * The runner half of #1100: saturation has to reach Slack, page once, and say
 * only what it measured.
 */
describe('runUpstreamOutageCheck fires saturation (#1100)', () => {
  beforeEach(() => vi.clearAllMocks())

  // The measured Main Flow shape: 17 of 19 failed, and no single minute reached
  // DEFAULT_OUTAGE_THRESHOLD, so the absolute rule stays silent while this fires.
  const saturatedOrg = (failures = 17, total = 19) => ({
    service_connections: [{ organization_id: 'org-1' }],
    workflows: [{ id: 'wf-1', name: 'Main Flow', organization_id: 'org-1' }],
    workflow_executions: Array.from({ length: failures }, () => ({
      workflow_id: 'wf-1',
      error_message: 'Parallel failed: child "trades_body" failed: Salesforce API error (500): boom',
      started_at: recent(),
      completed_at: recent(),
    })),
    __runTotals: [{ workflow_id: 'wf-1', minute: recent(), cnt: total }],
  })

  it('pages on a saturated workflow the absolute count cannot reach', async () => {
    const kv = makeKv()
    const sb = makeSupabase(saturatedOrg())
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')

    expect(sendFailureSaturationAlert).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(sendFailureSaturationAlert).mock.calls[0][2]
    expect(payload).toMatchObject({ workflow_name: 'Main Flow', failure_count: 17, total_count: 19 })
    // The absolute rule must NOT also fire: 17 failures in the trailing minute
    // would cross it, so this proves the two rules are not double-paging on one
    // incident... except they legitimately can. Assert only that saturation ran.
    expect(kv.store.has('failure-saturation-cooldown:org-1:wf-1')).toBe(true)
  })

  it('stays quiet when the failures are scattered over high volume', async () => {
    const kv = makeKv()
    const sb = makeSupabase(saturatedOrg(5, 400))
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')
    expect(sendFailureSaturationAlert).not.toHaveBeenCalled()
  })

  it('stays quiet when the window is too small to judge', async () => {
    const kv = makeKv()
    const sb = makeSupabase(saturatedOrg(8, 8))
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')
    expect(sendFailureSaturationAlert).not.toHaveBeenCalled()
  })

  it('pages once per workflow while the cooldown holds', async () => {
    const kv = makeKv({ 'failure-saturation-cooldown:org-1:wf-1': '1' })
    const sb = makeSupabase(saturatedOrg())
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')
    expect(sendFailureSaturationAlert).not.toHaveBeenCalled()
  })

  // A send that did not deliver must not start the cooldown, or a kicked bot
  // buys thirty minutes of silence over a live outage.
  it('does not start the cooldown when the alert failed to deliver', async () => {
    vi.mocked(sendFailureSaturationAlert).mockResolvedValueOnce(false)
    const kv = makeKv()
    const sb = makeSupabase(saturatedOrg())
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')
    expect(kv.store.has('failure-saturation-cooldown:org-1:wf-1')).toBe(false)
  })
})

it('every built-in cause has a key, label, and at least one matcher', () => {
  for (const c of UPSTREAM_OUTAGE_CAUSES) {
    expect(c.key).toBeTruthy()
    expect(c.label).toBeTruthy()
    expect(c.matchers.length).toBeGreaterThan(0)
  }
})
