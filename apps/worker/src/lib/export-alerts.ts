/**
 * Export-failure alerting (#412).
 *
 * The nightly Snowflake export jobs (sightings-export, achieve-export) catch their
 * own errors and accumulate them into a returned `summary.errors[]` rather than
 * throwing, so a Snowflake outage was previously only console-logged with no page.
 * This notifies every Slack-connected org when an export reports errors. The export
 * jobs are global (one Snowflake account), so like the required-secrets guard there
 * is no single org to target. No-ops on a clean run.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendExportFailureAlert } from './slack'

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

// Backstop so a genuinely persistent outage still gets a reminder page rather
// than going silent forever if it never recovers.
export const EXPORT_ALERT_BACKSTOP_TTL_SECONDS = 8 * 60 * 60

export async function notifyExportFailure(
  supabase: SupabaseClient,
  jobName: string,
  errors: string[],
  kv?: KvLike,
): Promise<void> {
  const stateKey = `export-alert-state:${jobName}`

  if (errors.length === 0) {
    if (kv) await kv.delete(stateKey)
    return
  }

  // Already paged for this ongoing issue; stay quiet until it recovers (the
  // key is cleared above) or the backstop TTL expires.
  if (kv && (await kv.get(stateKey))) return

  const { data: conns } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  let delivered = false
  for (const orgId of orgIds) {
    try {
      if (await sendExportFailureAlert(supabase, orgId, null, { jobName, errors })) delivered = true
    } catch (err) {
      console.error(`[export-alerts] alert failed for org ${orgId}:`, err)
    }
  }

  // Only start the cooldown once something actually delivered -- otherwise a
  // Slack outage would suppress retries for hours while nobody got paged.
  if (kv && delivered) await kv.put(stateKey, '1', { expirationTtl: EXPORT_ALERT_BACKSTOP_TTL_SECONDS })
}
