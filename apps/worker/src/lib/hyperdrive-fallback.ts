/**
 * Hyperdrive -> PostgREST fallback monitoring (#134).
 *
 * The execution-log writer (engine/step-logger.ts) uses Hyperdrive (direct
 * Postgres) when the binding is present, and silently falls back to PostgREST on
 * a transient Hyperdrive error. A degraded direct path (pooler outage, expired DB
 * password, connection-limit exhaustion) re-exposes execution-log writes to the
 * 03:30 UTC schema-cache 503s Hyperdrive was provisioned to eliminate — with no
 * signal until the next incident.
 *
 * Each fallback drops a short-lived KV marker. The per-minute cron counts live
 * markers; once the count crosses a threshold in the ~5-minute window it fires a
 * Slack alert (with a cooldown so a sustained degradation doesn't spam).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import { sendHyperdriveFallbackAlert } from './slack'

const MARKER_PREFIX = 'hdfb:m:'
const COOLDOWN_KEY = 'hdfb:cooldown'
const MARKER_TTL_SECONDS = 300
export const COOLDOWN_TTL_SECONDS = 30 * 60
export const FALLBACK_ALERT_THRESHOLD = 5

/** True once the number of fallbacks in the window warrants an alert. A small
 *  threshold so a single transient blip (one connection that immediately
 *  recovers) doesn't page, but a real degradation does. */
export function shouldAlertFallback(count: number): boolean {
  return count >= FALLBACK_ALERT_THRESHOLD
}

/** Record one Hyperdrive->PostgREST fallback as a short-lived, unique KV marker.
 *  Fire-and-forget: never blocks or throws on the logging hot path. No-op when
 *  the KV binding is absent (e.g. tests, Hyperdrive disabled). */
export function recordHyperdriveFallback(env: Env | undefined): void {
  const kv = env?.IDEMPOTENCY
  if (!kv) return
  void kv
    .put(MARKER_PREFIX + crypto.randomUUID(), Date.now().toString(), { expirationTtl: MARKER_TTL_SECONDS })
    .catch(() => {})
}

/** Per-minute cron check: count live fallback markers and alert every connected
 *  org's Slack if the count crosses the threshold and we're not in cooldown. */
export async function runHyperdriveFallbackCheck(
  supabase: SupabaseClient,
  kv: KVNamespace,
): Promise<{ count: number; alerted: boolean }> {
  const list = await kv.list({ prefix: MARKER_PREFIX })
  const count = list.keys.length
  if (!shouldAlertFallback(count)) return { count, alerted: false }
  if (await kv.get(COOLDOWN_KEY)) return { count, alerted: false }

  const { data } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  const orgIds = [...new Set((data ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  let alerted = false
  for (const orgId of orgIds) {
    if (await sendHyperdriveFallbackAlert(supabase, orgId, count)) alerted = true
  }
  if (alerted) await kv.put(COOLDOWN_KEY, '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
  return { count, alerted }
}
