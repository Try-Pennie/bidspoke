-- The last good copy of each ops version's plain variables (#2999, phase 3 of #2982).
--
-- Dan, 2026-10-28 and 29: an ops run reads each variable's current value when
-- it starts, asked of the bidding Worker by the tick that claimed it (#2998);
-- if bidding cannot be reached, the run uses the last kept copy, and a copy
-- past its age limit is refused. Ops never stores a secret's value, so a run
-- that reads a secret can never use the copy (it waits and is tried again).
--
--   ops_variable_copy_versions  one row per (organization, workflow, version)
--                        the copy holds. Its existence says the version's
--                        whole list of names was written, so a fallback can
--                        tell a name bidding said is absent from one it was
--                        never asked about. served_at is the bidding Worker's
--                        clock when it served the values; confirmed_at is
--                        this database's clock when the copy was last written
--                        or confirmed unchanged, which the copy's age is
--                        judged by (the ops Worker's COPIES_STALE_AFTER_MS).
--   ops_variable_copies  one row per name the version reads: plain (with its
--                        value), secret (by NAME only: its value is held null
--                        by a CHECK), or absent (bidding has no such
--                        variable). The version's rows are its whole list.
--   save_variable_copies  the one writer (the minute tick, through
--                        ops-writes.ts saveVariableCopies). Each entry replaces
--                        its version's rows whole, writing only the rows that
--                        changed: a key whose kind and value are unchanged is
--                        not rewritten, a name the version no longer lists is
--                        deleted, and the version row moves only when a key
--                        changed or its confirmed_at is older than
--                        p_confirm_every_seconds. Batched: many versions, of
--                        any organizations, in one call. A version of a
--                        workflow the ops database holds no copy of under that
--                        organization is skipped and counted, as is one served
--                        earlier than the copy it would replace.
--   variable_copies      one organization's copies of the versions asked about
--                        (read only), with the database clock to judge their
--                        age by.
--   purge_variable_copies  deletes, a page at a time, the copies confirmed
--                        more than 6 hours ago (COPIES_STALE_AFTER_MS, which a
--                        fallback refuses anyway) and those of a workflow that
--                        is switched off, deleted, no longer named by the
--                        bidding Worker's complete list (left the ops lane), or
--                        that no copy names. The ops tick runs it in the
--                        nightly observation_purge sweep.
--
-- ADDITIVE ONLY (ADR 0007, L640): two new tables and four new functions;
-- nothing existing changes, so the ops Worker running when this is applied
-- works unchanged. The Worker that writes the copies needs this applied first:
-- without it the copy write and read fail by name each tick (counted, never a
-- run lost), and runs go back to the queue unstarted as before.
--
-- WHAT EACH STATEMENT DOES TO PRODUCTION ROWS: creates two empty tables and
-- their functions; no existing row changes.
-- Guarded by supabase-ops/supabase/tests/variable_copies.test.sql.

SET lock_timeout = '5s';

-- ── tables ────────────────────────────────────────────────────────────────────
CREATE TABLE public.ops_variable_copy_versions (
  organization_id  uuid NOT NULL,
  workflow_id      uuid NOT NULL,
  version_number   integer NOT NULL CONSTRAINT ops_variable_copy_versions_version_check CHECK (version_number >= 1),
  served_at        timestamptz NOT NULL,
  confirmed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_variable_copy_versions_pkey PRIMARY KEY (organization_id, workflow_id, version_number)
);

CREATE TABLE public.ops_variable_copies (
  organization_id  uuid NOT NULL,
  workflow_id      uuid NOT NULL,
  version_number   integer NOT NULL,
  key              text NOT NULL CONSTRAINT ops_variable_copies_key_check CHECK (key ~ '^[A-Za-z0-9_]+$' AND octet_length(key) <= 256),
  -- The vocabulary's TypeScript home is apps/worker/src/ops/run-vocabulary.ts (VARIABLE_COPY_KINDS),
  -- and apps/web/src/lib/__tests__/ops-run-vocabulary-matches-db.test.ts fails when the two differ.
  kind             text NOT NULL CONSTRAINT ops_variable_copies_kind_check CHECK (kind IN ('plain', 'secret', 'absent')),
  value            text,
  changed_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_variable_copies_pkey PRIMARY KEY (organization_id, workflow_id, version_number, key),
  CONSTRAINT ops_variable_copies_version_fkey FOREIGN KEY (organization_id, workflow_id, version_number)
    REFERENCES public.ops_variable_copy_versions (organization_id, workflow_id, version_number) ON DELETE CASCADE,
  -- Only a plain variable holds a value: a secret is kept by name alone, never its value.
  CONSTRAINT ops_variable_copies_value_check CHECK ((kind = 'plain') = (value IS NOT NULL)),
  CONSTRAINT ops_variable_copies_value_size CHECK (value IS NULL OR octet_length(value) <= 65536)
);

-- The purge's walks: by age, and by workflow.
CREATE INDEX ops_variable_copy_versions_confirmed_idx ON public.ops_variable_copy_versions (confirmed_at);
CREATE INDEX ops_variable_copy_versions_workflow_idx ON public.ops_variable_copy_versions (workflow_id);

-- ── privileges: the choke point, as for every ops table ──────────────────────
ALTER TABLE public.ops_variable_copy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ops_variable_copies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_variable_copy_versions, public.ops_variable_copies FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.ops_variable_copy_versions, public.ops_variable_copies FROM service_role;
GRANT SELECT ON public.ops_variable_copy_versions, public.ops_variable_copies TO service_role;

-- ── save_variable_copies ──────────────────────────────────────────────────────
-- p_copies: an array of at most 1000 entries, each exactly
--   { organization_id, workflow_id, version_number, served_at, values, secret_keys, absent_keys }
-- values an object of names to text, secret_keys and absent_keys arrays of
-- names, no name twice across the three, at most 500 names a version. There is
-- no field a secret's value could travel in: an entry with any other key is
-- refused by name, and so is the whole call, before anything is written.
CREATE FUNCTION public.save_variable_copies(p_copies jsonb, p_confirm_every_seconds integer)
RETURNS TABLE (versions_written integer, versions_unchanged integer, keys_written integer, keys_deleted integer, refused_no_copy integer, refused_older integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_entry jsonb;
  v_org uuid;
  v_wf uuid;
  v_version integer;
  v_served timestamptz;
  v_names text[];
  v_held public.ops_variable_copy_versions%ROWTYPE;
  v_copy_org uuid;
  v_new boolean;
  v_changed integer;
  v_deleted integer;
  v_written integer := 0;
  v_unchanged integer := 0;
  v_keys integer := 0;
  v_keys_deleted integer := 0;
  v_no_copy integer := 0;
  v_older integer := 0;
BEGIN
  IF p_confirm_every_seconds IS NULL OR p_confirm_every_seconds NOT BETWEEN 0 AND 3600 THEN
    RAISE EXCEPTION 'save_variable_copies: confirm every must be 0 to 3600 seconds, not %', p_confirm_every_seconds USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_copies IS NULL OR jsonb_typeof(p_copies) <> 'array' THEN
    RAISE EXCEPTION 'save_variable_copies: the copies are an array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_copies) > 1000 THEN
    RAISE EXCEPTION 'save_variable_copies: at most 1000 versions a call, not %', jsonb_array_length(p_copies) USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Every entry checked before any is written, so a call is all or nothing on its shape.
  FOR v_entry IN SELECT e FROM jsonb_array_elements(p_copies) e LOOP
    IF jsonb_typeof(v_entry) <> 'object' OR (SELECT array_agg(k COLLATE "C" ORDER BY k COLLATE "C") FROM jsonb_object_keys(v_entry) k)
       IS DISTINCT FROM ARRAY['absent_keys', 'organization_id', 'secret_keys', 'served_at', 'values', 'version_number', 'workflow_id'] COLLATE "C" THEN
      RAISE EXCEPTION 'save_variable_copies: each copy is exactly { organization_id, workflow_id, version_number, served_at, values, secret_keys, absent_keys } (a secret''s value is never kept)'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF jsonb_typeof(v_entry -> 'organization_id') <> 'string' OR (v_entry ->> 'organization_id') !~ '^[0-9a-fA-F-]{36}$'
       OR jsonb_typeof(v_entry -> 'workflow_id') <> 'string' OR (v_entry ->> 'workflow_id') !~ '^[0-9a-fA-F-]{36}$' THEN
      RAISE EXCEPTION 'save_variable_copies: a copy''s organization_id and workflow_id are uuids' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF jsonb_typeof(v_entry -> 'version_number') <> 'number' OR (v_entry ->> 'version_number') !~ '^[1-9][0-9]{0,8}$' THEN
      RAISE EXCEPTION 'save_variable_copies: a copy''s version_number is a whole number from 1' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF jsonb_typeof(v_entry -> 'served_at') <> 'string'
       OR (v_entry ->> 'served_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN
      RAISE EXCEPTION 'save_variable_copies: a copy''s served_at is a time' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF jsonb_typeof(v_entry -> 'values') <> 'object' OR jsonb_typeof(v_entry -> 'secret_keys') <> 'array' OR jsonb_typeof(v_entry -> 'absent_keys') <> 'array' THEN
      RAISE EXCEPTION 'save_variable_copies: a copy''s values are an object, and its secret_keys and absent_keys arrays' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(v_entry -> 'values') e WHERE jsonb_typeof(e.value) <> 'string') THEN
      RAISE EXCEPTION 'save_variable_copies: a copy''s plain values are text' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_entry -> 'secret_keys') s WHERE jsonb_typeof(s) <> 'string')
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_entry -> 'absent_keys') s WHERE jsonb_typeof(s) <> 'string') THEN
      RAISE EXCEPTION 'save_variable_copies: a copy''s secret_keys and absent_keys are names' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT array_agg(n) INTO v_names FROM (
      SELECT jsonb_object_keys(v_entry -> 'values') AS n
      UNION ALL SELECT jsonb_array_elements_text(v_entry -> 'secret_keys')
      UNION ALL SELECT jsonb_array_elements_text(v_entry -> 'absent_keys')
    ) a;
    IF coalesce(cardinality(v_names), 0) > 500 THEN
      RAISE EXCEPTION 'save_variable_copies: at most 500 names a version' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_names) n WHERE n !~ '^[A-Za-z0-9_]+$' OR octet_length(n) > 256) THEN
      RAISE EXCEPTION 'save_variable_copies: a copy names a variable that is not a variable name' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF (SELECT count(*) FROM unnest(v_names)) <> (SELECT count(DISTINCT n) FROM unnest(v_names) n) THEN
      RAISE EXCEPTION 'save_variable_copies: a copy names a variable twice (plain, secret or absent, never two of them)' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each_text(v_entry -> 'values') e WHERE octet_length(e.value) > 65536) THEN
      RAISE EXCEPTION 'save_variable_copies: a plain value is at most 65536 bytes' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;

  -- In one order, so two overlapping ticks lock the versions in the same order.
  FOR v_entry IN
    SELECT e FROM jsonb_array_elements(p_copies) e
    ORDER BY (e ->> 'organization_id'), (e ->> 'workflow_id'), (e ->> 'version_number')::integer
  LOOP
    v_org := (v_entry ->> 'organization_id')::uuid;
    v_wf := (v_entry ->> 'workflow_id')::uuid;
    v_version := (v_entry ->> 'version_number')::integer;
    v_served := (v_entry ->> 'served_at')::timestamptz;

    -- Only a workflow the ops database holds a copy of, under this organization.
    SELECT c.organization_id INTO v_copy_org FROM public.ops_workflow_copies c WHERE c.workflow_id = v_wf;
    IF NOT FOUND OR v_copy_org <> v_org THEN
      v_no_copy := v_no_copy + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.ops_variable_copy_versions (organization_id, workflow_id, version_number, served_at, confirmed_at)
    VALUES (v_org, v_wf, v_version, v_served, v_now)
    ON CONFLICT ON CONSTRAINT ops_variable_copy_versions_pkey DO NOTHING;
    v_new := FOUND;
    SELECT * INTO v_held FROM public.ops_variable_copy_versions v
    WHERE v.organization_id = v_org AND v.workflow_id = v_wf AND v.version_number = v_version FOR UPDATE;
    IF NOT v_new AND v_held.served_at > v_served THEN
      -- Served before the copy held, by an overlapping tick's older answer: kept as held.
      v_older := v_older + 1;
      CONTINUE;
    END IF;

    WITH wanted AS (
      SELECT e.key, 'plain'::text AS kind, e.value FROM jsonb_each_text(v_entry -> 'values') e
      UNION ALL SELECT s, 'secret', NULL FROM jsonb_array_elements_text(v_entry -> 'secret_keys') s
      UNION ALL SELECT s, 'absent', NULL FROM jsonb_array_elements_text(v_entry -> 'absent_keys') s
    ), gone AS (
      DELETE FROM public.ops_variable_copies k
      WHERE k.organization_id = v_org AND k.workflow_id = v_wf AND k.version_number = v_version
        AND NOT EXISTS (SELECT 1 FROM wanted w WHERE w.key = k.key)
      RETURNING 1
    )
    SELECT count(*) INTO v_deleted FROM gone;

    WITH wanted AS (
      SELECT e.key, 'plain'::text AS kind, e.value FROM jsonb_each_text(v_entry -> 'values') e
      UNION ALL SELECT s, 'secret', NULL FROM jsonb_array_elements_text(v_entry -> 'secret_keys') s
      UNION ALL SELECT s, 'absent', NULL FROM jsonb_array_elements_text(v_entry -> 'absent_keys') s
    ), put AS (
      INSERT INTO public.ops_variable_copies AS k (organization_id, workflow_id, version_number, key, kind, value, changed_at)
      SELECT v_org, v_wf, v_version, w.key, w.kind, w.value, v_now FROM wanted w
      ON CONFLICT ON CONSTRAINT ops_variable_copies_pkey DO UPDATE
        SET kind = excluded.kind, value = excluded.value, changed_at = excluded.changed_at
        -- Only a row that changed is rewritten.
        WHERE (k.kind, k.value) IS DISTINCT FROM (excluded.kind, excluded.value)
      RETURNING 1
    )
    SELECT count(*) INTO v_changed FROM put;

    v_keys := v_keys + v_changed;
    v_keys_deleted := v_keys_deleted + v_deleted;
    IF v_new THEN
      v_written := v_written + 1;
    ELSIF v_changed > 0 OR v_deleted > 0 OR v_held.confirmed_at <= v_now - make_interval(secs => p_confirm_every_seconds) THEN
      UPDATE public.ops_variable_copy_versions v SET served_at = v_served, confirmed_at = v_now
      WHERE v.organization_id = v_org AND v.workflow_id = v_wf AND v.version_number = v_version;
      v_written := v_written + 1;
    ELSE
      v_unchanged := v_unchanged + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_written, v_unchanged, v_keys, v_keys_deleted, v_no_copy, v_older;
END
$fn$;

-- ── variable_copies ───────────────────────────────────────────────────────────
-- One organization's copies of the versions asked about, at most 1000, each
-- exactly { workflow_id, version_number }. A version the copy does not hold is
-- left out. The plain values, the secret names (never a value: none is held),
-- the absent names, and the database clock to judge the copy's age by.
CREATE FUNCTION public.variable_copies(p_organization_id uuid, p_versions jsonb)
RETURNS TABLE (
  workflow_id uuid, version_number integer, served_at timestamptz, confirmed_at timestamptz,
  plain_values jsonb, secret_keys text[], absent_keys text[], db_now timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'variable_copies: an organization is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_versions IS NULL OR jsonb_typeof(p_versions) <> 'array' OR jsonb_array_length(p_versions) > 1000 THEN
    RAISE EXCEPTION 'variable_copies: the versions are an array of at most 1000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_versions) a
    WHERE jsonb_typeof(a) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(a)) <> 2
      OR jsonb_typeof(a -> 'workflow_id') <> 'string' OR (a ->> 'workflow_id') !~ '^[0-9a-fA-F-]{36}$'
      OR jsonb_typeof(a -> 'version_number') <> 'number' OR (a ->> 'version_number') !~ '^[1-9][0-9]{0,8}$'
  ) THEN
    RAISE EXCEPTION 'variable_copies: each version asked about is exactly { workflow_id: uuid, version_number: whole number from 1 }' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT v.workflow_id, v.version_number, v.served_at, v.confirmed_at,
    coalesce((SELECT jsonb_object_agg(k.key, k.value) FROM public.ops_variable_copies k
      WHERE k.organization_id = v.organization_id AND k.workflow_id = v.workflow_id AND k.version_number = v.version_number AND k.kind = 'plain'), '{}'::jsonb),
    coalesce((SELECT array_agg(k.key ORDER BY k.key) FROM public.ops_variable_copies k
      WHERE k.organization_id = v.organization_id AND k.workflow_id = v.workflow_id AND k.version_number = v.version_number AND k.kind = 'secret'), '{}'::text[]),
    coalesce((SELECT array_agg(k.key ORDER BY k.key) FROM public.ops_variable_copies k
      WHERE k.organization_id = v.organization_id AND k.workflow_id = v.workflow_id AND k.version_number = v.version_number AND k.kind = 'absent'), '{}'::text[]),
    now()
  FROM public.ops_variable_copy_versions v
  WHERE v.organization_id = p_organization_id
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_versions) a
      WHERE (a ->> 'workflow_id')::uuid = v.workflow_id AND (a ->> 'version_number')::integer = v.version_number)
  ORDER BY v.workflow_id, v.version_number;
END
$fn$;

-- ── purge_variable_copies ─────────────────────────────────────────────────────
-- 6 hours is the ops Worker's COPIES_STALE_AFTER_MS, past which a fallback
-- refuses the copy; ops-run-vocabulary-matches-db.test.ts compares the two.
-- A workflow is gone from the lane when no copy names it under the version's
-- organization, or its copy says it is switched off (is_active false), deleted,
-- or withdrawn (the bidding Worker's complete list stopped naming it, which is
-- how a workflow leaving the ops lane reaches ops).
CREATE FUNCTION public.purge_variable_copies(p_limit integer)
RETURNS TABLE (purged integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_cutoff timestamptz := now() - interval '6 hours';
  v_rows integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'purge_variable_copies: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH old AS (
    SELECT v.organization_id, v.workflow_id, v.version_number FROM public.ops_variable_copy_versions v
    WHERE v.confirmed_at <= v_cutoff
      OR NOT EXISTS (
        SELECT 1 FROM public.ops_workflow_copies c
        WHERE c.workflow_id = v.workflow_id AND c.organization_id = v.organization_id
          AND c.is_active AND c.deleted_at IS NULL AND c.withdrawn_at IS NULL)
    ORDER BY v.confirmed_at, v.workflow_id, v.version_number
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), gone AS (
    DELETE FROM public.ops_variable_copy_versions v USING old
    WHERE v.organization_id = old.organization_id AND v.workflow_id = old.workflow_id AND v.version_number = old.version_number
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM gone;
  RETURN QUERY SELECT v_rows, v_rows = p_limit;
END
$fn$;

-- ── function privileges ───────────────────────────────────────────────────────
DO $grants$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('save_variable_copies', 'variable_copies', 'purge_variable_copies')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;

RESET lock_timeout;
