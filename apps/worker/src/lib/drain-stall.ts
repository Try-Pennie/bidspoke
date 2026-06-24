/**
 * Daily drain-stall guard (#350).
 *
 * Two pg_cron jobs finalize stranded lead_sightings before their executions
 * purge: reduce_finalize_stranded (08:00 UTC, recoverable) and
 * finalize_unrecoverable_stranded (08:30 UTC, the rest, anything >26h old). If
 * either silently fails (permission change, lock contention with the 03:30
 * partition purge, schema drift) the strand backlog re-accumulates with no
 * signal, re-creating the exact problem #343 fixed.
 *
 * Rather than read cron.job_run_details (which the service role may not reach),
 * this checks the OUTCOME the drains are responsible for: after a healthy 08:30
 * run, no in_flight sighting should be older than 26h. We check at 13:00 UTC
 * (well after both drains + the 09:00 export) for rows older than 30h. A
 * meaningful count means the drain stalled, whatever the cause.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendDrainStallAlert } from './slack'

// Margin past the 26h unrecoverable-drain cutoff, so normal timing never trips it.
export const DRAIN_STALL_AGE_HOURS = 30
// One missed drain day strands ~5% of ~80k leads/day (~4k rows). 500 clears small
// timing noise while catching a single missed day clearly.
export const DRAIN_STALL_THRESHOLD = 500
// Ignore rows old enough to have been purged anyway (matches the drain's floor).
const PARTITION_FLOOR_DAYS = 95

const COOLDOWN_KEY = 'drain-stall:alerted'
// Re-alert at most once per daily run while the drain stays broken (the check
// itself only runs daily, so this just guards against a double-fire).
const COOLDOWN_TTL_SECONDS = 20 * 60 * 60

export function isDrainStalled(strandedCount: number, threshold = DRAIN_STALL_THRESHOLD): boolean {
  return strandedCount >= threshold
}

export async function runDrainStallCheck(
  supabase: SupabaseClient,
  kv: KVNamespace,
): Promise<{ stranded: number; alerted: boolean }> {
  const now = Date.now()
  const cutoff = new Date(now - DRAIN_STALL_AGE_HOURS * 3600_000).toISOString()
  const floor = new Date(now - PARTITION_FLOOR_DAYS * 86400_000).toISOString()

  const { count, error } = await supabase
    .from('lead_sightings')
    .select('*', { count: 'exact', head: true })
    .eq('is_test', false)
    .eq('outcome_state', 'in_flight')
    .lt('execution_started_at_utc', cutoff)
    .gt('execution_started_at_utc', floor)
  if (error) throw new Error(`drain-stall count query failed: ${error.message}`)

  const stranded = count ?? 0
  if (!isDrainStalled(stranded)) return { stranded, alerted: false }

  // Dedup: one alert per daily run while broken (global signal, not per-org).
  if (await kv.get(COOLDOWN_KEY)) return { stranded, alerted: false }

  const { data: conns } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  let alerted = false
  for (const orgId of orgIds) {
    if (await sendDrainStallAlert(supabase, orgId, stranded)) alerted = true
  }
  if (alerted) await kv.put(COOLDOWN_KEY, '1', { expirationTtl: COOLDOWN_TTL_SECONDS })
  return { stranded, alerted }
}
