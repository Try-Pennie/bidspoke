-- Sign in with your own Google account: the sign in's single use state (#2338,
-- build PR 13; R17). EXPAND only.
--
-- WHY. Sign in with Google sends the person's browser to Google and back, with a
-- `state` Google returns untouched. The state must say who started the sign in
-- (user and organization), which connection it is for, and the PKCE verifier
-- and redirect URI the code exchange must repeat; it must expire, and it must
-- be used once: a callback replayed, or two callbacks racing with one state,
-- must never both exchange. The plan (#2338) puts it in this database, never KV
-- (a KV get then delete is neither atomic nor consistent), and claims it with
-- one UPDATE whose WHERE holds every condition, so the row lock makes exactly
-- one of two racing claims win.
--
-- WHAT.
-- 1. oauth_states: one row per sign in started. The id is the state Google
--    carries: a v4 uuid the database draws (122 random bits), never chosen by a
--    caller, and useful only to the user and organization that started it,
--    since the claim names both. The verifier is a PKCE secret worth nothing
--    without the code Google gives only to that person's browser and the sign
--    in app's secret, which lives only on the ops Worker; it is kept here ten
--    minutes at most and never read back except by the one claim that wins.
-- 2. create_oauth_state: writes a row expiring ten minutes from the database's
--    own clock, and first deletes rows expired over a day ago (at most 1,000 a
--    call, so a backlog never makes one sign in slow), which is how the table
--    stays small: nothing else deletes from it.
-- 3. claim_oauth_state: the one UPDATE that consumes a state (consumed_at)
--    when it is this user's and organization's, unused and unexpired, answering
--    the row's contents with outcome claimed; otherwise it consumes nothing and
--    answers why by name: used, expired, or not_found (no such state, or
--    another user's or organization's, which read alike so a state cannot be
--    probed). An expired state is answered expired whether or not it was used.
--
-- Who can reach it: service_role only (the bidding Worker's sign in routes,
-- which take a user JWT and pass its user and organization). RLS on with no
-- policy, and every privilege revoked by name from PUBLIC, anon and
-- authenticated on the table and both functions (the platform's default grants
-- would otherwise give the browser roles the table, L124, L714). Whose data: the
-- one state named, and only when its user and organization are the caller's.
--
-- Additive (ADR 0007): a new table and two new functions, which no deployed
-- code calls until the sign in routes ship with this release.
--
-- Guarded by supabase/tests/oauth_states.test.sql.

SET LOCAL lock_timeout = '5s';

-- ── 1. oauth_states ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.oauth_states (
  state_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The catalogue key the person signs in to (google).
  service_type    text NOT NULL CHECK (service_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- The connection the sign in saves: a fresh id for a new one, the row's own for a Reconnect.
  connection_id   uuid NOT NULL,
  -- The name a new connection takes; null for a Reconnect, which keeps its own.
  name            text NULL CHECK (name IS NULL OR (btrim(name) <> '' AND char_length(name) <= 100)),
  reconnect       boolean NOT NULL,
  -- The sign in app's client id the authorize link named, sealed into the new login.
  client_id       text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 512),
  verifier        text NOT NULL CHECK (verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  redirect_uri    text NOT NULL CHECK (redirect_uri ~ '^https://' AND char_length(redirect_uri) <= 2048),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz NULL,
  CONSTRAINT oauth_states_name_iff_new CHECK (reconnect = (name IS NULL)),
  CONSTRAINT oauth_states_expiry_bounded CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON public.oauth_states (expires_at);

ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.oauth_states FROM PUBLIC;
REVOKE ALL ON TABLE public.oauth_states FROM anon;
REVOKE ALL ON TABLE public.oauth_states FROM authenticated;
REVOKE ALL ON TABLE public.oauth_states FROM service_role;

COMMENT ON TABLE public.oauth_states IS
  'One row per Sign in with Google started (#2338, R17): who started it, which connection it saves, and the PKCE verifier and redirect URI the code exchange repeats. Written by create_oauth_state and consumed once by claim_oauth_state; no role reaches the table directly.';

-- ── 2. create_oauth_state ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_oauth_state(
  p_organization_id uuid,
  p_user_id uuid,
  p_service_type text,
  p_connection_id uuid,
  p_name text,
  p_reconnect boolean,
  p_client_id text,
  p_verifier text,
  p_redirect_uri text
)
RETURNS TABLE (state_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout = '2s'
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  IF p_organization_id IS NULL OR p_user_id IS NULL OR p_connection_id IS NULL OR p_reconnect IS NULL THEN
    RAISE EXCEPTION 'oauth_state_invalid: organization, user, connection and reconnect are required' USING ERRCODE = '22023';
  END IF;
  -- The user must be of the organization: a state is never made for anyone else's.
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id AND u.organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'oauth_state_invalid: the user is not of the organization' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.oauth_states o
  WHERE o.state_id IN (
    SELECT s.state_id FROM public.oauth_states s
    WHERE s.expires_at < v_now - interval '1 day'
    ORDER BY s.expires_at
    LIMIT 1000
  );

  RETURN QUERY
  INSERT INTO public.oauth_states AS o (
    organization_id, user_id, service_type, connection_id, name, reconnect, client_id, verifier, redirect_uri, created_at, expires_at
  ) VALUES (
    p_organization_id, p_user_id, p_service_type, p_connection_id, p_name, p_reconnect, p_client_id, p_verifier, p_redirect_uri, v_now, v_now + interval '10 minutes'
  )
  RETURNING o.state_id, o.expires_at;
END
$$;

REVOKE ALL ON FUNCTION public.create_oauth_state(uuid, uuid, text, uuid, text, boolean, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_oauth_state(uuid, uuid, text, uuid, text, boolean, text, text, text) TO service_role;

COMMENT ON FUNCTION public.create_oauth_state(uuid, uuid, text, uuid, text, boolean, text, text, text) IS
  'Starts one Sign in with Google (#2338): a state for the user of the organization, expiring in 10 minutes on this database''s clock. Deletes states expired over a day ago first. service_role only.';

-- ── 3. claim_oauth_state ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.claim_oauth_state(p_state_id uuid, p_organization_id uuid, p_user_id uuid)
RETURNS TABLE (
  outcome text, service_type text, connection_id uuid, name text, reconnect boolean, client_id text, verifier text, redirect_uri text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout = '2s'
AS $$
DECLARE
  v_row public.oauth_states%ROWTYPE;
BEGIN
  IF p_state_id IS NULL OR p_organization_id IS NULL OR p_user_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::uuid, NULL::text, NULL::boolean, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- The one claim: every condition in the WHERE, so of two racing claims the second
  -- waits on the first's row lock, re-reads consumed_at and matches nothing.
  UPDATE public.oauth_states o
  SET consumed_at = now()
  WHERE o.state_id = p_state_id
    AND o.organization_id = p_organization_id
    AND o.user_id = p_user_id
    AND o.consumed_at IS NULL
    AND o.expires_at > now()
  RETURNING o.* INTO v_row;

  IF FOUND THEN
    RETURN QUERY SELECT 'claimed'::text, v_row.service_type, v_row.connection_id, v_row.name, v_row.reconnect, v_row.client_id, v_row.verifier, v_row.redirect_uri;
    RETURN;
  END IF;

  -- Why not: by name, and nothing of the row.
  SELECT * INTO v_row FROM public.oauth_states o
  WHERE o.state_id = p_state_id AND o.organization_id = p_organization_id AND o.user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::uuid, NULL::text, NULL::boolean, NULL::text, NULL::text, NULL::text;
  ELSIF v_row.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::text, NULL::uuid, NULL::text, NULL::boolean, NULL::text, NULL::text, NULL::text;
  ELSE
    RETURN QUERY SELECT 'used'::text, NULL::text, NULL::uuid, NULL::text, NULL::boolean, NULL::text, NULL::text, NULL::text;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.claim_oauth_state(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_oauth_state(uuid, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.claim_oauth_state(uuid, uuid, uuid) IS
  'Consumes one Sign in with Google state (#2338) when it is the user''s and organization''s, unused and unexpired, answering its contents with outcome claimed; otherwise consumes nothing and answers used, expired or not_found. Of two racing claims exactly one is claimed. service_role only.';
