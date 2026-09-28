# Postgres restore drill

How to prove — on a cadence — that Bidspoke's Postgres can actually be restored from a backup, and how long it takes. A backup you have never restored is not a backup; it is a hope. This drill turns that hope into a measured, repeatable fact. It is the companion to the [disaster recovery runbook](./disaster-recovery.md) and closes production-readiness issue #270.

## Why this exists

Bidspoke's only stateful system of record is the Supabase Postgres database. Everything else (Workers, Pages, KV, DOs) is redeployable from git. The database is backed by **Supabase managed daily backups** (see [Backup tier](#backup-tier) below) — but nothing in-repo had ever exercised a restore, so the real recovery time (RTO) and the integrity of the backups were unknown. This drill establishes both.

## Backup tier

- **Plan:** Supabase **Pro** (org "Pennie", project `xvrmivmpfykwwtriqwpg`, region us-west-2).
- **Backups:** automated **daily** logical backups, **7-day** retention (Pro default). Worst-case data loss (RPO) is therefore up to ~24h — the gap between the last nightly backup and a failure.
- **PITR:** **not enabled** (deliberate, 2026-06-26 — see [RTO/RPO targets](./disaster-recovery.md#targets)). PITR (~$100/mo add-on) would cut RPO to ~2 min and is the only thing that can recover from a destructive migration to the moment-before. Revisit if the ~24h RPO becomes unacceptable.
- **Independent backups that survive a Supabase loss:** workflow definitions (pushed to the `bidspoke-workflows` GitHub repo on every save) and lead-sighting/bid outcomes (nightly Snowflake export). These are not full-database backups; they narrow the blast radius of the ~24h RPO for the two highest-value data sets.

To confirm the managed backups exist and their span, open the Supabase dashboard → project → **Database → Backups**; the list shows each daily backup and the retention window.

## What the drill restores (and what it skips)

The database is ~25 GB, but most of that is **rebuildable execution-log partitions** (`execution_steps*`, `workflow_executions*`, `achieve_evaluations*`) and **raw-SSN tables** (`persons`, `lead_sightings*`, `lead_sighting_bids*`). The drill restores:

- **All schema** — every table's structure, plus functions, RLS policies, indexes, sequences.
- **Config / system-of-record data only**: the tables in `DRILL_COPY_TABLES` in `scripts/dr-drill-tables.sh` (workflows, versions, partner configs, bid matrix, buyer profiles and their pricing, hours, blackouts and sales, env vars, sources, endpoints, allowlist, audit log, and so on). This is the data needed to **resume bidding**.

It deliberately **does not copy the bulk execution logs or the raw-SSN tables' data**, for two reasons: (1) they are not needed to bring bidding back, and (2) copying 6 GB of SSNs into a throwaway project is an avoidable PII spread. Their full restore is a Supabase-managed operation (the bulk follows the same physical backup) and its time is dominated by raw data size; the figure below is the **"resume-bidding" RTO**, which is the number that matters for getting money moving again.

The table list is an explicit **allow-list**, not an exclude-glob, because a money and PII system must never silently widen what gets copied. (An earlier exclude-glob approach was abandoned after it leaked `execution_steps` data.)

Every table must be in exactly one of the two lists in `scripts/dr-drill-tables.sh`: `DRILL_COPY_TABLES` or `DRILL_STRUCTURE_ONLY_TABLES`. Two checks hold that, because the row count verification compares only the copied tables and so can never notice a table that is missing from the list:

- **In CI**, `apps/web/src/lib/__tests__/dr-drill-table-coverage.test.ts` fails when a migration creates a table in neither list. So a new table is classified in the pull request that adds it, not three months later.
- **In the drill**, the script lists the live database's tables before dumping anything and refuses to run if one is unlisted, which covers a table created outside the migrations.

This was added on 2026-09-28, when the June list turned out to be missing all five buyer profile tables: the drill would have restored them empty and still printed PASS.

## Procedure

Prerequisites: `pg_dump`/`psql` **v17+** on PATH. On macOS:

```bash
brew install libpq
export PATH="$(brew --prefix libpq)/bin:$PATH"
```

1. **Start the clock.** Note the wall-clock time — a true RTO includes project-provision time.
2. **Create a scratch project** (this is the "new project" you would stand up in a real loss):
   ```bash
   supabase projects create bidspoke-dr-drill \
     --org-id dbhikzlyzfynfdoifjlu --region us-west-2 \
     --db-password "$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"
   ```
   Wait until it is `ACTIVE_HEALTHY` (a minute or two). Cost is ~$10/mo prorated — pennies for the hour it lives.
3. **Get the two connection strings** from Supabase → Project Settings → Database → Connection string → URI: the production project (`SOURCE_DB_URL`, read-only use here) and the scratch project (`TARGET_DB_URL`).
4. **Run the drill:**
   ```bash
   SOURCE_DB_URL='postgresql://postgres:<pw>@db.<prod-ref>.supabase.co:5432/postgres' \
   TARGET_DB_URL='postgresql://postgres:<pw>@db.<scratch-ref>.supabase.co:5432/postgres' \
   scripts/dr-restore-drill.sh
   ```
   The script dumps schema + config data, restores into the scratch project, verifies every restored table's row count source-vs-target, and prints `PASS`/`FAIL` plus elapsed time. It refuses to run if the target host equals the source host.
5. **Record the result** in the [results log](#results-log) below: date, total elapsed (proven RTO), pass/fail, and anything that drifted (a new table to add to the allow-list, a schema object that failed to restore).
6. **Delete the scratch project** (Supabase dashboard → Project Settings → General → Delete project). It holds real config data and encrypted secrets — do not leave it running.

## Cadence

Re-run **quarterly** (and after any major schema change or migration that adds/removes a system-of-record table). The reminder is a recurring Google Calendar event linking this doc. If the drill refuses because a table is unlisted, add it to one of the two lists in `scripts/dr-drill-tables.sh` and re-run.

## Results log

| Date | Operator | Proven RTO (resume-bidding) | Result | Notes |
|------|----------|------------------------------|--------|-------|
| 2026-06-26 | dwright@trypennie.com | ~8 min | **PASS** (24/24 tables, all 28 RLS policies) | First drill (closes #270). Phase breakdown: scratch-project provision ~2 min; dump (schema+roles+config data) ~47s; restore ~4.5 min; verify ~15s. The restore time is dominated by per-statement network round-trips from a laptop to us-west-2 (266s for ~1,000 DDL statements) — a co-located runner or Supabase's native managed restore would be materially faster. The lone count diff (`workflow_stats_daily` off by 1) was live prod writing a row after the snapshot, not a restore fault. |

### Method caveats (read before trusting the RTO)

- The ~8 min figure is the **resume-bidding** RTO from a laptop-driven **logical** restore of schema + config data. It is an honest upper bound for "get the engine able to bid again," not the full-database restore time.
- **Full-history restore** (the 25 GB of execution logs + raw-SSN tables this drill skips) is a Supabase-managed **physical** restore; its time scales with raw data size and is largely Supabase-side. It was not exercised here to avoid spreading 6 GB of SSNs into a throwaway project.
- Restoring is only part of a real recovery. End-to-end "back in business" also requires the Cloudflare Worker/Pages redeploy and re-provisioning the worker secrets — see the [disaster recovery runbook](./disaster-recovery.md).
