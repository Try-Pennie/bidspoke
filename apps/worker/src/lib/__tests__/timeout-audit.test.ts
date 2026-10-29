import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findSubFloorNodes, scanWorkflowDefinitions, warningsSignature, findOverProvisionedNodes, findUnderProvisionedNodes, collectWorkflowDurationStats, collectPeriodStats, runTimeoutAuditCheck, TIMEOUT_AUDIT_RPC_CONCURRENCY, mapWithConcurrency, type NodeDurationStats } from '../timeout-audit'
import { AUDIT_PERIOD_DAYS } from '../timeout-findings'
import { suggestedTimeoutMs, timeoutSeverity } from '../timeout-suggestion'
import type { WorkflowDefinition, NodeDefinition } from '../../types'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', async (orig) => ({
  ...(await orig<typeof import('../slack')>()),
  getSlackConnection: vi.fn(),
  sendTimeoutConfigAlert: vi.fn(),
}))
import { getSlackConnection, sendTimeoutConfigAlert } from '../slack'

function node(partial: Partial<NodeDefinition> & { id: string; type: NodeDefinition['type'] }): NodeDefinition {
  return { namespace: partial.id, config: {}, ...partial }
}

function def(nodes: NodeDefinition[]): WorkflowDefinition {
  return { id: 'wf', name: 'wf', trigger: {} as WorkflowDefinition['trigger'], nodes, edges: [] }
}

describe('findSubFloorNodes', () => {
  it('flags a code node below the 150ms dispatch floor', () => {
    const out = findSubFloorNodes(def([node({ id: 'parsed_name', type: 'code', config: { timeout_ms: 50 } })]))
    expect(out).toEqual([
      { node_id: 'parsed_name', namespace: 'parsed_name', label: null, type: 'code', configured_ms: 50, floor_ms: 150 },
    ])
  })

  it('flags a network node below the 50ms floor and keeps the label', () => {
    const out = findSubFloorNodes(def([node({ id: 'sf', type: 'salesforce', label: 'Create Prospect', config: { timeout_ms: 25 } })]))
    expect(out[0]).toMatchObject({ node_id: 'sf', label: 'Create Prospect', configured_ms: 25, floor_ms: 50 })
  })

  it('does not flag a timeout that clears the floor', () => {
    expect(findSubFloorNodes(def([node({ id: 'c', type: 'code', config: { timeout_ms: 150 } })]))).toEqual([])
    expect(findSubFloorNodes(def([node({ id: 'c', type: 'code', config: { timeout_ms: 1000 } })]))).toEqual([])
  })

  it('ignores nodes with no timeout or a non-numeric timeout', () => {
    expect(findSubFloorNodes(def([node({ id: 'a', type: 'code', config: {} })]))).toEqual([])
    expect(findSubFloorNodes(def([node({ id: 'b', type: 'code', config: { timeout_ms: '50' as unknown as number } })]))).toEqual([])
  })

  it('returns empty for a missing or malformed definition', () => {
    expect(findSubFloorNodes(null)).toEqual([])
    expect(findSubFloorNodes(undefined)).toEqual([])
    expect(findSubFloorNodes({} as unknown as WorkflowDefinition)).toEqual([])
  })
})

describe('scanWorkflowDefinitions', () => {
  it('keeps only workflows that have at least one offending node', () => {
    const out = scanWorkflowDefinitions([
      { id: 'wf1', name: 'Engine Bidding', definition: def([node({ id: 'parsed_name', type: 'code', config: { timeout_ms: 50 } })]) },
      { id: 'wf2', name: 'Clean Flow', definition: def([node({ id: 'ok', type: 'code', config: { timeout_ms: 1000 } })]) },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ workflow_id: 'wf1', workflow_name: 'Engine Bidding' })
    expect(out[0].nodes).toHaveLength(1)
  })
})

describe('warningsSignature', () => {
  const a = scanWorkflowDefinitions([
    { id: 'wf1', name: 'A', definition: def([node({ id: 'n1', type: 'code', config: { timeout_ms: 50 } })]) },
    { id: 'wf2', name: 'B', definition: def([node({ id: 'n2', type: 'salesforce', config: { timeout_ms: 25 } })]) },
  ])

  it('is stable regardless of input ordering', () => {
    const reversed = [...a].reverse()
    expect(warningsSignature(a)).toBe(warningsSignature(reversed))
  })

  it('changes when a configured value changes', () => {
    const b = scanWorkflowDefinitions([
      { id: 'wf1', name: 'A', definition: def([node({ id: 'n1', type: 'code', config: { timeout_ms: 75 } })]) },
      { id: 'wf2', name: 'B', definition: def([node({ id: 'n2', type: 'salesforce', config: { timeout_ms: 25 } })]) },
    ])
    expect(warningsSignature(b)).not.toBe(warningsSignature(a))
  })

  it('is empty when there are no offenders', () => {
    expect(warningsSignature([])).toBe('')
  })
})

describe('suggestedTimeoutMs', () => {
  it('with retries, p99 x1.5 drives the suggestion (max self-heals)', () => {
    // max(200*1.5, 150 floor) = 300, rounded to 50ms increments
    expect(suggestedTimeoutMs('code', 200, 900, 2)).toBe(300)
  })

  it('without retries, the suggestion must also clear max x1.05', () => {
    // max(300, 315, 150) = 315, rounded up to 350
    expect(suggestedTimeoutMs('code', 200, 300, 0)).toBe(350)
  })

  it('never suggests below the node-type floor', () => {
    expect(suggestedTimeoutMs('code', 10, 20, 2)).toBe(150)
  })
})

describe('timeoutSeverity', () => {
  it('with retries, red below p99, amber above', () => {
    expect(timeoutSeverity(180, 200, 300, 2)).toBe('red')
    expect(timeoutSeverity(250, 200, 300, 2)).toBe('amber')
  })

  it('without retries, red below max', () => {
    expect(timeoutSeverity(250, 200, 300, 0)).toBe('red')
    expect(timeoutSeverity(310, 200, 300, 0)).toBe('amber')
  })
})

describe('findOverProvisionedNodes', () => {
  const stats = (s: Partial<NodeDurationStats>): NodeDurationStats =>
    ({ p99: 200, max_ms: 300, sample_size: 100, ...s })

  it('flags a node configured far above its suggested value', () => {
    // default retries (2) -> suggested = 300; 3x = 900; configured 5000 > 900
    const out = findOverProvisionedNodes(
      def([node({ id: 'n1', type: 'code', config: { timeout_ms: 5000 } })]),
      new Map([['n1', stats({})]])
    )
    expect(out[0]).toMatchObject({ node_id: 'n1', configured_ms: 5000, suggested_ms: 300, p99_ms: 200, sample_size: 100 })
  })

  it('does not flag when configured is within 3x of suggested', () => {
    const out = findOverProvisionedNodes(
      def([node({ id: 'n1', type: 'code', config: { timeout_ms: 900 } })]), // not > 900
      new Map([['n1', stats({})]])
    )
    expect(out).toEqual([])
  })

  it('without retries, also requires clearing max x2', () => {
    // retries 0 -> suggested 350; 3x = 1050; max*2 = 600
    const flagged = findOverProvisionedNodes(
      def([node({ id: 'n1', type: 'code', config: { timeout_ms: 1100, retries: 0 } })]),
      new Map([['n1', stats({})]])
    )
    expect(flagged).toHaveLength(1)
    // above 3x suggested but the fat tail (max 300 -> x2 = 600) protects... use a
    // case where 3x suggested passes but max x2 does not: max 600 -> suggested
    // without retries = max(300, 630, 150) -> 650; 3x = 1950; max*2 = 1200
    const protectedOut = findOverProvisionedNodes(
      def([node({ id: 'n1', type: 'code', config: { timeout_ms: 1100, retries: 0 } })]),
      new Map([['n1', stats({ max_ms: 600 })]])
    )
    expect(protectedOut).toEqual([])
  })

  it('does not flag without enough run history', () => {
    const out = findOverProvisionedNodes(
      def([node({ id: 'n1', type: 'code', config: { timeout_ms: 5000 } })]),
      new Map([['n1', stats({ sample_size: 49 })]])
    )
    expect(out).toEqual([])
  })

  it('skips nodes with no stats, no timeout, or a non-numeric timeout', () => {
    const d = def([
      node({ id: 'no_stats', type: 'code', config: { timeout_ms: 5000 } }),
      node({ id: 'no_timeout', type: 'code', config: {} }),
    ])
    expect(findOverProvisionedNodes(d, new Map())).toEqual([])
  })
})

describe('findUnderProvisionedNodes', () => {
  const stats = (s: Partial<NodeDurationStats>): NodeDurationStats =>
    ({ p99: 5000, max_ms: 11000, sample_size: 1996, ...s })

  it('flags a node configured below the suggested value, amber above p99', () => {
    // default retries (2) -> suggested = p99*1.5 = 7500
    const out = findUnderProvisionedNodes(
      def([node({ id: 'equifax', type: 'code', label: 'Equifax', config: { timeout_ms: 6000 } })]),
      new Map([['equifax', stats({})]])
    )
    expect(out).toEqual([{
      node_id: 'equifax',
      namespace: 'equifax',
      label: 'Equifax',
      type: 'code',
      configured_ms: 6000,
      suggested_ms: 7500,
      p99_ms: 5000,
      max_ms: 11000,
      sample_size: 1996,
      window_days: null,
      retries: 2,
      severity: 'amber',
    }])
  })

  it('carries the sample window so the alert can gauge confidence', () => {
    const out = findUnderProvisionedNodes(
      def([node({ id: 'equifax', type: 'code', config: { timeout_ms: 6000 } })]),
      new Map([['equifax', stats({ window_days: 7 })]])
    )
    expect(out[0]).toMatchObject({ window_days: 7 })
  })

  it('marks red when the timeout is below the p99 with retries', () => {
    const out = findUnderProvisionedNodes(
      def([node({ id: 'equifax', type: 'code', config: { timeout_ms: 4000 } })]),
      new Map([['equifax', stats({})]])
    )
    expect(out[0]).toMatchObject({ configured_ms: 4000, severity: 'red' })
  })

  it('does not flag a timeout at or above the suggested value', () => {
    const out = findUnderProvisionedNodes(
      def([node({ id: 'equifax', type: 'code', config: { timeout_ms: 7500 } })]),
      new Map([['equifax', stats({})]])
    )
    expect(out).toEqual([])
  })

  it('leaves sub-floor nodes to the sub-floor scan', () => {
    const out = findUnderProvisionedNodes(
      def([node({ id: 'c', type: 'code', config: { timeout_ms: 50 } })]),
      new Map([['c', stats({})]])
    )
    expect(out).toEqual([])
  })

  it('does not flag with thin history', () => {
    const out = findUnderProvisionedNodes(
      def([node({ id: 'equifax', type: 'code', config: { timeout_ms: 4000 } })]),
      new Map([['equifax', stats({ sample_size: 9 })]])
    )
    expect(out).toEqual([])
  })

  it('respects per-node retries: 0 retries compares against max', () => {
    const out = findUnderProvisionedNodes(
      def([node({ id: 'equifax', type: 'code', config: { timeout_ms: 10000, retries: 0 } })]),
      new Map([['equifax', stats({})]])
    )
    // suggested without retries = max(7500, 11550) -> 11750; 10000 < max -> red
    expect(out[0]).toMatchObject({ suggested_ms: 11750, severity: 'red' })
  })
})

describe('warningsSignature with the five day findings (#2934)', () => {
  const period = [{
    workflow_id: 'wf1',
    workflow_name: 'Main Flow',
    findings: [{
      kind: 'losing_runs' as const, node_id: 'n1', namespace: 'n1', label: null, type: 'salesforce',
      configured_ms: 4500, retries: 0, timed_out: 7, latest_at: '2026-10-29T06:25:00.000Z', burst: null, suggested_ms: null,
    }],
  }]

  it('is stable when only the counts change', () => {
    const more = [{ ...period[0], findings: [{ ...period[0].findings[0], timed_out: 9, latest_at: '2026-10-29T08:00:00.000Z' }] }]
    expect(warningsSignature([], more)).toBe(warningsSignature([], period))
  })

  it('changes when the configured value changes', () => {
    const changed = [{ ...period[0], findings: [{ ...period[0].findings[0], configured_ms: 8000 }] }]
    expect(warningsSignature([], changed)).not.toBe(warningsSignature([], period))
  })
})

describe('collectWorkflowDurationStats', () => {
  type RpcResult = { data: unknown; error: unknown }
  function fakeClient(results: RpcResult[]) {
    let i = 0
    const rpc = vi.fn().mockImplementation(() => Promise.resolve(results[Math.min(i++, results.length - 1)]))
    return { client: { rpc } as unknown as Parameters<typeof collectWorkflowDurationStats>[0], rpc }
  }

  it('stops after one window when every namespace clears the confident sample', async () => {
    const { client, rpc } = fakeClient([
      { data: [{ step_namespace: 'a', p99: 100, max_ms: 200, sample_size: 5000 }], error: null },
    ])
    const { stats, windowDays } = await collectWorkflowDurationStats(client, 'wf-1', ['a'])
    expect(rpc).toHaveBeenCalledTimes(1)
    // The grouped RPC samples per namespace, so the caller supplies the list.
    expect(rpc).toHaveBeenCalledWith('step_duration_percentiles_by_workflow', expect.objectContaining({ p_namespaces: ['a'] }))
    expect(windowDays).toBeLessThan(1)
    expect(stats.get('a')).toMatchObject({ p99: 100, max_ms: 200, sample_size: 5000 })
  })

  it('locks a confident namespace at its first window while widening for thin ones', async () => {
    const { client, rpc } = fakeClient([
      { data: [
        { step_namespace: 'busy', p99: 400, max_ms: 450, sample_size: 1000 },
        { step_namespace: 'quiet', p99: 50, max_ms: 60, sample_size: 22 },
      ], error: null },
      { data: [
        { step_namespace: 'busy', p99: 9000, max_ms: 9999, sample_size: 4000 },
        { step_namespace: 'quiet', p99: 739, max_ms: 1250, sample_size: 166 },
      ], error: null },
    ])
    const { stats } = await collectWorkflowDurationStats(client, 'wf-1', ['busy', 'quiet'])
    expect(rpc).toHaveBeenCalledTimes(3)
    // busy locked at window 1; quiet kept widening and took the later stats
    expect(stats.get('busy')).toMatchObject({ p99: 400, max_ms: 450, sample_size: 1000 })
    expect(stats.get('quiet')).toMatchObject({ p99: 739, max_ms: 1250, sample_size: 166 })
  })

  it('degrades on RPC error, keeping the narrower windows results', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, rpc } = fakeClient([
      { data: [{ step_namespace: 'a', p99: 100, max_ms: 200, sample_size: 22 }], error: null },
      { data: null, error: { message: 'statement timeout' } },
    ])
    const { stats, windowDays } = await collectWorkflowDurationStats(client, 'wf-1', ['a'])
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(windowDays).toBeLessThan(1)
    expect(stats.get('a')).toMatchObject({ p99: 100, max_ms: 200, sample_size: 22 })
    warn.mockRestore()
  })

  // 1.1: the grouped query over a high-volume workflow's full namespace list is
  // what times out at the 8s gateway limit (Main Flow: 7d ~ 11s across 80
  // namespaces). The expensive scans are the busy namespaces — which lock at the
  // first window — so widening must drop them and re-query only the thin ones.
  it('queries only the still-unlocked namespaces when widening to a larger window', async () => {
    const { client, rpc } = fakeClient([
      { data: [
        { step_namespace: 'busy', p99: 400, max_ms: 450, sample_size: 1000 },
        { step_namespace: 'quiet', p99: 50, max_ms: 60, sample_size: 22 },
      ], error: null },
      { data: [
        { step_namespace: 'quiet', p99: 739, max_ms: 1250, sample_size: 5000 },
      ], error: null },
    ])
    await collectWorkflowDurationStats(client, 'wf-1', ['busy', 'quiet'])
    expect(rpc).toHaveBeenNthCalledWith(1, 'step_duration_percentiles_by_workflow', expect.objectContaining({ p_namespaces: ['busy', 'quiet'] }))
    expect(rpc).toHaveBeenNthCalledWith(2, 'step_duration_percentiles_by_workflow', expect.objectContaining({ p_namespaces: ['quiet'] }))
  })

  // 1.3: a silently-swallowed widening timeout is exactly what hid this bug for
  // weeks. The fallback must leave a trace.
  it('logs a warning when a widening query fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client } = fakeClient([
      { data: [{ step_namespace: 'a', p99: 100, max_ms: 200, sample_size: 22 }], error: null },
      { data: null, error: { message: 'canceling statement due to statement timeout' } },
    ])
    await collectWorkflowDurationStats(client, 'wf-1', ['a'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('wf-1')
    expect(String(warn.mock.calls[0][0])).toContain('statement timeout')
    warn.mockRestore()
  })
})

describe('collectPeriodStats (#2934)', () => {
  const NOW = new Date('2026-10-29T08:17:00.000Z')

  function recordingClient(answer: (args: { p_namespaces: string[] }) => { data: unknown; error: unknown }) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
    const supabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args })
        return answer(args as { p_namespaces: string[] })
      },
    } as unknown as SupabaseClient
    return { supabase, calls }
  }

  it('reads the five days before now, ten finished runs an hour, at most ten steps a call', async () => {
    const namespaces = Array.from({ length: 23 }, (_, i) => `s${i}`)
    const { supabase, calls } = recordingClient(({ p_namespaces }) => ({
      data: p_namespaces.map((ns) => ({ step_namespace: ns, p50: 1, p99: 2, max_ms: 3, sample_size: 4, timed_out: 0, timed_out_at: [] })),
      error: null,
    }))
    const stats = await collectPeriodStats(supabase, 'wf', namespaces, NOW)
    expect(calls.map((c) => c.fn)).toEqual(Array(3).fill('step_timeout_audit_by_workflow'))
    expect(calls.map((c) => (c.args.p_namespaces as string[]).length)).toEqual([10, 10, 3])
    expect(calls[0].args).toMatchObject({
      p_workflow_id: 'wf',
      p_since: new Date(NOW.getTime() - AUDIT_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      p_until: NOW.toISOString(),
      p_per_hour: 10,
    })
    expect(stats?.size).toBe(23)
  })

  it('reads each step once, however often the definition names it', async () => {
    const { supabase, calls } = recordingClient(() => ({ data: [], error: null }))
    await collectPeriodStats(supabase, 'wf', ['a', 'a', 'b'], NOW)
    expect(calls[0].args.p_namespaces).toEqual(['a', 'b'])
  })

  it('takes the counts as numbers, whatever type PostgREST answers a bigint in', async () => {
    const { supabase } = recordingClient(() => ({
      data: [{ step_namespace: 'a', p50: null, p99: null, max_ms: null, sample_size: '0', timed_out: '7', timed_out_at: ['2026-10-29T06:25:08.989Z'] }],
      error: null,
    }))
    const stats = await collectPeriodStats(supabase, 'wf', ['a'], NOW)
    expect(stats?.get('a')).toEqual({ p50: null, p99: null, max_ms: null, sample_size: 0, timed_out: 7, timed_out_at: ['2026-10-29T06:25:08.989Z'] })
  })

  it('answers nothing, and names the failure, when a count does not parse, never a quiet zero', async () => {
    const { supabase } = recordingClient(() => ({
      data: [{ step_namespace: 'a', p50: 1, p99: 2, max_ms: 3, sample_size: 40, timed_out: 'seven', timed_out_at: [] }],
      error: null,
    }))
    const failures: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await collectPeriodStats(supabase, 'wf', ['a'], NOW, failures)).toBeNull()
    expect(failures).toEqual(['five day step timeouts for workflow wf'])
    error.mockRestore()
  })

  it('answers nothing, and names the failure, when any call fails, so the org is not judged on part of a workflow', async () => {
    let n = 0
    const { supabase } = recordingClient(() => (++n === 2 ? { data: null, error: { message: 'canceling statement due to statement timeout' } } : { data: [], error: null }))
    const failures: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stats = await collectPeriodStats(supabase, 'wf', Array.from({ length: 15 }, (_, i) => `s${i}`), NOW, failures)
    expect(stats).toBeNull()
    expect(failures).toEqual(['five day step timeouts for workflow wf'])
    expect(String(error.mock.calls[0][0])).toContain('statement timeout')
    error.mockRestore()
  })
})

// Issue #81: the dedup signature must be recorded only after a confirmed Slack
// send (and for an all-clear transition), so a disabled org or a transient send
// failure doesn't permanently swallow the alert for a config-warning state.
describe('runTimeoutAuditCheck — signature recorded only after a delivered alert', () => {
  const subFloorWf = { id: 'wf1', name: 'Engine Bidding', definition: def([node({ id: 'n', type: 'code', config: { timeout_ms: 50 } })]) }
  const cleanWf = { id: 'wf2', name: 'Clean', definition: def([node({ id: 'n', type: 'code', config: { timeout_ms: 1000 } })]) }

  function makeSupabase(workflows: unknown[], orgs = ['org-1']) {
    return {
      from: (table: string) => {
        // The workflows read is organization scoped (readOrgWorkflows, #2142) and
        // checks each row's organization_id and deleted_at, so the double answers
        // rows of the organization the query filtered on, as PostgREST would.
        let orgFilter: unknown = null
        const rows = () => table === 'service_connections'
          ? orgs.map((id) => ({ organization_id: id }))
          : table === 'workflows'
            ? (workflows as Array<Record<string, unknown>>).map((w) => ({ is_active: true, deleted_at: null, ...w, organization_id: orgFilter }))
            : []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = new Proxy({}, {
          get(_, prop) {
            if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(res)
            if (prop === 'eq') return (col: string, val: unknown) => { if (col === 'organization_id') orgFilter = val; return chain }
            return () => chain
          },
        })
        return chain
      },
      rpc: () => Promise.resolve({ data: [], error: null }),
    } as unknown as SupabaseClient
  }

  function makeKv(seed: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(seed))
    return {
      store,
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    }
  }

  const enabled = { bot_token: 't', default_channel: 'c', config_alerts_enabled: true }

  beforeEach(() => vi.clearAllMocks())

  it('records the signature after a successful send', async () => {
    vi.mocked(getSlackConnection).mockResolvedValue(enabled as never)
    vi.mocked(sendTimeoutConfigAlert).mockResolvedValue(undefined as never)
    const kv = makeKv()
    await runTimeoutAuditCheck(makeSupabase([subFloorWf]), kv, 'https://app')
    expect(vi.mocked(sendTimeoutConfigAlert)).toHaveBeenCalledTimes(1)
    expect(kv.put).toHaveBeenCalled()
  })

  it('does NOT record the signature when the send fails (so it retries next run)', async () => {
    vi.mocked(getSlackConnection).mockResolvedValue(enabled as never)
    vi.mocked(sendTimeoutConfigAlert).mockRejectedValue(new Error('Slack 429'))
    const kv = makeKv()
    await expect(runTimeoutAuditCheck(makeSupabase([subFloorWf]), kv, 'https://app')).resolves.toBeUndefined()
    expect(vi.mocked(sendTimeoutConfigAlert)).toHaveBeenCalledTimes(1)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('does NOT record the signature when alerts are disabled (so re-enabling fires)', async () => {
    vi.mocked(getSlackConnection).mockResolvedValue({ ...enabled, config_alerts_enabled: false } as never)
    const kv = makeKv()
    await runTimeoutAuditCheck(makeSupabase([subFloorWf]), kv, 'https://app')
    expect(vi.mocked(sendTimeoutConfigAlert)).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('records an all-clear transition without sending', async () => {
    vi.mocked(getSlackConnection).mockResolvedValue(enabled as never)
    // Seed a stale prior signature so the now-clean state is a real transition.
    const kv = makeKv({ 'timeout-audit:sig:org-1': 'STALE-PRIOR-SIGNATURE' })
    await runTimeoutAuditCheck(makeSupabase([cleanWf]), kv, 'https://app')
    expect(vi.mocked(sendTimeoutConfigAlert)).not.toHaveBeenCalled()
    expect(kv.put).toHaveBeenCalled()
  })

  it('runs the percentile queries a few at a time, never all workflows at once (#1884)', async () => {
    // On 2026-10-08 at 08:15 UTC the audit fired about a dozen of these grouped
    // percentile queries in the same instant, the slowest took 23.5 s, and lead
    // requests slowed to 8.5 s behind them.
    vi.mocked(getSlackConnection).mockResolvedValue(null as never)
    const workflows = Array.from({ length: 7 }, (_, i) => ({
      id: `wf${i}`,
      name: `Workflow ${i}`,
      definition: def([node({ id: `n${i}`, type: 'code', config: { timeout_ms: 1000 } })]),
    }))
    const supabase = makeSupabase(workflows)
    let inFlight = 0
    let peak = 0
    const asked: string[] = []
    ;(supabase as unknown as { rpc: unknown }).rpc = async (_fn: string, args: { p_workflow_id: string }) => {
      asked.push(args.p_workflow_id)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      // One turn of the microtask queue: every call already started has
      // incremented before any finishes, so an unbounded fan out reads as 7.
      await Promise.resolve()
      inFlight -= 1
      return { data: [], error: null }
    }
    await runTimeoutAuditCheck(supabase, makeKv(), 'https://app')
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(TIMEOUT_AUDIT_RPC_CONCURRENCY)
    // Every workflow is still measured: the bound slows the pass, it never thins it.
    expect(new Set(asked)).toEqual(new Set(workflows.map((w) => w.id)))
  })

  it('2026-10-29 4:17 AM ET: alerts a no retries step that lost runs to its timeout', async () => {
    // Main Flow's Credit Collections, as production measured it: 7 runs failed on
    // its 4,500 ms timeout, and of the runs that finished the slowest took 3,427 ms.
    // The alert that night judged only finished runs and did not list it.
    vi.mocked(getSlackConnection).mockResolvedValue(enabled as never)
    vi.mocked(sendTimeoutConfigAlert).mockResolvedValue(undefined as never)
    const mainFlow = { id: 'wf-main', name: 'Main Flow', definition: def([node({ id: 'collections_apex', type: 'salesforce', label: 'Credit Collections', config: { timeout_ms: 4500, retries: 0 } })]) }
    const supabase = makeSupabase([mainFlow])
    ;(supabase as unknown as { rpc: unknown }).rpc = async (fn: string) => fn === 'step_timeout_audit_by_workflow'
      ? { data: [{ step_namespace: 'collections_apex', p50: 900, p99: 2636, max_ms: 3427, sample_size: 475, timed_out: 7, timed_out_at: [
        '2026-10-28T15:52:01Z', '2026-10-28T15:52:10Z', '2026-10-28T15:52:20Z', '2026-10-28T15:52:30Z', '2026-10-28T15:53:00Z', '2026-10-28T16:36:00Z', '2026-10-29T06:25:08Z',
      ] }], error: null }
      : { data: [{ step_namespace: 'collections_apex', p50: 900, p99: 2774, max_ms: 4198, sample_size: 2624 }], error: null }
    await runTimeoutAuditCheck(supabase, makeKv(), 'https://app')
    expect(vi.mocked(sendTimeoutConfigAlert)).toHaveBeenCalledTimes(1)
    const [, , period] = vi.mocked(sendTimeoutConfigAlert).mock.calls[0]
    expect(period).toEqual([expect.objectContaining({
      workflow_name: 'Main Flow',
      findings: [expect.objectContaining({ kind: 'losing_runs', namespace: 'collections_apex', timed_out: 7, retries: 0 })],
    })])
  })

  it("one org's send failure does not abort the remaining orgs", async () => {
    vi.mocked(getSlackConnection).mockResolvedValue(enabled as never)
    vi.mocked(sendTimeoutConfigAlert)
      .mockRejectedValueOnce(new Error('Slack 429'))
      .mockResolvedValueOnce(undefined as never)
    const kv = makeKv()
    await runTimeoutAuditCheck(makeSupabase([subFloorWf], ['org-1', 'org-2']), kv, 'https://app')
    expect(vi.mocked(sendTimeoutConfigAlert)).toHaveBeenCalledTimes(2) // loop continued past the failure
  })
})

describe('mapWithConcurrency', () => {
  it('keeps input order whatever order the calls finish in', async () => {
    // Each call yields a different number of microtask turns, so they finish
    // out of order without any real wait.
    const finished: number[] = []
    const out = await mapWithConcurrency([30, 5, 20, 1], 2, async (turns) => {
      for (let i = 0; i < turns; i++) await Promise.resolve()
      finished.push(turns)
      return turns
    })
    expect(finished).not.toEqual([30, 5, 20, 1])
    expect(out).toEqual([30, 5, 20, 1])
  })

  it('rejects when any call rejects, as Promise.all does', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('rpc refused')
        return n
      }),
    ).rejects.toThrow('rpc refused')
  })

  it('refuses a limit below one rather than running nothing', async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(/limit must be at least 1/)
  })
})
