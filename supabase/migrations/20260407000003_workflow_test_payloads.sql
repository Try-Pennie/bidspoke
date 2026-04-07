-- Add test_payloads column to workflows for saved test payload reuse
-- Each entry: { name: string, payload: unknown }

ALTER TABLE workflows
  ADD COLUMN IF NOT EXISTS test_payloads jsonb NOT NULL DEFAULT '[]'::jsonb;
