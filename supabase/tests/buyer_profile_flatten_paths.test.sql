-- buyer_profile_flatten against the shared fixture (#2132, L26).
--
-- packages/buyer-profile/fixtures/flatten-cases.json holds documents with the
-- paths they flatten to in both spellings. Vitest checks the TypeScript flatten
-- and normaliseSqlPath against it; this checks the SQL flatten, so a change to
-- either spelling that the other does not follow fails in one suite or the other.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds, which copies the fixture into the container. Reads nothing else.
--
-- Mutation tried: one SQL path removed from the fixture's "sql" list: red.

CREATE TEMP TABLE IF NOT EXISTS suite_cases (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now());
DELETE FROM suite_cases;

DO $do$
DECLARE
  v_fixture jsonb := pg_read_file('/sql-suite-fixtures/buyer-profile/flatten-cases.json')::jsonb;
  c jsonb;
  v_got text[];
  v_want text[];
BEGIN
  IF jsonb_array_length(coalesce(v_fixture -> 'cases', '[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'the flatten fixture holds no cases'; END IF;
  FOR c IN SELECT * FROM jsonb_array_elements(v_fixture -> 'cases') LOOP
    SELECT coalesce(array_agg(f.path ORDER BY f.path COLLATE "C"), '{}') INTO v_got FROM public.buyer_profile_flatten(c -> 'document') f;
    SELECT coalesce(array_agg(p ORDER BY p COLLATE "C"), '{}') INTO v_want FROM jsonb_array_elements_text(c -> 'paths' -> 'sql') p;
    IF v_got IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION 'case "%": buyer_profile_flatten gave % but the fixture says %', c ->> 'name', v_got, v_want;
    END IF;
    INSERT INTO suite_cases(name) VALUES ('flatten: ' || (c ->> 'name'));
  END LOOP;
END
$do$;

DO $do$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM suite_cases;
  IF n IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'buyer_profile_flatten_paths.test.sql: expected 2 cases, % ran', n; END IF;
  RAISE NOTICE 'buyer_profile_flatten_paths.test.sql: % cases passed', n;
END
$do$;
