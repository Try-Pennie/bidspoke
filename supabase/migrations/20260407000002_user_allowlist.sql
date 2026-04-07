-- User access allowlist — replaces hardcoded auth-allowlist.ts
-- Only emails in this table can sign in, regardless of Supabase auth status.

CREATE TABLE user_allowlist (
  email      TEXT        PRIMARY KEY,
  added_by   TEXT        NOT NULL DEFAULT 'system',
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_allowlist ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read the list (needed for middleware checks via anon key + session)
CREATE POLICY "allowlist_read" ON user_allowlist
  FOR SELECT TO authenticated USING (true);

-- Seed with initial approved users
INSERT INTO user_allowlist (email, added_by) VALUES
  ('sam@trypennie.com',    'system'),
  ('geoff@trypennie.com',  'system'),
  ('dwright@trypennie.com','system'),
  ('bnelms@trypennie.com', 'system'),
  ('nmogil@trypennie.com', 'system');
