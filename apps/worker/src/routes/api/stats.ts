import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'

type Variables = AuthVariables

const stats = new Hono<{ Bindings: Env; Variables: Variables }>()

stats.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const windowDays = Math.min(30, Math.max(1, Number(c.req.query('window') ?? '7')))
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()

  // 1. Workflow IDs + names for this org
  const { data: workflows } = await supabase
    .from('workflows')
    .select('id, name')
    .eq('organization_id', orgId)

  const workflowIds = (workflows ?? []).map((w) => w.id)
  const workflowMap: Record<string, string> = Object.fromEntries(
    (workflows ?? []).map((w) => [w.id, w.name])
  )

  const empty = {
    window_days: windowDays,
    summary: { total: 0, completed: 0, failed: 0, exited: 0, avg_duration_ms: null as number | null, p95_duration_ms: null as number | null, success_rate: 0 },
    by_day: [] as unknown[],
    by_workflow: [] as unknown[],
    recent_failures: [] as unknown[],
  }

  if (workflowIds.length === 0) return c.json(empty)

  // 2. All real executions in window
  const { data: executions, error } = await supabase
    .from('workflow_executions')
    .select('id, workflow_id, status, duration_ms, started_at, error_message, source, trace_id')
    .in('workflow_id', workflowIds)
    .gte('started_at', since)
    .eq('is_test', false)
    .order('started_at', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)

  const rows = executions ?? []

  // 3. Summary
  const total = rows.length
  const completed = rows.filter((r) => r.status === 'completed').length
  const failed = rows.filter((r) => r.status === 'failed').length
  const exited = rows.filter((r) => r.status === 'exited').length
  const durations = rows
    .filter((r) => r.duration_ms != null)
    .map((r) => r.duration_ms as number)
    .sort((a, b) => a - b)
  const avg_duration_ms = durations.length
    ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
    : null
  const p95_duration_ms = durations.length
    ? (durations[Math.floor(durations.length * 0.95)] ?? null)
    : null
  const success_rate = total > 0 ? Math.round((completed / total) * 100) : 0

  // 4. By day — fill every day in range (including zeros)
  const dayMap: Record<string, { completed: number; failed: number; exited: number }> = {}
  for (let i = windowDays - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    dayMap[key] = { completed: 0, failed: 0, exited: 0 }
  }
  for (const r of rows) {
    const key = (r.started_at as string).slice(0, 10)
    if (dayMap[key]) {
      if (r.status === 'completed') dayMap[key].completed++
      else if (r.status === 'failed') dayMap[key].failed++
      else if (r.status === 'exited') dayMap[key].exited++
    }
  }
  const by_day = Object.entries(dayMap).map(([date, c]) => ({
    date,
    ...c,
    total: c.completed + c.failed + c.exited,
  }))

  // 5. By workflow
  type WfStat = { name: string; total: number; completed: number; failed: number; exited: number; durations: number[] }
  const wfStats: Record<string, WfStat> = {}
  for (const r of rows) {
    if (!wfStats[r.workflow_id]) {
      wfStats[r.workflow_id] = {
        name: workflowMap[r.workflow_id] ?? 'Unknown',
        total: 0, completed: 0, failed: 0, exited: 0, durations: [],
      }
    }
    wfStats[r.workflow_id].total++
    if (r.status === 'completed') wfStats[r.workflow_id].completed++
    else if (r.status === 'failed') wfStats[r.workflow_id].failed++
    else if (r.status === 'exited') wfStats[r.workflow_id].exited++
    if (r.duration_ms != null) wfStats[r.workflow_id].durations.push(r.duration_ms as number)
  }
  const by_workflow = Object.entries(wfStats)
    .map(([workflow_id, s]) => ({
      workflow_id,
      name: s.name,
      total: s.total,
      completed: s.completed,
      failed: s.failed,
      exited: s.exited,
      success_rate: Math.round((s.completed / s.total) * 100),
      avg_duration_ms: s.durations.length
        ? Math.round(s.durations.reduce((a, b) => a + b, 0) / s.durations.length)
        : null,
    }))
    .sort((a, b) => b.total - a.total)

  // 6. Recent failures (latest 10)
  const recent_failures = rows
    .filter((r) => r.status === 'failed')
    .slice(0, 10)
    .map((r) => ({
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
    summary: { total, completed, failed, exited, avg_duration_ms, p95_duration_ms, success_rate },
    by_day,
    by_workflow,
    recent_failures,
  })
})

export default stats
