# Backward-compatible (expand/contract) migrations + deployment runbook

Schema and code deploy as two separately-timed actions with no transactional link: CI verifies migrations are applied but does not apply them, and the developer runs `supabase db push` by hand. To stop that gap from corrupting prod, **every migration must be backward-compatible with the currently-running code**, so the apply and the code deploy can happen in either order without a window where code and schema disagree.

## Status

**Accepted** (#272, 2026-06-25). Adopts the expand/contract discipline + documents the deploy ordering. The pipeline is NOT auto-applying migrations (no prod DB password in CI); the manual `supabase db push` stays, made safe by the discipline below.

## Context

The deploy is two pipelines (`.github/workflows/`):

- **ci.yml**: lint, typecheck, test, and the types-drift guard (the `DB types regenerated with schema migrations` step of the Security scans job, fails a schema-changing migration that didn't regenerate `apps/worker/src/types/database.ts`, #364).
- **deploy.yml** — a `Verify` job (typecheck/lint/test/docs + a **migration check**) gating path-filtered `Deploy Worker / Pages / Worker Tail` jobs.

The migration check (`Check for unapplied migrations`) runs `supabase migration list --linked` and FAILS if any local migration is unapplied on prod. The ops database (`supabase-ops/`, #1709) has the same check in the Deploy Ops Worker job, which refuses the ops deploy rather than the bidding one; apply its migrations with `supabase --workdir supabase-ops db push --linked`. Both run `.github/scripts/check-unapplied-migrations.sh` (#1829). It has the access token to *list* but not the DB password to *apply*, so the developer applies migrations by hand with `supabase db push`, then re-runs the deploy. That manual ordering is the friction; the correctness risk is the **disagreement window**: the seconds-to-minutes where prod code and prod schema are out of step.

Auto-applying in the pipeline would narrow that window but needs a prod DB credential in CI and accepts auto-apply-to-prod. We instead **eliminate** the window by making migrations backward-compatible, so order never matters. The failure modes are real: incident #237 (a DDL storm 503'd PostgREST and dropped lead-sightings rows) shows schema changes can disrupt the live code path.

## Decision: expand/contract

A single migration must never break the code that is currently running in prod, and a code deploy must work whether or not its migration has applied yet. Concretely:

1. **Additive only in one step.** A migration may ADD tables, columns, indexes, constraints `NOT VALID`, functions, and policies. It must NOT in the same migration rename or drop anything the running code reads or writes.
2. **New columns are nullable or have a default**, so the currently-running code (which doesn't set them) keeps inserting/updating fine.
3. **Renames and type changes are a two-release expand/contract**, never a single migration:
   - *Expand:* add the new column/table alongside the old; deploy code that writes BOTH and reads the new with a fallback to the old.
   - *Migrate:* backfill the new from the old.
   - *Contract:* in a LATER release, once nothing reads the old, drop it.
4. **Drops and destructive changes are contract-phase only** — they ship in a separate, later migration after the deploy that stopped using the column/table is fully live. Never drop in the same release that introduces the replacement.
5. **Constraints that can fail validation** are added `NOT VALID` first, then `VALIDATE CONSTRAINT` in a later step, so the add doesn't block on a full-table scan that could lock the live path.
6. **`CREATE OR REPLACE FUNCTION`** (the strand-drain pattern) is inherently backward-compatible as long as the signature is unchanged — preferred over drop+recreate.

Because each migration is additive and each release reads defensively, the apply and the deploy are order-independent: old code tolerates the new (additive) schema, and new code tolerates the old schema during the expand phase.

## Deployment runbook (a change that includes a migration)

1. Write the migration to the rules above (additive / expand/contract). If the change is a rename/drop, split it across two releases.
2. Prove it against a real Postgres: `bash scripts/sql-suite/run.sh` (#1409) replays every migration from empty into a throwaway `supabase/postgres` container on 127.0.0.1:54329 and runs `supabase/tests/*.test.sql`. Write the test for a new function, policy or grant in that directory first and watch it fail. The pre push hook runs the suite when the branch itself changed `supabase/` (see The SQL suite harness below).
3. If the migration changes table/column/type DDL or adds a function, regenerate types from the throwaway rather than from production: `SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:54329/postgres pnpm --filter worker db:types`, and commit `apps/worker/src/types/database.ts` in the SAME commit (CI's `DB types regenerated with schema migrations` step enforces this, #364). The generator splices the `__InternalSupabase` block from the committed file, since only the hosted generator emits it. A column that exists in production but in no migration shows up here as a deletion in the diff; add the migration for it rather than accepting the deletion (`20260921221010_workflows_updated_by_name.sql` is the precedent).
4. Pick the next unused migration version: `ls supabase/migrations/` and use the next `YYYYMMDDNNNNNN` prefix (two files sharing a version collide on `db push`).
5. Commit the migration + code together and push to main.
6. Apply to prod: `supabase db push`. Safe to run before the code deploy finishes: the additive migration does not break the still-running old code.
7. The Deploy `Verify` job's migration check now passes. If Deploy already ran and failed Verify before the apply, re-run it: `gh run rerun --failed <run-id>` (find it with `gh run list --workflow Deploy --branch main --limit 1`). Confirm per-job conclusions, since an overall "success" can hide a SKIPPED path-gated deploy job.
8. The path-gated `Deploy Worker / Pages / Worker Tail` jobs ship the code.

For a **rename/drop** (expand/contract), repeat the cycle twice: release 1 = expand + dual-write + backfill; release 2 (after release 1 is fully live) = contract (drop the old).

## The SQL suite harness

`bash scripts/sql-suite/run.sh` starts a throwaway `supabase/postgres` Docker container on port 54329. It is never production: the harness reaches it only through `docker exec`, so it has no connection string that could point anywhere else. It bootstraps the handful of objects the hosted platform provides outside migrations (`scripts/sql-suite/bootstrap.sql`), replays every file in `supabase/migrations/` from empty, then runs `supabase/tests/*.test.sql`.

- **The ops project** (`supabase-ops/`, #1709) has its own suite: `SQL_SUITE_PROJECT=ops bash scripts/sql-suite/run.sh` uses its own container on port 54330, bootstrapped to the live ops project's measured grants (`scripts/sql-suite/bootstrap-ops.sql`), and runs `supabase-ops/supabase/tests`.
- **When the pre push hook runs it.** Whenever the branch itself changed `supabase/`, the rpc allowlist (`apps/worker/src/lib/read-only-rpcs.json`) or the harness, measured from its merge base with origin/main by `scripts/pre-push-sql-suites.sh`; the ops suite when the branch changed `supabase-ops/`. It runs both suites when the merge base cannot be computed (#2412). `SKIP_SQL_SUITE=1` skips it for a one time reason, explained to Dan first.
- **One run per container** (#3012). Only one run uses a project's container at a time: a run that finds another worktree's or session's run in it waits up to 10 minutes (`SQL_SUITE_LOCK_WAIT`), then refuses naming that run's pid, start time and worktree. A lock left by a killed run is taken over (`scripts/sql-suite/lock.sh`).
- **A function a route calls through `rpc`** also needs an entry in `supabase/required-live-objects.json` and in `apps/worker/src/lib/read-only-rpcs.json` (the local dev write guard's allowlist, described in CLAUDE.md).

## The Data API's exposed schemas (#1710)

The list lives in a migration, not the dashboard. `20261006180000_porting_inventory_1710.sql` sets `ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, porting'`, and once that role setting exists the dashboard's "Exposed schemas" field no longer governs the list.

- To expose or drop a schema, change that setting in a new migration, listing every schema, and `NOTIFY pgrst, 'reload config'`.
- Drop a schema from the list before dropping the schema itself, or PostgREST cannot build its cache (PGRST002).
- `supabase/tests/porting_inventory.test.sql` asserts the current list.
- The types generator names each schema the typed client reads (`public` and `porting`) in `apps/worker/scripts/gen-db-types.sh`.

## The `porting` schema (#1710)

It holds the Pipedream move's inventory (`pipedream_inventory`, `pipedream_workflow_map`): service role only, RLS on with no policy, anon and authenticated revoked.

- `node scripts/porting/load-inventory.ts <export dir> --org <uuid> [--apply]` loads an export. It prints its plan and writes nothing without `--apply`.
- `node scripts/porting/unlock-table.ts <export dir>` prints the unlock table and the derived build order.
- Both read the export through `packages/porting-evidence/src/inventory/`.
- A workflow that will not be ported, or a step left out of a port, is recorded only by `node scripts/porting/record-decision.ts` (#2979), never by hand. `--retire` sets `porting_stage` to retired with who decided, why and when, and `--drop-step` adds a row to `porting.dropped_steps`. It prints its plan and writes nothing without `--apply`. The loader never writes either, so a reload keeps every decision, and the unlock table leaves both out. The decisions themselves are Dan's.

## Consequences

- The manual `supabase db push` stays, but it is now safe in any order relative to the deploy, so a forgotten or mistimed apply degrades to "the migration check fails, re-run after applying" rather than a code/schema disagreement that corrupts data.
- Destructive/irreversible changes are deliberately split into a later contract release, which also gives a rollback window (the old column survives one release).
- This does not add migration reversibility, which is tracked separately (production-readiness item #28 / DR work). The ephemeral Postgres apply test this line once deferred exists since #1409: `scripts/sql-suite/run.sh` replays every migration from empty locally and the pre push hook runs it. CI does not run it yet (#1139).
- If the manual-apply friction proves too costly, the escalation is to auto-apply in the pipeline (add `SUPABASE_DB_PASSWORD`, run `supabase db push` in a reviewed pre-deploy step); the expand/contract discipline remains correct under that change too.
