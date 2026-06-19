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

// Fraction of fallbacks that must land in the purge window to call the cluster a
// (benign) nightly purge rather than a degraded direct path.
export const PURGE_ATTRIBUTION_RATIO = 0.8

/** True when `ts` falls in the nightly partition-purge window. The purge cron
 *  runs at 03:30 UTC ('30 3 * * *'); its ACCESS EXCLUSIVE lock + schema-cache
 *  reload force Hyperdrive inserts to fall back to PostgREST for ~1 min
 *  (observed 03:30:21–03:31:07). Treat 03:30–03:32 UTC as the window. */
export function isInPurgeWindow(ts: number): boolean {
  const d = new Date(ts)
  return d.getUTCHours() === 3 && d.getUTCMinutes() >= 30 && d.getUTCMinutes() <= 32
}

/** True when the fallback cluster is predominantly inside the purge window — the
 *  expected nightly purge, not a degraded direct path. Markers without a
 *  timestamp (written before this shipped) count as "not purge" so we never
 *  over-suppress a genuine degradation. */
export function shouldAttributeToPurge(timestamps: Array<number | undefined>, count: number): boolean {
  if (count === 0) return false
  const inWindow = timestamps.filter((t) => typeof t === 'number' && isInPurgeWindow(t)).length
  return inWindow / count >= PURGE_ATTRIBUTION_RATIO
}

/** Record one Hyperdrive->PostgREST fallback as a short-lived, unique KV marker.
 *  Fire-and-forget: never blocks or throws on the logging hot path. No-op when
 *  the KV binding is absent (e.g. tests, Hyperdrive disabled). */
export function recordHyperdriveFallback(env: Env | undefined): void {
  const kv = env?.IDEMPOTENCY
  if (!kv) return
  void kv
    .put(MARKER_PREFIX + crypto.randomUUID(), '1', {
      expirationTtl: MARKER_TTL_SECONDS,
      // Stamp the fallback time so the cron can tell a benign nightly-purge
      // cluster (03:30 UTC) from a genuine degraded direct path (#235).
      metadata: { t: Date.now() },
    })
    .catch(() => {})
}

/** Per-minute cron check: count live fallback markers and alert every connected
 *  org's Slack if the count crosses the threshold and we're not in cooldown. */
export async function runHyperdriveFallbackCheck(
  supabase: SupabaseClient,
  kv: KVNamespace,
): Promise<{ count: number; alerted: boolean; suppressed?: 'purge_window' }> {
  const list = await kv.list({ prefix: MARKER_PREFIX })
  const count = list.keys.length
  if (!shouldAlertFallback(count)) return { count, alerted: false }

  // The nightly partition purge makes Hyperdrive fall back to PostgREST by
  // design (its lock + schema-cache reload), and #237 hardened those writes so
  // the fallback is benign. Don't page on-call for the expected nightly cluster.
  // No cooldown is set here, so a genuine degradation just after the window can
  // still alert on the next per-minute check.
  const timestamps = list.keys.map((k) => (k.metadata as { t?: number } | undefined)?.t)
  if (shouldAttributeToPurge(timestamps, count)) return { count, alerted: false, suppressed: 'purge_window' }

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
