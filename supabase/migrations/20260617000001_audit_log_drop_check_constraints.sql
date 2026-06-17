-- Drop the audit_log entity_type and action CHECK constraints (#105).
--
-- Both were frozen at their original value sets (entity_type: partner_config,
-- environment_variable, service_connection, workflow, circuit_breaker; action:
-- created, updated, deleted, circuit_force_closed, secret_rotated) and drifted
-- from the app's AuditEntityType / AuditAction unions as the product grew. Since
-- writeAuditLog swallows insert errors, every audit write with a newer value
-- (folder, app_setting, partner_bid_config, service_preset, user_allowlist,
-- secret_revealed, schema_synced, and the new webhook_endpoint / api_source /
-- partner_uuid) was SILENTLY rejected and never recorded.
--
-- The typed unions in apps/worker/src/lib/audit.ts are now the single source of
-- truth for valid entity types and actions. Drop the DB checks so the audit
-- trail stops dropping rows on the floor.
--
-- audit_log has no other CHECK constraints, so dropping all of them by
-- introspection removes exactly these two regardless of their generated names.
DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'audit_log'::regclass AND contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE audit_log DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;
