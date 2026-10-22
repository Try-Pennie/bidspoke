-- definition_schema_version on workflows and workflow_versions (#1947).
--
-- Which set of rules a stored definition is judged by. The versions and the
-- reader live in @bidspoke/workflow-definition (DEFINITION_SCHEMA_VERSIONS,
-- readSchemaStamp); only version 1 exists. The Worker stamps it on every
-- definition write and never takes it from a caller: a definition checked on
-- save gets the version this build checks by, and a copied one (a restore, a
-- duplicate) keeps the stamp of the row it was copied from.
--
-- NULLABLE WITH NO DEFAULT, on purpose. Absent means unstamped, which the
-- reader judges as version 1, the rules as they stood before any stamp. A
-- default would label every row the old code writes during the deploy window
-- as checked under rules it never met. The CHECK keeps a present value to a
-- version: a whole number from 1. smallint, because a version is a small count.
--
-- Expand only (ADR 0007): two nullable columns with no default are a catalogue
-- change with no rewrite, and the running code never names them, so applying
-- this before the code deploys is safe. The code that stamps must not deploy
-- first, which the Deploy job's unapplied migration check enforces. The CHECK
-- cannot fail on existing rows, which are all NULL, and its check of them is a
-- scan of small tables (56 workflows and 607 versions on 2026-10-22). The
-- lock_timeout keeps the brief ACCESS EXCLUSIVE lock from queueing webhook
-- cache misses behind a long running transaction; if it cannot be taken in
-- time the statement fails and is simply run again.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.workflows
  ADD COLUMN definition_schema_version smallint
  CONSTRAINT workflows_definition_schema_version_check CHECK (definition_schema_version >= 1);

ALTER TABLE public.workflow_versions
  ADD COLUMN definition_schema_version smallint
  CONSTRAINT workflow_versions_definition_schema_version_check CHECK (definition_schema_version >= 1);

COMMENT ON COLUMN public.workflows.definition_schema_version IS
  'Which rules the definition is judged by (#1947). NULL is unstamped, judged as version 1. Written only by the Worker: the version it checked a save by, or the stamp of the row a restore or duplicate copied.';
COMMENT ON COLUMN public.workflow_versions.definition_schema_version IS
  'Which rules this snapshot''s definition is judged by (#1947). NULL is unstamped, judged as version 1. A restore copies it to the workflow with the definition.';
