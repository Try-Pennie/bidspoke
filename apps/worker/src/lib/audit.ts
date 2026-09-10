import type { SupabaseClient } from '@supabase/supabase-js'
import { isPermanentDbError, sleep, type DbError } from './db-retry'

export type AuditEntityType =
  | 'partner_config'
  | 'partner_bid_config'
  | 'environment_variable'
  | 'service_connection'
  | 'service_preset'
  | 'user_allowlist'
  | 'workflow'
  | 'circuit_breaker'
  | 'app_setting'
  | 'folder'
  | 'env_var_folder'
  | 'webhook_endpoint'
  | 'api_source'
  | 'partner_uuid'
  | 'field_presence_silence'
  // A subject erasure across the archive and both sightings tables (#875).
  | 'archive_erasure'
  // One archived execution read back out of Snowflake (#874). Every archived
  // read is audited, because the archive holds full fidelity PII for thirteen
  // months and a read of it is the access that has to be accountable.
  | 'execution_archive'

export type AuditAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'circuit_force_closed'
  | 'secret_rotated'
  | 'secret_revealed'
  | 'secrets_resynced'
  | 'schema_synced'
  | 'field_silence_set'
  | 'field_silence_cleared'
  | 'subject_erased'
  // A dry run of an erasure. Distinct from subject_erased because nothing was
  // removed, and a reader must not take one for the other (#823).
  | 'subject_erasure_previewed'
  | 'archived_execution_read'
  // A search of the archive by trace id or SSN (#874). The term is deliberately
  // not recorded: an SSN written here would be the identity copied into a
  // second store with its own retention.
  | 'archive_searched'

/**
 * How long to wait between audit-write attempts (#277).
 *
 * Sized against the same window the step logger's ladder covers: the nightly
 * partition purge takes an ACCESS EXCLUSIVE lock for a few seconds, and an
 * insert landing inside it fails with a statement timeout. One attempt meant a
 * lock, a blip or a dropped connection destroyed the audit row for a mutation
 * that had already happened, and that row is the one record which cannot be
 * reconstructed afterwards.
 *
 * Exported so a test can drive the ladder without waiting for it.
 */
export const AUDIT_RETRY_DELAYS_MS = [2_000, 5_000]

export async function writeAuditLog(
  supabase: SupabaseClient,
  orgId: string,
  entityType: AuditEntityType,
  entityId: string,
  action: AuditAction,
  changedBy: string,
  changes?: Record<string, unknown>,
  retryDelaysMs: number[] = AUDIT_RETRY_DELAYS_MS
): Promise<void> {
  const row = {
    organization_id: orgId,
    entity_type: entityType,
    entity_id: entityId,
    action,
    changed_by: changedBy,
    changes: changes ?? null,
  }

  let lastError: DbError | null = null
  let attempts = 0
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0) await sleep(retryDelaysMs[attempt - 1])
    attempts++
    const { error } = await supabase.from('audit_log').insert(row)
    if (!error) return
    lastError = error as DbError
    // A permanent error (a bad value, a missing column) fails identically on
    // every attempt, so spending the ladder on it only delays the report.
    if (isPermanentDbError(lastError)) break
  }

  // Best-effort by design: an audit failure must not fail the user's mutation,
  // which has already succeeded. But it must not vanish either. A dropped audit
  // row defeats the audit-everything invariant, and that is exactly how the
  // stale entity_type/action CHECK constraints silently rejected newer audits
  // for months (#105). Log once, after the ladder, naming how many attempts
  // were made so a one-off blip reads differently from a sustained outage.
  console.error('[audit] failed to write audit row:', {
    entityType,
    entityId,
    action,
    attempts,
    message: lastError?.message,
    code: lastError?.code,
  })
}
