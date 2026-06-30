import type { SupabaseClient } from '@supabase/supabase-js'

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

export async function writeAuditLog(
  supabase: SupabaseClient,
  orgId: string,
  entityType: AuditEntityType,
  entityId: string,
  action: AuditAction,
  changedBy: string,
  changes?: Record<string, unknown>
): Promise<void> {
  // Best-effort: an audit failure must not fail the user's mutation. But it must
  // not vanish silently either — a dropped audit row defeats the audit-everything
  // invariant (this is exactly how the stale entity_type/action CHECK constraints
  // silently rejected newer audits for months, #105). Log so it's visible.
  const { error } = await supabase.from('audit_log').insert({
    organization_id: orgId,
    entity_type: entityType,
    entity_id: entityId,
    action,
    changed_by: changedBy,
    changes: changes ?? null,
  })
  if (error) {
    console.error('[audit] failed to write audit row:', { entityType, action, message: error.message })
  }
}
