-- Add unique constraint to service_connections so upsert ON CONFLICT works
ALTER TABLE service_connections
  ADD CONSTRAINT service_connections_org_type_unique UNIQUE (organization_id, service_type);
