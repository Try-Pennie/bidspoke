import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../slack', () => ({ sendUpstreamOutageAlert: vi.fn().mockResolvedValue('ts-1') }))
import {
  classifyOutageCause,
  attributeOutageCause,
  resolveFailedStepType,
  detectOutageSpike,
  groupOutages,
  runUpstreamOutageCheck,
  UPSTREAM_OUTAGE_CAUSES,
  DEFAULT_OUTAGE_THRESHOLD,
} from '../upstream-outage'
import { sendUpstreamOutageAlert } from '../slack'

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

  it('does nothing when no org has Slack connected', async () => {
    const kv = makeKv()
    const sb = makeSupabase({ service_connections: [], workflows: [], workflow_executions: [] })
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')
    expect(sendUpstreamOutageAlert).not.toHaveBeenCalled()
  })
})

it('every built-in cause has a key, label, and at least one matcher', () => {
  for (const c of UPSTREAM_OUTAGE_CAUSES) {
    expect(c.key).toBeTruthy()
    expect(c.label).toBeTruthy()
    expect(c.matchers.length).toBeGreaterThan(0)
  }
})
