-- Widen service_connections for several named connections (#2332, phase 2 of
-- #1689). RELEASE 1, STEP (a): the schema step of the expand release.
--
-- No deployed upsert may ever name a conflict target the database does not have
-- (L640). The plan split release 1 into (a) this migration and (b) the code. The
-- pull request carrying this migration also moves the one upsert,
-- integrations.ts POST /slack, to onConflict 'organization_id,service_type,name'
-- with name 'slack' and cf_secret_key null, because the deploy refuses while a
-- merged migration is unapplied (#1829): that code cannot run until this
-- migration is applied. (The regenerated types also make name required on an
-- insert, so the upsert could not stay as it was.) Still to come in (b):
-- scoping every Slack alert reader and writer to the alert row (service_type
-- 'slack', sealed_for 'bidding_ring'), which must land before release 2 lets a
-- second row per service exist.
-- Later: a migration that re-normalises cf_secret_key '' to NULL and adds
-- CHECK (num_nonnulls(cf_secret_key, credential_enc) = 1) NOT VALID, after (b) is
-- read back; and release 2, which drops the old UNIQUE and the name trigger once
-- every writer sends a name.
--
-- Everything here is additive, so the code running when it is applied keeps
-- working (CLAUDE.md, ADR 0007). That code inserts through one path only,
-- integrations.ts POST /slack, an upsert with onConflict
-- 'organization_id,service_type' that sends no name and cf_secret_key ''; the old
-- UNIQUE it names stays, the trigger below names its row, and '' is still a
-- legal cf_secret_key. Proven by supabase/tests/service_connections_expand.test.sql
-- case A.
--
-- 1. name text: backfilled to service_type, defaulted by a BEFORE INSERT trigger
--    only when NULL and the row is not an ops_key row, then NOT NULL. NOT NULL is
--    checked after BEFORE ROW triggers, so an old writer mid deploy can never
--    insert a NULL that ON CONFLICT cannot match (L168), while an ops row with no
--    name fails instead of being defaulted (Phase 8 requires an explicit name).
--    The live Slack row therefore gets the name 'slack', which is what PR (b)
--    sends.
-- 2. UNIQUE (organization_id, service_type, name), beside the old
--    UNIQUE (organization_id, service_type), which stays until release 2.
-- 3. cf_secret_key: '' normalised to NULL and the column made nullable. The live
--    Slack row holds '' because the column was NOT NULL and its token is not a
--    Cloudflare secret. A Slack save before PR (b) writes '' again; the later
--    CHECK migration re-normalises it before adding its CHECK.
-- 4. One alert row per organization: a partial unique index on
--    (organization_id) WHERE service_type = 'slack' AND sealed_for =
--    'bidding_ring', so a reader scoped to the alert row can never find two.
-- 5. The alert name is reserved: no ops_key slack row may be named 'slack', so
--    after a Disconnect has removed the alert row, the next Integrations save's
--    upsert can only ever land on an alert row, never on an ops row's
--    credential_enc and sealed_for.
-- 6. auth_type widened to the catalogue's auth kinds (service_account,
--    bot_token, oauth_client_credentials, oauth_user, key_pair, api_key),
--    keeping oauth and credentials, which the live Slack row and the older
--    connections code wrote, until a contract release after every writer has
--    moved. The service_type CHECK is NOT widened here: the catalogue
--    (packages/service-catalogue CATALOGUE) holds no service yet, so there is no
--    key to widen it to, and the CHECK that ops only services carry sealed_for
--    'ops_key' has no service to name either. Both land with the first
--    catalogue service (#2337).
-- 7. person_bound, credential_generation and target, for Phases 3, 5 and 8.
--    The existing user_id is the owner of a person bound connection; no row
--    sets it today (measured 2026-10-17: 0 of 1).
-- 8. connection_tombstones: one row per removed connection generation, so a
--    removal reaches the ops copies within a stated time even while this
--    database is down (L625). Written by Phase 8's delete. RLS on with no
--    policy, browser roles revoked: only service_role reaches it.
-- 9. delete_service_connection never deletes an ops_key row (F124). It deletes
--    by organization and service type, so once an ops Salesforce or Slack
--    connection exists, the legacy DELETE /api/connections/:service_type or the
--    Slack Disconnect would remove it while skipping the reference refusal, the
--    tombstone and the revoke Phase 8 adds. Ops rows are deleted only by Phase
--    8's own delete. Same signature, so the running routes keep calling it.
--
-- The audit (migration 20261017120000) records every column of this table
-- except the bookkeeping and secret ones it names, so name, person_bound,
-- credential_generation, target and cf_secret_key changes are recorded with
-- their values: none of them holds a secret (target is the declared host and
-- account identity). That is a conscious choice, not an omission (L657). The
-- backfill below is one audited UPDATE per existing row (production: 1 row),
-- labelled _source direct_sql because a migration has no app actor.
--
-- Who can reach what this adds: service_role only. The browser roles hold no
-- privilege on service_connections (20261017120000) and none is granted here.

SET LOCAL lock_timeout = '5s';

-- ── 1, 3. name, and cf_secret_key nullable ───────────────────────────────────

ALTER TABLE public.service_connections
  ADD COLUMN IF NOT EXISTS name text NULL;

ALTER TABLE public.service_connections
  ALTER COLUMN cf_secret_key DROP NOT NULL;

-- One UPDATE, so each row gets one audit row for both changes.
UPDATE public.service_connections
SET name = coalesce(name, service_type),
    cf_secret_key = nullif(cf_secret_key, '')
WHERE name IS NULL OR cf_secret_key = '';

CREATE OR REPLACE FUNCTION public.service_connections_default_name()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Release 1 only: the running upsert sends no name. An ops row is never
  -- defaulted, so one saved with no name fails NOT NULL (Phase 8 names it).
  -- Dropped in release 2, once every writer sends a name.
  IF NEW.name IS NULL AND NEW.sealed_for IS DISTINCT FROM 'ops_key' THEN
    NEW.name := NEW.service_type;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER service_connections_default_name
  BEFORE INSERT ON public.service_connections
  FOR EACH ROW EXECUTE FUNCTION public.service_connections_default_name();

ALTER TABLE public.service_connections
  ALTER COLUMN name SET NOT NULL;

COMMENT ON COLUMN public.service_connections.name IS
  'The connection''s name, unique per organization and service (#2332). The Slack alert row is named slack, a name no ops_key slack row may take. For display and for the upsert''s conflict target only: a workflow step refers to a connection by id, never by name.';
COMMENT ON COLUMN public.service_connections.cf_secret_key IS
  'Legacy: the name of the Cloudflare Worker secret holding the credential. NULL for a row whose credential is in credential_enc (#2332). No row of that kind exists (measured 2026-10-17) and POST /api/connections can no longer create one (#2331).';

-- ── 2. The new UNIQUE, beside the old one ────────────────────────────────────

ALTER TABLE public.service_connections
  ADD CONSTRAINT service_connections_org_type_name_unique UNIQUE (organization_id, service_type, name);

-- ── 4. One alert row per organization ────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS service_connections_one_alert_row
  ON public.service_connections (organization_id)
  WHERE service_type = 'slack' AND sealed_for = 'bidding_ring';

-- ── 5. The alert name is reserved ────────────────────────────────────────────

ALTER TABLE public.service_connections
  ADD CONSTRAINT service_connections_alert_name_reserved
    CHECK (NOT (service_type = 'slack' AND name = 'slack' AND sealed_for = 'ops_key'));

-- ── 6. auth_type widened ─────────────────────────────────────────────────────

ALTER TABLE public.service_connections
  DROP CONSTRAINT IF EXISTS service_connections_auth_type_check;
ALTER TABLE public.service_connections
  ADD CONSTRAINT service_connections_auth_type_check
    CHECK (auth_type IN (
      'service_account', 'bot_token', 'oauth_client_credentials', 'oauth_user', 'key_pair', 'api_key',
      -- Legacy, kept until the contract release after every writer has moved.
      'oauth', 'credentials'
    ));

-- ── 7. Columns for the later phases ──────────────────────────────────────────

ALTER TABLE public.service_connections
  ADD COLUMN IF NOT EXISTS person_bound boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS credential_generation bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS target jsonb NULL;

ALTER TABLE public.service_connections
  ADD CONSTRAINT service_connections_credential_generation_positive CHECK (credential_generation >= 1);

COMMENT ON COLUMN public.service_connections.person_bound IS
  'True when the connection acts as one person (an OAuth user login), whose owner is user_id (#1689 Phase 5). False for an organization''s shared login.';
COMMENT ON COLUMN public.service_connections.credential_generation IS
  'Bumped each time the credential is replaced (#1689). Bound into the sealed envelope''s AAD and named by connection_tombstones, so an older generation can be refused.';
COMMENT ON COLUMN public.service_connections.target IS
  'The declared host and account identity the credential may act as (#1689 Phase 5), checked at mint. No secret.';

-- ── 8. connection_tombstones ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.connection_tombstones (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  -- Not a foreign key: the connection row is gone by the time this is read.
  connection_id   uuid NOT NULL,
  generation      bigint NOT NULL CHECK (generation >= 1),
  removed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, generation)
);

CREATE INDEX IF NOT EXISTS idx_connection_tombstones_org
  ON public.connection_tombstones (organization_id, removed_at);

ALTER TABLE public.connection_tombstones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.connection_tombstones FROM PUBLIC;
REVOKE ALL ON TABLE public.connection_tombstones FROM anon;
REVOKE ALL ON TABLE public.connection_tombstones FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.connection_tombstones TO service_role;

COMMENT ON TABLE public.connection_tombstones IS
  'One row per removed connection generation (#2332, #1689). The ops Worker checks its last good copy of a connection against this, so a removal reaches it within a stated time even while this database is down. service_role only.';

-- ── 9. delete_service_connection spares ops_key rows (F124) ──────────────────

CREATE OR REPLACE FUNCTION public.delete_service_connection(p_organization_id uuid, p_service_type text, p_actor uuid)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
AS $$
BEGIN
  -- Transaction local, so it names this call's delete and nothing after it.
  PERFORM set_config('bidspoke.actor_id', coalesce(p_actor::text, ''), true);
  -- Never an ops_key row (#2332, F124): those are removed only by Phase 8's
  -- delete, which refuses a referenced connection, writes the tombstone and
  -- revokes. A lone ops row of this type is left in place and the caller sees
  -- no row deleted (its 404).
  RETURN QUERY
    DELETE FROM public.service_connections sc
    WHERE sc.organization_id = p_organization_id
      AND sc.service_type = p_service_type
      AND sc.sealed_for IS DISTINCT FROM 'ops_key'
    RETURNING sc.id;
  PERFORM set_config('bidspoke.actor_id', '', true);
END
$$;

REVOKE ALL ON FUNCTION public.delete_service_connection(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_service_connection(uuid, text, uuid) TO service_role;
