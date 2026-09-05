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
import { logReadFailure } from './scheduled-read'
import { sendExportFailureAlert } from './slack'
import { buildFixHint, buildConsequence, isTransientExportError } from './export-error-hints'

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

// Backstop so a genuinely persistent outage still gets a reminder page rather
// than going silent forever if it never recovers.
export const EXPORT_ALERT_BACKSTOP_TTL_SECONDS = 8 * 60 * 60

// How long a held-back first transient failure stays armed. Must outlive one
// full cycle of the slowest job (the daily Achieve export) so its "next run"
// still sees the marker; refreshed on every consecutive failure, cleared by the
// first clean run.
export const EXPORT_ALERT_PENDING_TTL_SECONDS = 26 * 60 * 60

export async function notifyExportFailure(
  supabase: SupabaseClient,
  jobName: string,
  errors: string[],
  kv?: KvLike,
): Promise<void> {
  const stateKey = `export-alert-state:${jobName}`
  const pendingKey = `export-alert-pending:${jobName}`

  if (errors.length === 0) {
    if (kv) {
      await kv.delete(stateKey)
      await kv.delete(pendingKey)
    }
    return
  }

  // Transient-failure grace (2026-07-24): every run automatically re-attempts
  // whatever the failed run left behind, so a lone connectivity blip self-heals
  // and paging on it is noise. Hold the FIRST all-transient failure silently and
  // page only when the next run fails too. Anything a retry cannot fix (auth,
  // permissions, schema, unrecognised errors) still pages immediately.
  let failingSince: string | undefined
  if (kv && errors.every(isTransientExportError)) {
    const pending = await kv.get(pendingKey)
    if (!pending) {
      await kv.put(pendingKey, new Date().toISOString(), { expirationTtl: EXPORT_ALERT_PENDING_TTL_SECONDS })
      console.log(`[export-alerts] ${jobName}: transient failure held (no alert unless the next run also fails):`, errors)
      return
    }
    // Keep the original first-failure time and re-arm the TTL so a long outage
    // cannot expire the marker mid-outage and silently restart the grace.
    await kv.put(pendingKey, pending, { expirationTtl: EXPORT_ALERT_PENDING_TTL_SECONDS })
    failingSince = pending
  }

  // Already paged for this ongoing issue; stay quiet until it recovers (the
  // key is cleared above) or the backstop TTL expires.
  if (kv && (await kv.get(stateKey))) return

  const { data: conns, error: connsError } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  logReadFailure('export-alerts', 'slack connections', connsError)
  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  // Classify once, not per org: the same errors produce the same advice. The
  // consequence sentence comes from the same classification (#1180), so the
  // alert's second sentence and its remedy cannot disagree about what happened.
  const fixHint = buildFixHint(errors)
  const consequence = buildConsequence(errors)

  let delivered = false
  for (const orgId of orgIds) {
    try {
      if (await sendExportFailureAlert(supabase, orgId, null, { jobName, errors, fixHint, consequence, failingSince })) delivered = true
    } catch (err) {
      console.error(`[export-alerts] alert failed for org ${orgId}:`, err)
    }
  }

  // Only start the cooldown once something actually delivered -- otherwise a
  // Slack outage would suppress retries for hours while nobody got paged.
  if (kv && delivered) await kv.put(stateKey, '1', { expirationTtl: EXPORT_ALERT_BACKSTOP_TTL_SECONDS })
}
