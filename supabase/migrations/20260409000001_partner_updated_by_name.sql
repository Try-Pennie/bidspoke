-- Add updated_by_name to partner_configs to mirror the workflows table
ALTER TABLE partner_configs ADD COLUMN IF NOT EXISTS updated_by_name TEXT;
