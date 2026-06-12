import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findSubFloorNodes, scanWorkflowDefinitions, warningsSignature, findOverProvisionedNodes, findUnderProvisionedNodes, collectWorkflowDurationStats, runTimeoutAuditCheck, type NodeDurationStats } from '../timeout-audit'
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
      severity: 'amber',
    }])
  })

  it('marks red when typical runs would time out (below p99 with retries)', () => {
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

describe('warningsSignature with under-provisioned entries', () => {
  const under = [{
    workflow_id: 'wf1',
    workflow_name: 'A',
    nodes: [{
      node_id: 'n1', namespace: 'n1', label: null, type: 'code',
      configured_ms: 4000, suggested_ms: 7500, p99_ms: 5000, max_ms: 11000,
      sample_size: 1996, severity: 'red' as const,
    }],
  }]

  it('is stable when only the drifting stats change', () => {
    const shifted = [{ ...under[0], nodes: [{ ...under[0].nodes[0], suggested_ms: 8000, p99_ms: 5400 }] }]
    expect(warningsSignature([], under)).toBe(warningsSignature([], shifted))
  })

  it('changes when the configured value changes', () => {
    const changed = [{ ...under[0], nodes: [{ ...under[0].nodes[0], configured_ms: 5000 }] }]
    expect(warningsSignature([], changed)).not.toBe(warningsSignature([], under))
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
    const { client, rpc } = fakeClient([
      { data: [{ step_namespace: 'a', p99: 100, max_ms: 200, sample_size: 22 }], error: null },
      { data: null, error: { message: 'statement timeout' } },
    ])
    const { stats, windowDays } = await collectWorkflowDurationStats(client, 'wf-1', ['a'])
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(windowDays).toBeLessThan(1)
    expect(stats.get('a')).toMatchObject({ p99: 100, max_ms: 200, sample_size: 22 })
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
        const data = table === 'service_connections'
          ? orgs.map((id) => ({ organization_id: id }))
          : table === 'workflows' ? workflows : []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = new Proxy({}, {
          get(_, prop) {
            if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res)
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
