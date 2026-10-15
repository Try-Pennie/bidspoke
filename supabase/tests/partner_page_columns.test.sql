-- Every column the partners page edits is listed (#2132, L96).
--
-- The schema side of the registry guard. A column added to any of the five
-- tables the page edits must be listed in the committed
-- packages/buyer-profile/fixtures/partner-page-columns.json, with the registry
-- path it is edited at or excluded with a reason, so a new column cannot be
-- missing from the page's registry just because no hand typed type mentions it.
-- The web side (partner-field-registry.test.ts) checks every listed path
-- against the registry.
--
-- WHERE THIS RUNS: only on the throwaway database scripts/sql-suite/run.sh
-- builds, which copies the fixture into the container. Reads the catalogue only.
--
-- Mutations tried: a scratch column added to buyer_pricing_tiers (case 1 red);
-- version moved from bookkeeping to identity in the file (case 3 red).

CREATE TEMP TABLE IF NOT EXISTS suite_cases (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now());
DELETE FROM suite_cases;

CREATE TEMP TABLE IF NOT EXISTS page_columns AS
  SELECT t.key AS table_name, c.key AS column_name, c.value AS entry
  FROM jsonb_each(pg_read_file('/sql-suite-fixtures/buyer-profile/partner-page-columns.json')::jsonb -> 'tables') t,
       jsonb_each(t.value) c;

-- ── 1. Every column of the five tables is listed ─────────────────────────────
DO $do$
DECLARE missing text[];
BEGIN
  SELECT array_agg(format('%s.%s', c.table_name, c.column_name) ORDER BY c.table_name, c.column_name) INTO missing
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name IN ('partner_configs', 'buyer_profiles', 'buyer_operating_windows', 'buyer_blackout_dates', 'buyer_pricing_tiers')
    AND NOT EXISTS (SELECT 1 FROM page_columns p WHERE p.table_name = c.table_name AND p.column_name = c.column_name);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'columns not listed in partner-page-columns.json (give each its registry path, or exclude it with a reason): %', array_to_string(missing, ', ');
  END IF;
  INSERT INTO suite_cases(name) VALUES ('every column listed');
END
$do$;

-- ── 2. Every entry is a real column, with a path or a reasoned exclusion ─────
DO $do$
DECLARE bad text[];
BEGIN
  SELECT array_agg(format('%s.%s', p.table_name, p.column_name) ORDER BY p.table_name, p.column_name) INTO bad
  FROM page_columns p
  WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = p.table_name AND c.column_name = p.column_name)
     OR ((p.entry ? 'path' OR p.entry ? 'paths') = (p.entry ? 'excluded'))
     OR (p.entry ? 'excluded' AND (p.entry ->> 'excluded' NOT IN ('identity', 'bookkeeping') OR coalesce(p.entry ->> 'reason', '') = ''));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'entries that are not a column, or carry neither or both of a path and an exclusion, or an exclusion without a kind and reason: %', array_to_string(bad, ', ');
  END IF;
  INSERT INTO suite_cases(name) VALUES ('every entry well formed');
END
$do$;

-- ── 3. partner_configs bookkeeping is exactly the unversioned list ───────────
DO $do$
DECLARE v_listed text[]; v_unversioned text[];
BEGIN
  SELECT coalesce(array_agg(p.column_name ORDER BY p.column_name), '{}') INTO v_listed
  FROM page_columns p WHERE p.table_name = 'partner_configs' AND p.entry ->> 'excluded' = 'bookkeeping';
  SELECT coalesce(array_agg(u ORDER BY u), '{}') INTO v_unversioned
  FROM unnest(public.partner_configs_unversioned_columns()) u
  WHERE NOT EXISTS (SELECT 1 FROM page_columns p WHERE p.table_name = 'partner_configs' AND p.column_name = u AND (p.entry ? 'path' OR p.entry ? 'paths'));
  IF v_listed IS DISTINCT FROM v_unversioned THEN
    RAISE EXCEPTION 'partner_configs columns excluded as bookkeeping % differ from the unversioned columns the page does not edit %', v_listed, v_unversioned;
  END IF;
  INSERT INTO suite_cases(name) VALUES ('bookkeeping matches unversioned list');
END
$do$;

DO $do$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM suite_cases;
  IF n IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'partner_page_columns.test.sql: expected 3 cases, % ran', n; END IF;
  RAISE NOTICE 'partner_page_columns.test.sql: % cases passed', n;
END
$do$;
