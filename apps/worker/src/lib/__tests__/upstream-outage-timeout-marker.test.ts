/**
 * The "Upstream timeout" bucket reads the failing step's deadline marker, not
 * the run's message (#3069, L35).
 *
 * Since #3047 the engine marks a step one of our deadlines stopped on its row
 * (`execution_steps.timeout_kind`: 'step' for the step's own deadline,
 * 'parallel_block' for its block's). The aggregated outage check now reads that
 * marker for each failed run's failing step. The old substrings stay only as the
 * fallback for a run whose failing step carries no marker (#3067 removes it).
 *
 * A gateway timeout (an upstream answering 504) is the upstream's own answer,
 * not our deadline: it never carries a marker, and the fallback names no 504
 * wording, so it is never an "Upstream timeout". The step row records no HTTP
 * status as a field of its own (the status is only inside the message), so a
 * 504 keeps the bucket it had: Salesforce's by its own words, otherwise none.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../slack', () => ({
  sendUpstreamOutageAlert: vi.fn().mockResolvedValue('ts-1'),
  sendFailureSaturationAlert: vi.fn().mockResolvedValue(true),
}))
import {
  classifyOutageCause,
  attributeOutageCause,
  failingStepDeadline,
  groupOutages,
  runUpstreamOutageCheck,
  UPSTREAM_OUTAGE_CAUSES,
  DEFAULT_OUTAGE_THRESHOLD,
  type MarkedFailedStep,
} from '../upstream-outage'
import { STEP_DEADLINE, PARALLEL_BLOCK_DEADLINE, stepTimeoutMessage } from '../../engine/step-timeout'
import { sendUpstreamOutageAlert } from '../slack'

// A message no text matcher of any cause recognises, so only the marker can
// put a run carrying it in the timeout bucket.
const UNRECOGNISED = 'Workflow returned HTTP 500'

describe('classifyOutageCause reads the failing step marker first (#3069)', () => {
  it('a run whose failing step its own deadline stopped is an upstream timeout, whatever the message says', () => {
    expect(classifyOutageCause(UNRECOGNISED, UPSTREAM_OUTAGE_CAUSES, STEP_DEADLINE)?.key).toBe('timeout')
    expect(classifyOutageCause(null, UPSTREAM_OUTAGE_CAUSES, STEP_DEADLINE)?.key).toBe('timeout')
  })

  it('so is a run whose failing step its parallel block stopped waiting for', () => {
    expect(classifyOutageCause(UNRECOGNISED, UPSTREAM_OUTAGE_CAUSES, PARALLEL_BLOCK_DEADLINE)?.key).toBe('timeout')
  })

  it('the same message with no marker is not an outage at all', () => {
    expect(classifyOutageCause(UNRECOGNISED)).toBeNull()
    expect(classifyOutageCause(UNRECOGNISED, UPSTREAM_OUTAGE_CAUSES, null)).toBeNull()
  })

  it('a named upstream in the message still wins, as it did over the timeout text', () => {
    expect(classifyOutageCause('Salesforce API error (503): unavailable', UPSTREAM_OUTAGE_CAUSES, STEP_DEADLINE)?.key).toBe('salesforce')
  })

  it('keeps classifying an unmarked run by its message, for runs written before the marker', () => {
    expect(classifyOutageCause(stepTimeoutMessage(8_000))?.key).toBe('timeout')
    expect(classifyOutageCause('Parallel failed: child "trades_body" did not complete in time')?.key).toBe('timeout')
    expect(classifyOutageCause('Parallel node timed out, 2 child(ren) did not settle within 15000ms')?.key).toBe('timeout')
    expect(classifyOutageCause('The operation was aborted')?.key).toBe('timeout')
  })

  it('a generic timeout re-attributed to Salesforce by its node type stays so when it is read from the marker', () => {
    expect(attributeOutageCause(UNRECOGNISED, 'salesforce', UPSTREAM_OUTAGE_CAUSES, STEP_DEADLINE)?.key).toBe('salesforce')
    expect(attributeOutageCause(UNRECOGNISED, 'code', UPSTREAM_OUTAGE_CAUSES, STEP_DEADLINE)?.key).toBe('timeout')
  })
})

describe('a gateway timeout is the upstream answering, never our deadline (#3069)', () => {
  it('a 504 is never put in the timeout bucket, marked or by text', () => {
    expect(classifyOutageCause('HTTP 504: <html>Gateway Timeout</html>')).toBeNull()
    expect(classifyOutageCause('HTTP 504 Gateway Timeout')).toBeNull()
    expect(classifyOutageCause('Code returned error response: HTTP 504')).toBeNull()
  })

  it('a Salesforce 504 stays Salesforce, by Salesforce naming itself', () => {
    expect(classifyOutageCause('Salesforce API error (504): error code: 504')?.key).toBe('salesforce')
  })

  it('the text fallback names nothing a 504 says, so it cannot take one in either', () => {
    const timeout = UPSTREAM_OUTAGE_CAUSES.find((c) => c.key === 'timeout')
    const fallback = timeout?.unmarkedFallback ?? []
    expect(fallback.length).toBeGreaterThan(0)
    for (const m of fallback) expect(m).not.toMatch(/504|gateway/i)
    // The timeout bucket has no matcher of its own any more: only the marker, or the fallback.
    expect(timeout?.matchers).toEqual([])
  })
})

const marked = (execution_id: string, step_type: string, timeout_kind: unknown, parallel_group_id: string | null = null): MarkedFailedStep =>
  ({ execution_id, step_type, timeout_kind, parallel_group_id })

describe('failingStepDeadline binds a marker to the step the run failed on (#3069)', () => {
  it('reads the marker of the failed step of the run\'s own failing node type', () => {
    expect(failingStepDeadline({ id: 'e1', failed_step_type: 'code' }, [marked('e1', 'code', STEP_DEADLINE)])).toBe(STEP_DEADLINE)
  })

  it('reads a marked step inside a block when the run failed on its parallel block', () => {
    expect(failingStepDeadline({ id: 'e1', failed_step_type: 'parallel' }, [marked('e1', 'code', STEP_DEADLINE, 'block-1')])).toBe(STEP_DEADLINE)
    expect(failingStepDeadline({ id: 'e1', failed_step_type: 'parallel' }, [marked('e1', 'webhook', PARALLEL_BLOCK_DEADLINE, 'block-1')])).toBe(PARALLEL_BLOCK_DEADLINE)
  })

  it('ignores a marked step the run did not fail on, such as an earlier one a bid group absorbed', () => {
    expect(failingStepDeadline({ id: 'e1', failed_step_type: 'response' }, [marked('e1', 'partner_bid', STEP_DEADLINE, 'group-1')])).toBeNull()
    expect(failingStepDeadline({ id: 'e1', failed_step_type: 'response' }, [marked('e1', 'code', STEP_DEADLINE)])).toBeNull()
  })

  it('ignores another run\'s marker, a value the engine never writes, and a run with no failing step recorded', () => {
    expect(failingStepDeadline({ id: 'e1', failed_step_type: 'code' }, [marked('e2', 'code', STEP_DEADLINE)])).toBeNull()
    expect(failingStepDeadline({ id: 'e1', failed_step_type: 'code' }, [marked('e1', 'code', 'gateway')])).toBeNull()
    expect(failingStepDeadline({ id: 'e1', failed_step_type: null }, [marked('e1', 'code', STEP_DEADLINE)])).toBeNull()
    expect(failingStepDeadline({ failed_step_type: 'code' }, [marked('e1', 'code', STEP_DEADLINE)])).toBeNull()
  })

  it('groupOutages counts a run by its failing step marker', () => {
    const rows: Parameters<typeof groupOutages>[0] = [{ id: 'e1', workflow_id: 'wf-1', error_message: UNRECOGNISED, completed_at: new Date().toISOString(), failing_step_deadline: STEP_DEADLINE }]
    const groups = groupOutages(rows, new Map([['wf-1', 'Engine']]), Date.now() - 60_000)
    expect(groups.map((g) => [g.cause.key, g.count])).toEqual([['timeout', 1]])
  })
})

// ── The check itself ─────────────────────────────────────────────────────────

type Filter = [string, string, unknown[]]

/**
 * A Supabase double that tells the two execution_steps reads apart by the
 * columns they select (the marker read names timeout_kind, the Tripoint read
 * does not), and records every filter each read applied.
 */
function stepsDouble(opts: { failed: unknown[]; markers: unknown[]; markerError?: string }) {
  const markerReads: Filter[][] = []
  const tables: Record<string, unknown[]> = {
    service_connections: [{ organization_id: 'org-1' }],
    workflows: [{ id: 'wf-1', name: 'Engine Bidding Workflow', organization_id: 'org-1' }],
    workflow_executions: opts.failed,
  }
  return {
    markerReads,
    rpc: (name: string) => {
      if (name !== 'execution_counts_per_minute') throw new Error(`unexpected rpc: ${name}`)
      return Promise.resolve({ data: [], error: null })
    },
    from: (table: string) => {
      const filters: Filter[] = []
      let columns = ''
      let range: [number, number] | null = null
      const chain: Record<string, unknown> = {}
      for (const op of ['eq', 'or', 'in', 'gte', 'lt', 'is', 'not', 'order', 'filter', 'limit']) {
        chain[op] = (...args: unknown[]) => { filters.push([op, String(args[0]), args.slice(1)]); return chain }
      }
      chain.select = (cols: string) => {
        columns = cols
        if (table === 'execution_steps' && cols.includes('timeout_kind')) markerReads.push(filters)
        return chain
      }
      chain.range = (from: number, to: number) => { range = [from, to]; return chain }
      chain.then = (res: (v: unknown) => unknown) => {
        const isMarkerRead = table === 'execution_steps' && columns.includes('timeout_kind')
        if (isMarkerRead && opts.markerError) return Promise.resolve({ data: null, error: { message: opts.markerError } }).then(res)
        const all = isMarkerRead ? opts.markers : table === 'execution_steps' ? [] : tables[table] ?? []
        const data = range ? all.slice(range[0], range[1] + 1) : all
        return Promise.resolve({ data, error: null }).then(res)
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
const failedRun = (id: string, error_message: string, failed_step_type = 'code') =>
  ({ id, workflow_id: 'wf-1', error_message, started_at: recent(), completed_at: recent(), failed_step_type })
const burst = (message: string) => Array.from({ length: DEFAULT_OUTAGE_THRESHOLD }, (_, i) => failedRun(`e-${i}`, message))

describe('runUpstreamOutageCheck reads the failing steps\' markers (#3069)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pages "Upstream timeout" for runs whose failing steps were marked, though no message says so', async () => {
    const failed = burst(UNRECOGNISED)
    const sb = stepsDouble({ failed, markers: failed.map((r) => marked(r.id, 'code', STEP_DEADLINE)) })
    await runUpstreamOutageCheck(sb as never, makeKv() as never, 'https://app.example.com')
    expect(sendUpstreamOutageAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendUpstreamOutageAlert).mock.calls[0][2]).toMatchObject({
      cause_key: 'timeout',
      cause_label: 'Upstream timeout',
      failure_count: DEFAULT_OUTAGE_THRESHOLD,
    })
  })

  it('reads only the failed, marked steps of those runs, paged, bounded on started_at so the partitions prune', async () => {
    const failed = burst(UNRECOGNISED)
    const sb = stepsDouble({ failed, markers: [] })
    await runUpstreamOutageCheck(sb as never, makeKv() as never, 'https://app.example.com')
    expect(sb.markerReads).toHaveLength(1)
    const f = sb.markerReads[0]
    const has = (op: string, col: string, val?: unknown) =>
      f.some(([o, c, rest]) => o === op && c === col && (val === undefined || JSON.stringify(rest[0]) === JSON.stringify(val)))
    expect(has('in', 'execution_id', failed.map((r) => r.id))).toBe(true)
    expect(has('eq', 'status', 'failed')).toBe(true)
    expect(f.some(([o, c, rest]) => o === 'not' && c === 'timeout_kind' && rest[0] === 'is' && rest[1] === null)).toBe(true)
    expect(has('gte', 'started_at')).toBe(true)
    expect(has('order', 'started_at')).toBe(true)
    expect(has('order', 'id')).toBe(true)
  })

  it('a run written before the marker, with no marked step, still pages by its message', async () => {
    const sb = stepsDouble({ failed: burst(stepTimeoutMessage(8_000)), markers: [] })
    await runUpstreamOutageCheck(sb as never, makeKv() as never, 'https://app.example.com')
    expect(sendUpstreamOutageAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendUpstreamOutageAlert).mock.calls[0][2]).toMatchObject({ cause_key: 'timeout', failure_count: DEFAULT_OUTAGE_THRESHOLD })
  })

  it('a failed marker read logs, and the runs are still classified by their message', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sb = stepsDouble({ failed: burst(stepTimeoutMessage(8_000)), markers: [], markerError: 'statement timeout' })
    await runUpstreamOutageCheck(sb as never, makeKv() as never, 'https://app.example.com')
    expect(sendUpstreamOutageAlert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendUpstreamOutageAlert).mock.calls[0][2]).toMatchObject({ cause_key: 'timeout' })
    expect(error.mock.calls.some((c) => String(c[0]).includes('deadline markers could not be read'))).toBe(true)
    error.mockRestore()
  })

  it('a failed marker read leaves an unmarked-text run unclassified rather than guessing, and the check still finishes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sb = stepsDouble({ failed: burst(UNRECOGNISED), markers: [], markerError: 'statement timeout' })
    await expect(runUpstreamOutageCheck(sb as never, makeKv() as never, 'https://app.example.com')).resolves.toBeUndefined()
    expect(sendUpstreamOutageAlert).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('makes no marker read when no run failed in the cause window', async () => {
    const sb = stepsDouble({ failed: [], markers: [] })
    await runUpstreamOutageCheck(sb as never, makeKv() as never, 'https://app.example.com')
    expect(sb.markerReads).toHaveLength(0)
  })

  it('asks for at most 100 runs a read, so a large outage does not build an address too long to send', async () => {
    const failed = Array.from({ length: 250 }, (_, i) => failedRun(`e-${i}`, UNRECOGNISED))
    const sb = stepsDouble({ failed, markers: failed.map((r) => marked(r.id, 'code', STEP_DEADLINE)) })
    await runUpstreamOutageCheck(sb as never, makeKv() as never, 'https://app.example.com')
    const asked = sb.markerReads.map((f) => (f.find(([o, c]) => o === 'in' && c === 'execution_id')?.[2][0] as string[]).length)
    expect(asked).toEqual([100, 100, 50])
  })
})
