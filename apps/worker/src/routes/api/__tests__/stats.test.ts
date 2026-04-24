/**
 * Stats route — PRD Section 2.5
 * Covers: empty org, execution aggregation (summary, by_day, by_workflow, by_partner),
 * recent failures, partner win rate, infra-skipped partners excluded from bids_sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'

// ── Supabase mock ─────────────────────────────────────────────────────────────

type TableConfig = {
  single?: Record<string, unknown> | null
  list?: Record<string, unknown>[]
}

function makeSupabase(tables: Record<string, TableConfig | TableConfig[]> = {}, rpcs: Record<string, unknown[]> = {}) {
  const callCounts: Record<string, number> = {}

  return {
    from: (table: string) => {
      const raw = tables[table]
      const cfgArr: TableConfig[] = Array.isArray(raw) ? raw : raw ? [raw] : [{}]
      const idx = callCounts[table] ?? 0
      callCounts[table] = idx + 1
      const cfg = cfgArr[Math.min(idx, cfgArr.length - 1)]

      const chain: unknown = new Proxy({}, {
        get(_, prop) {
          if (typeof prop === 'symbol') return undefined
          if (prop === 'single') {
            return () => cfg.single !== undefined
              ? cfg.single
                ? Promise.resolve({ data: cfg.single, error: null })
                : Promise.resolve({ data: null, error: { message: 'not found', code: 'PGRST116' } })
              : Promise.resolve({ data: null, error: { message: 'not found', code: 'PGRST116' } })
          }
          if (prop === 'then') {
            return (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data: cfg.list ?? [], error: null }).then(resolve)
          }
          return () => chain
        },
      })
      return chain
    },
    rpc: (name: string) => Promise.resolve({ data: rpcs[name] ?? [], error: null }),
  }
}

// Helper: translate a list of workflow_executions rows into the rollup shape
// returned by the workflow_stats_rollup RPC.
function execsToRollup(
  execs: Array<Record<string, unknown>>,
  workflows: Array<{ id: string; name: string }>
) {
  const nameById = Object.fromEntries(workflows.map((w) => [w.id, w.name]))
  const buckets = new Map<string, {
    workflow_id: string; workflow_name: string; status: string; outcome: string | null;
    day: string; is_test: boolean; run_count: number; duration_ms_sum: number;
    duration_ms_count: number; cost_usd_sum: number
  }>()
  for (const e of execs) {
    const day = (e.started_at as string).slice(0, 10)
    const wid = e.workflow_id as string
    const key = `${wid}|${e.status}|${e.outcome ?? ''}|${day}|${e.is_test}`
    const existing = buckets.get(key)
    const dur = typeof e.duration_ms === 'number' ? e.duration_ms : null
    const cost = typeof e.cost_usd === 'number' ? e.cost_usd : 0
    if (existing) {
      existing.run_count++
      if (dur != null) { existing.duration_ms_sum += dur; existing.duration_ms_count++ }
      existing.cost_usd_sum += cost
    } else {
      buckets.set(key, {
        workflow_id: wid,
        workflow_name: nameById[wid] ?? 'Unknown',
        status: e.status as string,
        outcome: (e.outcome as string) ?? null,
        day,
        is_test: (e.is_test as boolean) ?? false,
        run_count: 1,
        duration_ms_sum: dur ?? 0,
        duration_ms_count: dur != null ? 1 : 0,
        cost_usd_sum: cost,
      })
    }
  }
  return Array.from(buckets.values())
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }

const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

const today = new Date().toISOString().slice(0, 10)

const testWorkflow = { id: 'wf-1', name: 'Main workflow', organization_id: USER_ORG }

const execCompleted = {
  id: 'exec-1',
  workflow_id: 'wf-1',
  status: 'completed',
  duration_ms: 200,
  started_at: `${today}T10:00:00Z`,
  error_message: null,
  source: 'api',
  trace_id: 'trace-1',
  is_test: false,
}

const execFailed = {
  id: 'exec-2',
  workflow_id: 'wf-1',
  status: 'failed',
  duration_ms: 100,
  started_at: `${today}T11:00:00Z`,
  error_message: 'Something broke',
  source: 'api',
  trace_id: 'trace-2',
  is_test: false,
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function request(app: { request: Function }, path: string) {
  return app.request(path, {
    method: 'GET',
    headers: { Authorization: 'Bearer tok' },
  }, testEnv, mockCtx)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /stats', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    app = await makeApp()
  })

  it('returns empty stats when org has no rollup data', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }, { workflow_stats_rollup: [] }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, '/stats')
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.summary).toMatchObject({ total: 0, completed: 0, failed: 0 })
    expect(body.by_day).toEqual([])
    expect(body.by_workflow).toEqual([])
    expect(body.by_partner).toEqual([])
    expect(body.recent_failures).toEqual([])
  })

  it('returns correct summary counts', async () => {
    const rollup = execsToRollup([execCompleted, execFailed], [testWorkflow])
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { list: [] },
        execution_steps: { list: [] },
        partner_configs: { list: [] },
      }, { workflow_stats_rollup: rollup }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, '/stats')
    expect(res.status).toBe(200)
    const body = await res.json() as { summary: Record<string, unknown> }
    expect(body.summary.total).toBe(2)
    expect(body.summary.completed).toBe(1)
    expect(body.summary.failed).toBe(1)
    expect(body.summary.success_rate).toBe(50)
    expect(body.summary.avg_duration_ms).toBe(150)
  })

  it('includes recent_failures with workflow name', async () => {
    const rollup = execsToRollup([execFailed], [testWorkflow])
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { list: [execFailed] },
        execution_steps: { list: [] },
        partner_configs: { list: [] },
      }, { workflow_stats_rollup: rollup }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, '/stats')
    const body = await res.json() as { recent_failures: Array<Record<string, unknown>> }
    expect(body.recent_failures).toHaveLength(1)
    expect(body.recent_failures[0].workflow_name).toBe('Main workflow')
    expect(body.recent_failures[0].error_message).toBe('Something broke')
  })

  it('by_day fills all days in window with zero counts', async () => {
    const rollup = execsToRollup([execCompleted], [testWorkflow])
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { list: [] },
        execution_steps: { list: [] },
        partner_configs: { list: [] },
      }, { workflow_stats_rollup: rollup }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, '/stats?window=7')
    const body = await res.json() as { by_day: Array<{ date: string; total: number }> }
    expect(body.by_day).toHaveLength(7)
    const todayEntry = body.by_day.find((d) => d.date === today)
    expect(todayEntry?.total).toBe(1)
  })

  it('aggregates by_partner from partner_bid execution steps', async () => {
    const partnerStep = {
      output: { partner: 'tripoint', bid: 650, accepted: true, skipped: false },
      status: 'completed',
    }
    const rollup = execsToRollup([execCompleted], [testWorkflow])
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { list: [{ id: execCompleted.id }] },
        execution_steps: { list: [partnerStep] },
        partner_configs: { list: [{ slug: 'tripoint', name: 'Tripoint Financial' }] },
      }, { workflow_stats_rollup: rollup }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, '/stats')
    const body = await res.json() as { by_partner: Array<Record<string, unknown>> }
    expect(body.by_partner).toHaveLength(1)
    const tp = body.by_partner[0]
    expect(tp.slug).toBe('tripoint')
    expect(tp.name).toBe('Tripoint Financial')
    expect(tp.bids_sent).toBe(1)
    expect(tp.accepted).toBe(1)
    expect(tp.win_rate).toBe(100)
    expect(tp.avg_bid).toBe(650)
    expect(tp.skipped).toBe(0)
  })

  it('counts infra skips separately and excludes them from bids_sent', async () => {
    const capSkip = { output: { partner: 'tripoint', bid: null, accepted: false, skipped: true, skip_reason: 'cap_exceeded' }, status: 'completed' }
    const circuitSkip = { output: { partner: 'tripoint', bid: null, accepted: false, skipped: true, skip_reason: 'circuit_open' }, status: 'completed' }
    const acceptedBid = { output: { partner: 'tripoint', bid: 500, accepted: true, skipped: false }, status: 'completed' }
    const rollup = execsToRollup([execCompleted], [testWorkflow])
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { list: [{ id: execCompleted.id }] },
        execution_steps: { list: [capSkip, circuitSkip, acceptedBid] },
        partner_configs: { list: [{ slug: 'tripoint', name: 'Tripoint' }] },
      }, { workflow_stats_rollup: rollup }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, '/stats')
    const body = await res.json() as { by_partner: Array<Record<string, unknown>> }
    const tp = body.by_partner[0]
    expect(tp.bids_sent).toBe(1)
    expect(tp.skipped).toBe(2)
    expect(tp.win_rate).toBe(100)
  })

  it('counts failed partner steps as errors', async () => {
    const errorStep = { output: { partner: 'm1', bid: null }, status: 'failed' }
    const rollup = execsToRollup([execCompleted], [testWorkflow])
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        workflow_executions: { list: [{ id: execCompleted.id }] },
        execution_steps: { list: [errorStep] },
        partner_configs: { list: [{ slug: 'm1', name: 'M1 Finance' }] },
      }, { workflow_stats_rollup: rollup }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res = await request(app, '/stats')
    const body = await res.json() as { by_partner: Array<Record<string, unknown>> }
    expect(body.by_partner[0].errors).toBe(1)
    expect(body.by_partner[0].bids_sent).toBe(0)
  })

  it('uses the window query param (max 30, min 1)', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({ users: { single: testUser } }, { workflow_stats_rollup: [] }) as unknown as ReturnType<typeof createSupabaseClient>
    )
    const res14 = await request(app, '/stats?window=14')
    const b14 = await res14.json() as { window_days: number }
    expect(b14.window_days).toBe(14)

    const res99 = await request(app, '/stats?window=99')
    const b99 = await res99.json() as { window_days: number }
    expect(b99.window_days).toBe(30)
  })
})
