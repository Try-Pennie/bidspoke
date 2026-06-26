/**
 * Dead-man's-switch for the daily 13:00 UTC health-check batch (#358).
 *
 * That batch (volume-anomaly, timeout-audit, secret-drift, big-table-guard,
 * drain-stall, required-secrets) is the safety net for data-integrity and config
 * problems. Each check has its own try/catch, but nothing signals if the WHOLE
 * batch stops firing (a cron-trigger misconfig or the scheduled handler erroring
 * before dispatch). If it goes dark, every watchdog silently stops.
 *
 * Mechanism: the 13:00 batch writes a heartbeat timestamp to KV on each run; the
 * every-minute cron evaluates freshness and alerts Slack if it is stale beyond
 * the threshold. A "first seen" marker gives a fresh deploy a grace period so it
 * doesn't false-alarm before the first daily run, while still catching a daily
 * cron that never fires.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendCronHeartbeatAlert } from './slack'

export const HEARTBEAT_KEY = 'cron-heartbeat:daily-1300'
export const FIRST_SEEN_KEY = 'cron-heartbeat:daily-1300:first-seen'
const COOLDOWN_KEY = 'cron-heartbeat:daily-1300:alerted'

/** Daily cadence is 24h; allow 2h of slack before declaring the batch dark. */
export const STALE_THRESHOLD_MS = 26 * 60 * 60 * 1000
const COOLDOWN_TTL_SECONDS = 6 * 60 * 60

export type HeartbeatStatus = 'healthy' | 'stale' | 'never_ran' | 'pending'

export interface HeartbeatVerdict {
  status: HeartbeatStatus
  ageMs: number | null
}

/**
 * Pure freshness decision.
 * - heartbeat present: healthy unless strictly older than staleMs (then stale).
 * - heartbeat absent: never_ran if it was first seen longer ago than staleMs,
 *   otherwise pending (fresh deploy grace, or nothing recorded yet).
 */
export function evaluateHeartbeat(
  lastRan: string | null,
  firstSeen: string | null,
  nowMs: number,
  staleMs: number,
): HeartbeatVerdict {
  if (lastRan) {
    const ageMs = nowMs - Date.parse(lastRan)
    return { status: ageMs > staleMs ? 'stale' : 'healthy', ageMs }
  }
  if (firstSeen) {
    const ageMs = nowMs - Date.parse(firstSeen)
    return { status: ageMs > staleMs ? 'never_ran' : 'pending', ageMs }
  }
  return { status: 'pending', ageMs: null }
}

/** Called by the 13:00 batch on each run to stamp "last ran". */
export async function writeDailyHeartbeat(kv: KVNamespace, nowMs: number = Date.now()): Promise<void> {
  await kv.put(HEARTBEAT_KEY, new Date(nowMs).toISOString())
}

export interface HeartbeatCheckResult {
  status: HeartbeatStatus
  alerted: boolean
  ageMs: number | null
}

/**
 * Called by the every-minute cron. Reads the heartbeat, seeds a first-seen
 * marker on a fresh deploy, and alerts each Slack org (once per cooldown) when
 * the daily batch is stale or has never run.
 *
 * Limitation: this lives in the same worker as the crons it watches, so it
 * catches the daily cron going dark while the minute cron still runs (trigger
 * misconfig, handler erroring before dispatch). Total worker death would also
 * silence this check — that case needs an external uptime monitor.
 */
export async function runDailyHeartbeatCheck(
  supabase: SupabaseClient,
  kv: KVNamespace,
  nowMs: number = Date.now(),
): Promise<HeartbeatCheckResult> {
  const lastRan = await kv.get(HEARTBEAT_KEY)
  const firstSeen = await kv.get(FIRST_SEEN_KEY)
  const verdict = evaluateHeartbeat(lastRan, firstSeen, nowMs, STALE_THRESHOLD_MS)

  if (verdict.status === 'pending') {
    if (!lastRan && !firstSeen) await kv.put(FIRST_SEEN_KEY, new Date(nowMs).toISOString())
    return { status: 'pending', alerted: false, ageMs: verdict.ageMs }
  }
  if (verdict.status === 'healthy') {
    return { status: 'healthy', alerted: false, ageMs: verdict.ageMs }
  }

  // stale or never_ran — alert once per cooldown window.
  if (await kv.get(COOLDOWN_KEY)) return { status: verdict.status, alerted: false, ageMs: verdict.ageMs }

  const { data: conns } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  let alerted = false
  for (const orgId of orgIds) {
    if (await sendCronHeartbeatAlert(supabase, orgId, verdict.status, verdict.ageMs)) alerted = true
  }
  if (alerted) await kv.put(COOLDOWN_KEY, '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
  return { status: verdict.status, alerted, ageMs: verdict.ageMs }
}
