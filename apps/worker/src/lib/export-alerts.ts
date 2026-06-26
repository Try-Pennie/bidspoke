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

export async function notifyExportFailure(
  supabase: SupabaseClient,
  jobName: string,
  errors: string[],
): Promise<void> {
  if (errors.length === 0) return

  const { data: conns } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  for (const orgId of orgIds) {
    try {
      await sendExportFailureAlert(supabase, orgId, null, { jobName, errors })
    } catch (err) {
      console.error(`[export-alerts] alert failed for org ${orgId}:`, err)
    }
  }
}
