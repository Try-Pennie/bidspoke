/**
 * Tail consumer for bidspoke-worker.
 *
 * Cloudflare delivers a TraceItem per request after the main worker finishes
 * (including `waitUntil` tasks). Each trace includes `cpuTime`, which is the
 * value we need to compute the true main-Worker cost slice for an execution.
 *
 * Correlation: the main worker emits a structured `execution_complete` or
 * `execution_failed` log line via console.log(). We scan logs[] for one of
 * those entries and pull `execution_id` + `started_at`. Then we add the
 * main-Worker cost slice onto workflow_executions.cost_usd atomically.
 *
 * The step-based slice (partner + code + Supabase) is already written by the
 * main worker. This consumer only adds the CF request + CPU portion.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

interface Env {
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
  /**
   * The commit this worker was deployed from, stamped by deploy.yml (#739).
   * Optional because a local `wrangler dev` has no deploy to stamp it, and the
   * drift check treats the resulting `unknown` as a broken stamp rather than as
   * a commit.
   */
  DEPLOYED_SHA?: string
}

// Keep in sync with apps/worker/src/engine/cost-rates.ts.
const CF_REQUEST_USD = 0.0000003
const CF_CPU_MS_USD = 0.0000000125

interface ExecutionLog {
  event?: string
  execution_id?: string
  trace_id?: string
}

function tryParseLogLine(message: unknown): ExecutionLog | null {
  // Tail-event message shape varies by runtime — sometimes a string,
  // sometimes the arguments array passed to console.log.
  let candidate: string | null = null
  if (typeof message === 'string') candidate = message
  else if (Array.isArray(message) && typeof message[0] === 'string') candidate = message[0]
  if (!candidate || !candidate.includes('"event"')) return null
  try {
    return JSON.parse(candidate) as ExecutionLog
  } catch {
    return null
  }
}

function findExecutionLog(logs: TraceLog[]): ExecutionLog | null {
  for (const l of logs) {
    const parsed = tryParseLogLine(l.message)
    if (parsed && (parsed.event === 'execution_complete' || parsed.event === 'execution_failed')) {
      return parsed
    }
  }
  return null
}

async function applyTrace(
  supabase: SupabaseClient,
  executionId: string,
  cpuMs: number
): Promise<void> {
  const mainCost = CF_REQUEST_USD + cpuMs * CF_CPU_MS_USD

  const { data: existing, error: selErr } = await supabase
    .from('workflow_executions')
    .select('cost_usd, started_at')
    .eq('id', executionId)
    .limit(1)
    .maybeSingle()

  if (selErr || !existing) {
    console.error('[worker-tail] could not load execution', { executionId, error: selErr?.message })
    return
  }

  const nextCost = Number(existing.cost_usd ?? 0) + mainCost

  const { error: updErr } = await supabase
    .from('workflow_executions')
    .update({ cost_usd: nextCost, cpu_ms: Math.round(cpuMs) })
    .eq('id', executionId)
    .eq('started_at', existing.started_at)

  if (updErr) {
    console.error('[worker-tail] failed to update cost', { executionId, error: updErr.message })
  }
}

export default {
  /**
   * Reports the commit this worker is running, and nothing else (#739).
   *
   * A tail consumer has no reason to serve traffic, and this exists purely so a
   * stranded deploy can be detected. It matters more here than for most workers:
   * this one writes `workflow_executions.cost_usd`, so a stranded copy does not
   * fail, it under-reports what executions cost while the dashboard goes on
   * showing numbers nobody has reason to doubt.
   *
   * Same shape as the engine worker's `GET /`, so one check can read both, and a
   * missing stamp answers `unknown` rather than being omitted: an absent field
   * and a broken stamp would otherwise be indistinguishable to the reader.
   */
  fetch(_request: Request, env: Env): Response {
    return Response.json({
      status: 'ok',
      service: 'bidspoke-worker-tail',
      version: env.DEPLOYED_SHA ?? 'unknown',
    })
  },

  async tail(events: TraceItem[], env: Env, _ctx: ExecutionContext): Promise<void> {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    for (const trace of events) {
      if (trace.outcome !== 'ok' && trace.outcome !== 'canceled') continue
      const cpuMs = typeof trace.cpuTime === 'number' ? trace.cpuTime : null
      if (cpuMs == null) continue

      const execLog = findExecutionLog(trace.logs)
      if (!execLog?.execution_id) continue

      await applyTrace(supabase, execLog.execution_id, cpuMs)
    }
  },
}
