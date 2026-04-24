import { Hono } from 'hono'
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
  cost_usd_sum: number | string
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
    by_partner: [] as unknown[],
    recent_failures: [] as unknown[],
  }

  // 1. Pre-aggregated rollup (grouped by workflow / status / outcome / day / is_test)
  const { data: rollupRaw, error: rollupError } = await supabase.rpc('workflow_stats_rollup', {
    p_org_id: orgId,
    p_since: since,
  })
  if (rollupError) return c.json({ error: rollupError.message }, 500)
  const rollup = (rollupRaw ?? []) as RollupRow[]
  if (rollup.length === 0) return c.json(empty)

  // 2. Summary (production runs only — is_test=false)
  let total = 0, completed = 0, failed = 0, exited = 0, successful = 0
  let durationSum = 0, durationCount = 0
  for (const r of rollup) {
    if (r.is_test) continue
    total += r.run_count
    if (r.status === 'completed') completed += r.run_count
    else if (r.status === 'failed') failed += r.run_count
    else if (r.status === 'exited') exited += r.run_count
    if (r.outcome === 'successful') successful += r.run_count
    durationSum += r.duration_ms_sum
    durationCount += r.duration_ms_count
  }
  const avg_duration_ms = durationCount > 0 ? Math.round(durationSum / durationCount) : null
  const p95_duration_ms = null // not computed at rollup level; dashboard doesn't render it
  const success_rate = total > 0 ? Math.round((completed / total) * 100) : 0

  // 3. By day — production runs only
  const dayMap: Record<string, { completed: number; failed: number; exited: number }> = {}
  for (let i = windowDays - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
    dayMap[key] = { completed: 0, failed: 0, exited: 0 }
  }
  for (const r of rollup) {
    if (r.is_test) continue
    const day = dayMap[r.day]
    if (!day) continue
    if (r.status === 'completed') day.completed += r.run_count
    else if (r.status === 'failed') day.failed += r.run_count
    else if (r.status === 'exited') day.exited += r.run_count
  }
  const by_day = Object.entries(dayMap).map(([date, d]) => ({
    date,
    ...d,
    total: d.completed + d.failed + d.exited,
  }))

  // 4. By workflow — production for counts/durations; cost includes test runs
  type WfStat = { name: string; total: number; completed: number; failed: number; exited: number; successful: number; duration_sum: number; duration_count: number; cost_sum: number }
  const wfStats: Record<string, WfStat> = {}
  const workflowMap: Record<string, string> = {}
  for (const r of rollup) {
    workflowMap[r.workflow_id] = r.workflow_name
    if (!wfStats[r.workflow_id]) {
      wfStats[r.workflow_id] = {
        name: r.workflow_name,
        total: 0, completed: 0, failed: 0, exited: 0, successful: 0,
        duration_sum: 0, duration_count: 0, cost_sum: 0,
      }
    }
    const s = wfStats[r.workflow_id]
    s.cost_sum += Number(r.cost_usd_sum) // includes test runs
    if (r.is_test) continue
    s.total += r.run_count
    if (r.status === 'completed') s.completed += r.run_count
    else if (r.status === 'failed') s.failed += r.run_count
    else if (r.status === 'exited') s.exited += r.run_count
    if (r.outcome === 'successful') s.successful += r.run_count
    s.duration_sum += r.duration_ms_sum
    s.duration_count += r.duration_ms_count
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
      success_rate: s.total > 0 ? Math.round((s.completed / s.total) * 100) : null,
      avg_duration_ms: s.duration_count > 0 ? Math.round(s.duration_sum / s.duration_count) : null,
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

  // 6. By partner — aggregate partner_bid steps across production executions in window.
  // Scoped to the latest 5k execution IDs (more than enough for a 30-day window;
  // bid volume is far below total exec volume).
  const { data: execIdRows } = workflowIds.length > 0
    ? await supabase
        .from('workflow_executions')
        .select('id')
        .in('workflow_id', workflowIds)
        .gte('started_at', since)
        .eq('is_test', false)
        .order('started_at', { ascending: false })
        .limit(5000)
    : { data: [] as Array<{ id: string }> }
  const executionIds = (execIdRows ?? []).map((r) => r.id)
  let by_partner: unknown[] = []

  if (executionIds.length > 0) {
    const { data: partnerSteps } = await supabase
      .from('execution_steps')
      .select('output, status')
      .in('execution_id', executionIds)
      .eq('step_type', 'partner_bid')
      .limit(100000)

    const { data: partnerConfigs } = await supabase
      .from('partner_configs')
      .select('slug, name')
      .eq('organization_id', orgId)

    const partnerNameMap: Record<string, string> = Object.fromEntries(
      (partnerConfigs ?? []).map((p) => [p.slug as string, p.name as string])
    )

    type PartnerStat = { bids_sent: number; accepted: number; skipped: number; errors: number; total_bid: number; bid_count: number }
    const pStats: Record<string, PartnerStat> = {}

    const infraSkipReasons = new Set(['circuit_open', 'cap_exceeded', 'duplicate', 'partner_inactive'])

    for (const step of partnerSteps ?? []) {
      const out = step.output as { partner?: string; bid?: number | null; accepted?: boolean; skipped?: boolean; skip_reason?: string } | null
      if (!out?.partner) continue
      const slug = out.partner
      if (!pStats[slug]) pStats[slug] = { bids_sent: 0, accepted: 0, skipped: 0, errors: 0, total_bid: 0, bid_count: 0 }

      if ((step.status as string) === 'failed') {
        pStats[slug].errors++
      } else if (out.skipped && infraSkipReasons.has(out.skip_reason ?? '')) {
        pStats[slug].skipped++
      } else {
        pStats[slug].bids_sent++
        if (out.accepted && typeof out.bid === 'number') {
          pStats[slug].accepted++
          pStats[slug].total_bid += out.bid
          pStats[slug].bid_count++
        }
      }
    }

    by_partner = Object.entries(pStats)
      .map(([slug, s]) => ({
        slug,
        name: partnerNameMap[slug] ?? slug,
        bids_sent: s.bids_sent,
        accepted: s.accepted,
        skipped: s.skipped,
        errors: s.errors,
        win_rate: s.bids_sent > 0 ? Math.round((s.accepted / s.bids_sent) * 100) : 0,
        avg_bid: s.bid_count > 0 ? Math.round(s.total_bid / s.bid_count) : null,
      }))
      .sort((a, b) => b.bids_sent - a.bids_sent)
  }

  return c.json({
    window_days: windowDays,
    summary: { total, completed, failed, exited, successful, avg_duration_ms, p95_duration_ms, success_rate },
    by_day,
    by_workflow,
    by_partner,
    recent_failures,
  })
})

export default stats
