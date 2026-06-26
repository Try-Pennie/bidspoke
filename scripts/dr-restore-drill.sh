#!/usr/bin/env bash
#
# dr-restore-drill.sh — Bidspoke disaster-recovery restore drill.
#
# Proves that Bidspoke's Postgres can be rebuilt from a backup into a fresh
# (scratch) Supabase project, and measures how long it takes (the proven RTO).
# Run this on the cadence in docs/disaster-recovery/restore-drill.md (quarterly).
#
# WHAT IT DOES
#   1. Dumps the SOURCE database: full schema + the config / system-of-record
#      tables' data (the data needed to resume bidding). It deliberately does
#      NOT copy the large, rebuildable execution-log partitions or the raw-SSN
#      tables (persons, lead_sightings, lead_sighting_bids) — see TABLES below.
#   2. Restores schema then data into the TARGET (scratch) database.
#   3. Verifies row counts match between source and target for every restored
#      table.
#   4. Prints the elapsed wall-clock time (proven RTO for "resume bidding").
#
# WHAT IT DOES NOT DO (do these by hand — see the runbook):
#   - Create the scratch project   (Supabase dashboard, or `supabase projects create`)
#   - Delete the scratch project    (Supabase dashboard — it holds real data)
#   The clock for a true RTO also includes project-provision time; record that
#   from project-create to the moment this script prints PASS.
#
# REQUIREMENTS
#   - pg_dump / psql v17+ on PATH. On macOS: brew install libpq, then
#       export PATH="$(brew --prefix libpq)/bin:$PATH"
#
# USAGE
#   SOURCE_DB_URL='postgresql://postgres:<pw>@db.<prod-ref>.supabase.co:5432/postgres' \
#   TARGET_DB_URL='postgresql://postgres:<pw>@db.<scratch-ref>.supabase.co:5432/postgres' \
#   scripts/dr-restore-drill.sh
#
#   Get each connection string from Supabase: Project Settings -> Database ->
#   Connection string -> URI. SOURCE is production (read-only use here); TARGET
#   is the scratch project you created for the drill.
#
set -euo pipefail

: "${SOURCE_DB_URL:?Set SOURCE_DB_URL to the production connection string (read-only)}"
: "${TARGET_DB_URL:?Set TARGET_DB_URL to the scratch project connection string}"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT   # dump files contain config data + encrypted secrets; clean up

# Config / system-of-record tables whose DATA we restore. This is an EXPLICIT
# allow-list, not an exclude-glob, on purpose: a money/PII system must never
# silently widen what gets copied. The large rebuildable log partitions
# (execution_steps*, workflow_executions*, achieve_evaluations*) and the raw-SSN
# tables (persons, lead_sightings*, lead_sighting_bids*) are intentionally
# absent — they are not needed to resume bidding and copying them would spread
# SSNs into the scratch project. Their STRUCTURE is still restored (schema dump
# below covers all tables); only their bulk data is skipped.
TABLES=(
  workflows workflow_versions organizations users user_allowlist api_sources
  source_workflow_assignments partner_configs partner_bid_configs bid_matrix_rows
  bid_config_history partner_uuid_map partner_daily_counts environment_variables
  env_var_folders folders service_connections service_presets webhook_endpoints
  app_config app_settings audit_log sf_bid_matrix_audit workflow_stats_daily
)

# Refuse to restore onto the source host (never run the drill against prod).
src_host="$(printf '%s' "$SOURCE_DB_URL" | sed -E 's#.*@([^:/]+).*#\1#')"
tgt_host="$(printf '%s' "$TARGET_DB_URL" | sed -E 's#.*@([^:/]+).*#\1#')"
if [[ "$src_host" == "$tgt_host" ]]; then
  echo "REFUSING: TARGET host == SOURCE host ($tgt_host). The target must be a scratch project." >&2
  exit 2
fi

echo "Source: $src_host"
echo "Target: $tgt_host"
echo "Tables (data): ${#TABLES[@]}"
echo

start=$(date +%s)

echo "[1/4] Dumping schema (all tables, structure only)..."
pg_dump "$SOURCE_DB_URL" --schema-only --schema=public --no-owner --no-privileges \
  -f "$WORKDIR/schema.sql"

echo "[2/4] Dumping config data (explicit allow-list)..."
targs=(); for t in "${TABLES[@]}"; do targs+=( -t "public.$t" ); done
pg_dump "$SOURCE_DB_URL" --data-only --no-owner --no-privileges "${targs[@]}" \
  -f "$WORKDIR/data.sql"
# Guard: assert no excluded large/PII table leaked into the data dump.
if grep -qoE '^COPY "?public"?\."?(persons|execution_steps|workflow_executions|lead_sightings|lead_sighting_bids|achieve_evaluations)' "$WORKDIR/data.sql"; then
  echo "ABORT: an excluded large/PII table leaked into the data dump." >&2
  exit 3
fi

echo "[3/4] Restoring schema then data into target..."
psql "$TARGET_DB_URL" -q -v ON_ERROR_STOP=0 -f "$WORKDIR/schema.sql" >/dev/null 2>"$WORKDIR/schema_err.txt" || true
# session_replication_role=replica bypasses the circular FKs (folders <-> env_var_folders)
# and any triggers during the bulk load.
{ echo "SET session_replication_role=replica;"; cat "$WORKDIR/data.sql"; } \
  | psql "$TARGET_DB_URL" -q -v ON_ERROR_STOP=0 >/dev/null 2>"$WORKDIR/data_err.txt" || true
schema_errs=$(grep -ciE '^ERROR' "$WORKDIR/schema_err.txt" || true)
data_errs=$(grep -ciE '^ERROR' "$WORKDIR/data_err.txt" || true)

echo "[4/4] Verifying row counts (source vs target)..."
fail=0
printf '%-32s %12s %12s   %s\n' "TABLE" "SOURCE" "TARGET" "RESULT"
for t in "${TABLES[@]}"; do
  s=$(psql "$SOURCE_DB_URL" -tAc "select count(*) from public.\"$t\"" 2>/dev/null || echo ERR)
  d=$(psql "$TARGET_DB_URL" -tAc "select count(*) from public.\"$t\"" 2>/dev/null || echo ERR)
  if [[ "$s" == "$d" && "$s" != "ERR" ]]; then res="ok"; else res="MISMATCH"; fail=1; fi
  printf '%-32s %12s %12s   %s\n' "$t" "$s" "$d" "$res"
done

elapsed=$(( $(date +%s) - start ))
echo
echo "Schema restore errors: $schema_errs   Data restore errors: $data_errs"
echo "Elapsed (dump+restore+verify): ${elapsed}s"
if [[ "$fail" == 0 && "$schema_errs" == 0 ]]; then
  echo "RESULT: PASS — all ${#TABLES[@]} tables match."
  echo "Record this run in docs/disaster-recovery/restore-drill.md, then DELETE the scratch project."
else
  echo "RESULT: FAIL — investigate mismatches / errors above before trusting the backup path."
  exit 1
fi
