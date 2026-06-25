# Backward-compatible (expand/contract) migrations + deployment runbook

Schema and code deploy as two separately-timed actions with no transactional link: CI verifies migrations are applied but does not apply them, and the developer runs `supabase db push` by hand. To stop that gap from corrupting prod, **every migration must be backward-compatible with the currently-running code**, so the apply and the code deploy can happen in either order without a window where code and schema disagree.

## Status

**Accepted** (#272, 2026-06-25). Adopts the expand/contract discipline + documents the deploy ordering. The pipeline is NOT auto-applying migrations (no prod DB password in CI); the manual `supabase db push` stays, made safe by the discipline below.

## Context

The deploy is two pipelines (`.github/workflows/`):

- **ci.yml** — lint, typecheck, test, and the types-drift guard (`db-types-fresh`, fails a schema-changing migration that didn't regenerate `apps/worker/src/types/database.ts`, #364).
- **deploy.yml** — a `Verify` job (typecheck/lint/test/docs + a **migration check**) gating path-filtered `Deploy Worker / Pages / Worker Tail` jobs.

The migration check (`Check for unapplied migrations`) runs `supabase migration list --linked` and FAILS if any local migration is unapplied on prod. It has the access token to *list* but not the DB password to *apply*, so the developer applies migrations by hand with `supabase db push`, then re-runs the deploy. That manual ordering is the friction; the correctness risk is the **disagreement window** — the seconds-to-minutes where prod code and prod schema are out of step.

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
2. If the migration changes table/column/type DDL, regenerate types: `pnpm --filter worker db:types`, and commit `apps/worker/src/types/database.ts` in the SAME commit (CI's `db-types-fresh` guard enforces this, #364).
3. Pick the next unused migration version: `ls supabase/migrations/` and use the next `YYYYMMDDNNNNNN` prefix (two files sharing a version collide on `db push`).
4. Commit the migration + code together and push to main.
5. Apply to prod: `supabase db push`. Safe to run before the code deploy finishes — the additive migration does not break the still-running old code.
6. The Deploy `Verify` job's migration check now passes. If Deploy already ran and failed Verify before the apply, re-run it: `gh run rerun --failed <run-id>` (find it with `gh run list --workflow Deploy --branch main --limit 1`). Confirm per-job conclusions — an overall "success" can hide a SKIPPED path-gated deploy job.
7. The path-gated `Deploy Worker / Pages / Worker Tail` jobs ship the code.

For a **rename/drop** (expand/contract), repeat the cycle twice: release 1 = expand + dual-write + backfill; release 2 (after release 1 is fully live) = contract (drop the old).

## Consequences

- The manual `supabase db push` stays, but it is now safe in any order relative to the deploy, so a forgotten or mistimed apply degrades to "the migration check fails, re-run after applying" rather than a code/schema disagreement that corrupts data.
- Destructive/irreversible changes are deliberately split into a later contract release, which also gives a rollback window (the old column survives one release).
- This does not add migration reversibility or an ephemeral-Postgres apply test — those are tracked separately (production-readiness item #28 / DR work).
- If the manual-apply friction proves too costly, the escalation is to auto-apply in the pipeline (add `SUPABASE_DB_PASSWORD`, run `supabase db push` in a reviewed pre-deploy step); the expand/contract discipline remains correct under that change too.
