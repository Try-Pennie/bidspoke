/**
 * The Tripoint outage page keeps firing once an unknown Tripoint answer stops
 * failing the run (#1540).
 *
 * Before #1540 a proxy 5xx made tripoint_ping throw, the run failed with
 * "Tripoint proxy 5..", and the aggregated check counted those failed runs
 * under the `tripoint` cause. Now the same answer is a normal reject, so no run
 * fails and the check would go quiet exactly when Tripoint is down. So it also
 * counts tripoint_ping steps whose answer is unknown, under the same cause, the
 * same page and the same cooldown, and never counts one execution twice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../slack', () => ({
  sendUpstreamOutageAlert: vi.fn().mockResolvedValue('ts-1'),
  sendFailureSaturationAlert: vi.fn().mockResolvedValue(true),
}))
import {
  runUpstreamOutageCheck,
  groupOutages,
  tripointUnknownRows,
  DEFAULT_OUTAGE_THRESHOLD,
  TRIPOINT_ANSWER_NAMESPACE,
} from '../upstream-outage'
import { sendUpstreamOutageAlert, sendFailureSaturationAlert } from '../slack'

type Filter = [string, string, unknown]

/** A Supabase double that answers per table and records every filter applied to each read, so the query shape is asserted, not assumed. */
function recordingSupabase(tables: Record<string, unknown[]>, errors: Record<string, string> = {}) {
  const reads: Record<string, Filter[][]> = {}
  return {
    reads,
    rpc: (name: string) => {
      if (name !== 'execution_counts_per_minute') throw new Error(`unexpected rpc: ${name}`)
      return Promise.resolve({ data: tables.__runTotals ?? [], error: null })
    },
    from: (table: string) => {
      const filters: Filter[] = []
      ;(reads[table] ??= []).push(filters)
      let range: [number, number] | null = null
      const chain: Record<string, unknown> = {}
      for (const op of ['select', 'eq', 'or', 'in', 'gte', 'lt', 'is', 'not', 'order', 'filter', 'limit']) {
        chain[op] = (...args: unknown[]) => { filters.push([op, String(args[0]), args.slice(1)]); return chain }
      }
      chain.range = (from: number, to: number) => { range = [from, to]; return chain }
      chain.then = (res: (v: unknown) => unknown) => {
        const all = tables[table] ?? []
        const data = range ? all.slice(range[0], range[1] + 1) : all
        return Promise.resolve(errors[table] ? { data: null, error: { message: errors[table] } } : { data, error: null }).then(res)
      }
      return chain
    },
  }
}

function makeKv() {
  const m = new Map<string, string>()
  return {
    store: m,
    get: vi.fn(async (k: string) => m.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { m.set(k, v) }),
  }
}

const recent = () => new Date(Date.now() - 10_000).toISOString()
const unknownStep = (execution_id: string, reason = 'http_504', workflow_id = 'wf-1') => ({
  execution_id, workflow_id, started_at: recent(), completed_at: recent(), unknown_reason: reason,
})
const base = {
  service_connections: [{ organization_id: 'org-1' }],
  workflows: [{ id: 'wf-1', name: 'Engine Bidding Workflow', organization_id: 'org-1' }],
}

describe('the aggregated check counts unknown Tripoint answers (#1540)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a burst of unknown answers pages exactly once, as Tripoint, with the Tripoint cooldown', async () => {
    const kv = makeKv()
    const steps = [
      ...Array.from({ length: 6 }, (_, i) => unknownStep(`e-504-${i}`, 'http_504')),
      ...Array.from({ length: 3 }, (_, i) => unknownStep(`e-to-${i}`, 'timeout')),
      unknownStep('e-403', 'http_403'),
      unknownStep('e-bad', 'unparseable_body'),
    ]
    expect(steps.length).toBeGreaterThanOrEqual(DEFAULT_OUTAGE_THRESHOLD)
    const sb = recordingSupabase({ ...base, workflow_executions: [], execution_steps: steps })
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')

    expect(sendUpstreamOutageAlert).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(sendUpstreamOutageAlert).mock.calls[0][2]
    expect(payload).toMatchObject({ cause_key: 'tripoint', cause_label: 'Tripoint', failure_count: steps.length, workflow_names: ['Engine Bidding Workflow'] })
    // The dominant shape names what went wrong, and it reads as Tripoint being unwell.
    expect(payload.error_shapes?.[0]?.sample).toContain('Tripoint answer unknown')
    expect(payload.how_to_check).toContain('Confirm Tripoint health')
    expect(kv.store.has('upstream-outage-cooldown:org-1:tripoint')).toBe(true)
    // These runs did not fail, so they say nothing to saturation.
    expect(sendFailureSaturationAlert).not.toHaveBeenCalled()
  })

  it('shares one page and one count with Tripoint 5xx failures from the older script, counting each execution once', async () => {
    const kv = makeKv()
    // Half the burst fails the old way (a pasted older script, or a retry), half is unknown the new way,
    // and two executions appear on both sides.
    const failed = Array.from({ length: 5 }, (_, i) => ({ id: `e-${i}`, workflow_id: 'wf-1', error_message: 'Tripoint proxy 504: upstream timeout', started_at: recent(), completed_at: recent() }))
    const steps = [unknownStep('e-0'), unknownStep('e-1'), ...Array.from({ length: 5 }, (_, i) => unknownStep(`e-new-${i}`))]
    const sb = recordingSupabase({ ...base, workflow_executions: failed, execution_steps: steps })
    await runUpstreamOutageCheck(sb as never, kv as never, 'https://app.example.com')
    expect(sendUpstreamOutageAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendUpstreamOutageAlert).mock.calls[0][2]).toMatchObject({ cause_key: 'tripoint', failure_count: 10 })
  })

  it('stays quiet below the threshold, and while the Tripoint cooldown is set', async () => {
    const few = recordingSupabase({ ...base, workflow_executions: [], execution_steps: Array.from({ length: DEFAULT_OUTAGE_THRESHOLD - 1 }, (_, i) => unknownStep(`e-${i}`)) })
    await runUpstreamOutageCheck(few as never, makeKv() as never, 'https://app.example.com')
    const many = recordingSupabase({ ...base, workflow_executions: [], execution_steps: Array.from({ length: DEFAULT_OUTAGE_THRESHOLD }, (_, i) => unknownStep(`e-${i}`)) })
    const cooling = makeKv()
    cooling.store.set('upstream-outage-cooldown:org-1:tripoint', '1')
    await runUpstreamOutageCheck(many as never, cooling as never, 'https://app.example.com')
    expect(sendUpstreamOutageAlert).not.toHaveBeenCalled()
  })

  it('reads only tripoint_ping steps answered unknown, live, in the active workflows, bounded on started_at so the partitions prune', async () => {
    const sb = recordingSupabase({ ...base, workflow_executions: [], execution_steps: [] })
    await runUpstreamOutageCheck(sb as never, makeKv() as never, 'https://app.example.com')
    const reads = sb.reads.execution_steps
    expect(reads).toHaveLength(1)
    const f = reads[0]
    const has = (op: string, col: string, val?: unknown) =>
      f.some(([o, c, rest]) => o === op && c === col && (val === undefined || JSON.stringify((rest as unknown[])[0]) === JSON.stringify(val)))
    expect(has('eq', 'step_namespace', TRIPOINT_ANSWER_NAMESPACE)).toBe(true)
    expect(TRIPOINT_ANSWER_NAMESPACE).toBe('tripoint_ping')
    expect(has('eq', 'output->>tripoint_answer', 'unknown')).toBe(true)
    expect(has('eq', 'is_test', false)).toBe(true)
    expect(has('in', 'workflow_id', ['wf-1'])).toBe(true)
    expect(has('gte', 'started_at')).toBe(true)
    // Paged with a stable order, like every full read of this table.
    expect(has('order', 'started_at')).toBe(true)
    expect(has('order', 'id')).toBe(true)
  })

  it('pages past the 1,000 row cap rather than stopping at the first page', async () => {
    const steps = Array.from({ length: 1_200 }, (_, i) => unknownStep(`e-${i}`))
    const sb = recordingSupabase({ ...base, workflow_executions: [], execution_steps: steps })
    await runUpstreamOutageCheck(sb as never, makeKv() as never, 'https://app.example.com')
    expect(vi.mocked(sendUpstreamOutageAlert).mock.calls[0][2]).toMatchObject({ failure_count: 1_200 })
  })

  it('a failed read of the steps still lets the failed runs page, and says so in the log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = Array.from({ length: DEFAULT_OUTAGE_THRESHOLD }, (_, i) => ({ id: `e-${i}`, workflow_id: 'wf-1', error_message: 'Tripoint proxy 504', started_at: recent(), completed_at: recent() }))
    const sb = recordingSupabase({ ...base, workflow_executions: failed, execution_steps: [] }, { execution_steps: 'statement timeout' })
    await runUpstreamOutageCheck(sb as never, makeKv() as never, 'https://app.example.com')
    expect(sendUpstreamOutageAlert).toHaveBeenCalledTimes(1)
    expect(error.mock.calls.some((c) => String(c[0]).includes('tripoint answers'))).toBe(true)
    error.mockRestore()
  })
})

describe('tripointUnknownRows (#1540)', () => {
  it('turns each unknown step into a Tripoint row whose message names the reason, and drops executions already counted as Tripoint failures', () => {
    const rows = tripointUnknownRows(
      [unknownStep('a', 'http_504'), unknownStep('b', 'timeout'), unknownStep('c', 'network_error'), unknownStep('d', 'http_403')],
      [{ id: 'c', workflow_id: 'wf-1', error_message: 'Tripoint proxy 502', completed_at: recent() }],
    )
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'd'])
    expect(rows.map((r) => r.error_message)).toEqual([
      'Tripoint answer unknown (504)',
      'Tripoint answer unknown: timed out after 15 s',
      'Tripoint answer unknown (403)',
    ])
    expect(rows.every((r) => r.cause_key === 'tripoint')).toBe(true)
  })

  it('keeps an unknown answer whose run failed for another cause, since that failure counts elsewhere', () => {
    const rows = tripointUnknownRows([unknownStep('a')], [{ id: 'a', workflow_id: 'wf-1', error_message: 'Salesforce API error (520)', completed_at: recent() }])
    expect(rows.map((r) => r.id)).toEqual(['a'])
  })

  it('is attributed to the Tripoint cause by the check itself, whatever its message says', () => {
    const [row] = tripointUnknownRows([unknownStep('a', 'something new')], [])
    const groups = groupOutages([row], new Map([['wf-1', 'Engine Bidding Workflow']]), Date.now() - 60_000)
    expect(groups).toHaveLength(1)
    expect(groups[0].cause.key).toBe('tripoint')
  })

  it('a step with no completion time is outside every window, never counted', () => {
    const [row] = tripointUnknownRows([{ ...unknownStep('a'), completed_at: null }], [])
    expect(groupOutages([row], new Map(), Date.now() - 60_000)).toEqual([])
  })
})
