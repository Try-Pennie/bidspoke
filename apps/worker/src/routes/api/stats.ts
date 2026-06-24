import { Hono } from 'hono'
import { dbError } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'

type Variables = AuthVariables

const stats = new Hono<{ Bindings: Env; Variables: Variables }>()

type RollupRow = {
  workflow_id: string
  workflow_name: string
  status: string
  outcome: string | null
  day: string
  is_test: boolean
  run_count: number
  duration_ms_sum: number
  duration_ms_count: number
  cost_usd_sum: number
}

stats.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const windowDays = Math.min(30, Math.max(1, Number(c.req.query('window') ?? '7')))
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()

  const empty = {
    window_days: windowDays,
    summary: { total: 0, completed: 0, failed: 0, exited: 0, successful: 0, avg_duration_ms: null as number | null, p95_duration_ms: null as number | null, success_rate: 0 },
    by_day: [] as unknown[],
    by_workflow: [] as unknown[],
    recent_failures: [] as unknown[],
  }

  // 1. Pre-aggregated rollup (grouped by workflow / status / outcome / day / is_test)
  const { data: rollupRaw, error: rollupError } = await supabase.rpc('workflow_stats_rollup', {
    p_org_id: orgId,
    p_since: since,
  })
  if (rollupError) return dbError(c, rollupError)
  // The rollup RPC's aggregate columns are Postgres BIGINT (run_count,
  // duration_ms_sum, duration_ms_count) and NUMERIC (cost_usd_sum). PostgREST
  // serializes both as JSON STRINGS to preserve precision, so without coercion
  // `total += r.run_count` string-concatenates ("5"+"3" = "53") and every
  // summary/per-workflow number is garbage. Normalize once at the boundary.
  const rollup: RollupRow[] = ((rollupRaw ?? []) as RollupRow[]).map((r) => ({
    ...r,
    run_count: Number(r.run_count),
    duration_ms_sum: Number(r.duration_ms_sum),
    duration_ms_count: Number(r.duration_ms_count),
    cost_usd_sum: Number(r.cost_usd_sum),
  }))
  if (rollup.length === 0) return c.json(empty)

  // 2. Summary (production runs only — is_test=false)
  // 'degraded' = the lead was served but a post-response writeback failed (#310).
  // It counts as SERVED (in the success_rate numerator alongside completed), not
  // as a failure, and is surfaced as its own count so a writeback problem is
  // visible rather than hidden inside completed.
  let total = 0, completed = 0, failed = 0, exited = 0, successful = 0, degraded = 0
  let durationSum = 0, durationCount = 0
  for (const r of rollup) {
    if (r.is_test) continue
    total += r.run_count
    if (r.status === 'completed') completed += r.run_count
    else if (r.status === 'failed') failed += r.run_count
    else if (r.status === 'exited') exited += r.run_count
    else if (r.status === 'degraded') degraded += r.run_count
    if (r.outcome === 'successful') successful += r.run_count
    durationSum += r.duration_ms_sum
    durationCount += r.duration_ms_count
  }
  const avg_duration_ms = durationCount > 0 ? Math.round(durationSum / durationCount) : null
  const p95_duration_ms = null // not computed at rollup level; dashboard doesn't render it
  const success_rate = total > 0 ? Math.round(((completed + degraded) / total) * 100) : 0

  // 3. By day — production runs only
  const dayMap: Record<string, { completed: number; failed: number; exited: number; degraded: number }> = {}
  for (let i = windowDays - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    dayMap[key] = { completed: 0, failed: 0, exited: 0, degraded: 0 }
  }
  for (const r of rollup) {
    if (r.is_test) continue
    const day = dayMap[r.day]
    if (!day) continue
    if (r.status === 'completed') day.completed += r.run_count
    else if (r.status === 'failed') day.failed += r.run_count
    else if (r.status === 'exited') day.exited += r.run_count
    else if (r.status === 'degraded') day.degraded += r.run_count
  }
  const by_day = Object.entries(dayMap).map(([date, d]) => ({
    date,
    ...d,
    total: d.completed + d.failed + d.exited + d.degraded,
  }))

  // 4. By workflow — production for counts/durations; cost includes test runs
  type WfStat = {
    name: string
    total: number; completed: number; failed: number; exited: number; successful: number; degraded: number
    duration_sum: number; duration_count: number
    completed_duration_sum: number; completed_duration_count: number
    successful_duration_sum: number; successful_duration_count: number
    failed_duration_sum: number; failed_duration_count: number
    cost_sum: number
  }
  const wfStats: Record<string, WfStat> = {}
  const workflowMap: Record<string, string> = {}
  for (const r of rollup) {
    workflowMap[r.workflow_id] = r.workflow_name
    if (!wfStats[r.workflow_id]) {
      wfStats[r.workflow_id] = {
        name: r.workflow_name,
        total: 0, completed: 0, failed: 0, exited: 0, successful: 0, degraded: 0,
        duration_sum: 0, duration_count: 0,
        completed_duration_sum: 0, completed_duration_count: 0,
        successful_duration_sum: 0, successful_duration_count: 0,
        failed_duration_sum: 0, failed_duration_count: 0,
        cost_sum: 0,
      }
    }
    const s = wfStats[r.workflow_id]
    s.cost_sum += r.cost_usd_sum // includes test runs (already coerced to number above)
    if (r.is_test) continue
    s.total += r.run_count
    if (r.status === 'completed') s.completed += r.run_count
    else if (r.status === 'failed') s.failed += r.run_count
    else if (r.status === 'exited') s.exited += r.run_count
    else if (r.status === 'degraded') s.degraded += r.run_count
    if (r.outcome === 'successful') s.successful += r.run_count
    s.duration_sum += r.duration_ms_sum
    s.duration_count += r.duration_ms_count

    // Per-outcome duration buckets. "completed" here means outcome='completed'
    // (didn't reach a success node), distinct from status='completed' which
    // includes successful runs.
    if (r.outcome === 'completed') {
      s.completed_duration_sum += r.duration_ms_sum
      s.completed_duration_count += r.duration_ms_count
    } else if (r.outcome === 'successful') {
      s.successful_duration_sum += r.duration_ms_sum
      s.successful_duration_count += r.duration_ms_count
    }
    if (r.status === 'failed') {
      s.failed_duration_sum += r.duration_ms_sum
      s.failed_duration_count += r.duration_ms_count
    }
  }

  const by_workflow = Object.entries(wfStats)
    .map(([workflow_id, s]) => ({
      workflow_id,
      name: s.name,
      total: s.total,
      completed: s.completed,
      failed: s.failed,
      exited: s.exited,
      successful: s.successful,
      degraded: s.degraded,
      success_rate: s.total > 0 ? Math.round(((s.completed + s.degraded) / s.total) * 100) : null,
      avg_duration_ms: s.duration_count > 0 ? Math.round(s.duration_sum / s.duration_count) : null,
      avg_duration_completed_ms: s.completed_duration_count > 0 ? Math.round(s.completed_duration_sum / s.completed_duration_count) : null,
      avg_duration_successful_ms: s.successful_duration_count > 0 ? Math.round(s.successful_duration_sum / s.successful_duration_count) : null,
      avg_duration_failed_ms: s.failed_duration_count > 0 ? Math.round(s.failed_duration_sum / s.failed_duration_count) : null,
      cost_usd: s.cost_sum,
    }))
    .sort((a, b) => b.total - a.total || b.cost_usd - a.cost_usd)

  // 5. Recent failures (latest 10) — small row fetch, no cap risk
  const workflowIds = Object.keys(workflowMap)
  const { data: failureRows } = workflowIds.length > 0
    ? await supabase
        .from('workflow_executions')
        .select('id, workflow_id, error_message, started_at, source, trace_id')
        .in('workflow_id', workflowIds)
        .gte('started_at', since)
        .eq('is_test', false)
        .eq('status', 'failed')
        .order('started_at', { ascending: false })
        .limit(10)
    : { data: [] as Array<{ id: string; workflow_id: string; error_message: string | null; started_at: string; source: string | null; trace_id: string | null }> }

  const recent_failures = (failureRows ?? []).map((r) => ({
    id: r.id,
    workflow_id: r.workflow_id,
    workflow_name: workflowMap[r.workflow_id] ?? 'Unknown',
    error_message: r.error_message,
    started_at: r.started_at,
    source: r.source,
    trace_id: r.trace_id,
  }))

  return c.json({
    window_days: windowDays,
    summary: { total, completed, failed, exited, successful, degraded, avg_duration_ms, p95_duration_ms, success_rate },
    by_day,
    by_workflow,
    recent_failures,
  })
})

export default stats
