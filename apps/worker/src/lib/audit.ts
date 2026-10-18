import type { SupabaseClient } from '@supabase/supabase-js'
import { isPermanentDbError, sleep, type DbError } from './db-retry'

export type AuditEntityType =
  | 'partner_config'
  | 'partner_bid_config'
  // A buyer's eligibility profile and a sale to a buyer (#1409). The profile row
  // is written by the database itself (save_buyer_profile and the table triggers);
  // a settlement is written here by the settle route (#1412), after the ledger
  // has recorded it. One vocabulary either way.
  | 'buyer_profile'
  | 'buyer_sale'
  // A click claim buyer_click_send left held, released by a person from the
  // partner page (#1552): marked sent, freed, or cleared from the list.
  | 'held_click'
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
  // The worker's own recovery secrets (#384): a SECRET_ENCRYPTION_KEY re-lock, and
  // the one-time sealed handover of SSN_HASH_PEPPER, which ran once on 2026-09-28
  // and whose route is deleted. Neither row holds a value.
  | 'recovery_secret'
  // A stranded lead recovery run by hand (#380), entity id the function's name.
  | 'strand_recovery'
  // A failed post-answer Salesforce write held for replay (#471), entity id its row.
  | 'held_salesforce_write'
  // One archived execution read back out of Snowflake (#874). Every archived
  // read is audited, because the archive holds full fidelity PII for thirteen
  // months and a read of it is the access that has to be accountable.
  | 'execution_archive'
  // The Better Stack page for "nobody can be told in Slack" (#2063), entity id
  // the alert's name. Written when a person sends a drill page (#1303).
  | 'outage_page'
  // One run of the ops key restore drill (#2333), entity id the drill id
  // POST /api/admin/seal-canary generates and returns with its envelope.
  | 'ops_key_restore_drill'

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
  | 'secrets_reencrypted'
  | 'strand_recovery_run'
  // #471. A preview decrypts the held write and reads Salesforce, so it is
  // audited too, under its own action so it never reads as a send.
  | 'held_write_replay_previewed'
  | 'held_write_replayed'
  | 'held_write_abandoned'
  // Written once, on 2026-09-28; nothing writes it now. Kept so that row reads.
  | 'ssn_pepper_escrow_sealed'
  // A dry run of an erasure. Distinct from subject_erased because nothing was
  // removed, and a reader must not take one for the other (#823).
  | 'subject_erasure_previewed'
  | 'archived_execution_read'
  // A search of the archive by trace id or SSN (#874). The term is deliberately
  // not recorded: an SSN written here would be the identity copied into a
  // second store with its own retention.
  | 'archive_searched'
  // A drill page sent to Better Stack by hand (#1303), with what came of it.
  | 'outage_page_drilled'
  // A restore drill canary sealed to an ops public key and returned (#2333),
  // with the kid in changes. Nothing was stored but this row.
  | 'canary_sealed'

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

/** One field's movement, the shape the database audit triggers and the settle route write. */
export interface FieldChange {
  old: unknown
  new: unknown
}

/**
 * The fields that moved between two snapshots of a record, each as its old and
 * new value (#1085, L529). Only the fields named are compared, so a caller
 * never records a column by accident (a secret's ciphertext, a timestamp), and
 * only the ones that moved are returned, so an entry says what changed rather
 * than restating the row. Compared by JSON value, which is what the store holds.
 */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[],
): Record<string, FieldChange> {
  const out: Record<string, FieldChange> = {}
  for (const f of fields) {
    const was = before[f] ?? null
    const now = after[f] ?? null
    if (JSON.stringify(was) !== JSON.stringify(now)) out[f] = { old: was, new: now }
  }
  return out
}

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
  await recordAuditLog(supabase, orgId, entityType, entityId, action, changedBy, changes, retryDelaysMs)
}

/**
 * The same write, answering whether the row landed, for a caller whose audit
 * entry is the ONLY record of something (a held click's Salesforce outcome,
 * #1659), so a failure can be reported rather than read later as nothing
 * having happened (L11). Still best effort: it never throws.
 */
export async function recordAuditLog(
  supabase: SupabaseClient,
  orgId: string,
  entityType: AuditEntityType,
  entityId: string,
  action: AuditAction,
  changedBy: string,
  changes?: Record<string, unknown>,
  retryDelaysMs: number[] = AUDIT_RETRY_DELAYS_MS
): Promise<boolean> {
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
    if (!error) return true
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
  return false
}
