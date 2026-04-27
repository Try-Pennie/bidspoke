-- app_settings: org-scoped key-value store for runtime workspace settings.
-- Used for things like the Anthropic API key for the changelog drafter.
-- Values are AES-GCM encrypted with SECRET_ENCRYPTION_KEY (same scheme as
-- environment_variables secrets — IV is prepended inline in the base64).

CREATE TABLE app_settings (
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key              TEXT NOT NULL,
  value_encrypted  TEXT,
  updated_by       UUID REFERENCES users(id),
  updated_by_email TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, key)
);

CREATE TRIGGER app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "app_settings_org" ON app_settings
  FOR ALL USING (organization_id = public.user_org_id());
