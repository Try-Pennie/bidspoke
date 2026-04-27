import type { SupabaseClient } from '@supabase/supabase-js'

export type AuditEntityType =
  | 'partner_config'
  | 'environment_variable'
  | 'service_connection'
  | 'service_preset'
  | 'user_allowlist'
  | 'workflow'
  | 'circuit_breaker'
  | 'app_setting'

export type AuditAction =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'circuit_force_closed'
  | 'secret_rotated'
  | 'secret_revealed'
  | 'schema_synced'

export async function writeAuditLog(
  supabase: SupabaseClient,
  orgId: string,
  entityType: AuditEntityType,
  entityId: string,
  action: AuditAction,
  changedBy: string,
  changes?: Record<string, unknown>
): Promise<void> {
  await supabase.from('audit_log').insert({
    organization_id: orgId,
    entity_type: entityType,
    entity_id: entityId,
    action,
    changed_by: changedBy,
    changes: changes ?? null,
  })
}
