#!/usr/bin/env bash
#
# dr-restore-drill.sh — Bidspoke disaster-recovery restore drill.
#
# Proves that Bidspoke's Postgres can be rebuilt from a backup into a fresh
# (scratch) Supabase project, and measures how long it takes (the proven RTO).
# Run this on the cadence in docs/dr-restore-drill.md (quarterly).
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
#   SOURCE is production (read-only use here); TARGET is the scratch project you
#   created for the drill. See docs/dr-restore-drill.md for how to get each
#   without handling the production password (a temporary CLI login, which needs
#   `?options=-c%20role%3Dpostgres` on the end of its URL to read the tables).
#
set -euo pipefail

: "${SOURCE_DB_URL:?Set SOURCE_DB_URL to the production connection string (read-only)}"
: "${TARGET_DB_URL:?Set TARGET_DB_URL to the scratch project connection string}"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT   # dump files contain config data + encrypted secrets; clean up

# Which tables have their DATA copied, and which are restored as structure only,
# lives in scripts/dr-drill-tables.sh so CI can check it against the migrations
# (apps/web/src/lib/__tests__/dr-drill-table-coverage.test.ts).
# shellcheck source=scripts/dr-drill-tables.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dr-drill-tables.sh"
TABLES=("${DRILL_COPY_TABLES[@]}")

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

# Refuse on a live table in neither list. The row count check below compares only
# the copied tables, so an unlisted system-of-record table would otherwise be
# restored empty while the drill printed PASS.
live_tables="$(psql "$SOURCE_DB_URL" -tA -v ON_ERROR_STOP=1 -c \
  "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','p') and not c.relispartition
   order by 1")"
if [[ -z "$live_tables" ]]; then
  echo "REFUSING: could not list the source database's tables." >&2
  exit 4
fi
if ! unlisted="$(printf '%s\n' "$live_tables" | dr_unclassified_tables)"; then
  echo "REFUSING: these source tables are in neither list in scripts/dr-drill-tables.sh:" >&2
  printf '  %s\n' $unlisted >&2
  echo "Add each to DRILL_COPY_TABLES or DRILL_STRUCTURE_ONLY_TABLES, then re-run." >&2
  exit 5
fi

start=$(date +%s)

echo "[1/4] Dumping schema (all tables, structure only)..."
pg_dump "$SOURCE_DB_URL" --schema-only --schema=public --no-owner --no-privileges \
  -f "$WORKDIR/schema.sql"

echo "[2/4] Dumping config data (explicit allow-list)..."
targs=(); for t in "${TABLES[@]}"; do targs+=( -t "public.$t" ); done
pg_dump "$SOURCE_DB_URL" --data-only --no-owner --no-privileges "${targs[@]}" \
  -f "$WORKDIR/data.sql"
# Guard: assert no structure-only table (raw personal data, bulk logs) leaked
# into the data dump.
leak_pattern="$(IFS='|'; echo "${DRILL_STRUCTURE_ONLY_TABLES[*]}")"
if grep -qoE "^COPY \"?public\"?\.\"?(${leak_pattern})(_[0-9]{4}_[0-9]{2})?\"? " "$WORKDIR/data.sql"; then
  echo "ABORT: a structure-only table leaked into the data dump." >&2
  exit 3
fi

# Count the source rows NOW, straight after the data dump, and never again. Two
# reasons. The counts then describe the snapshot that was dumped, so live writes
# during the restore (audit_log, buyer_sales) no longer read as a mismatch. And the
# source login is used only in the first minute or so: the temporary login that
# `supabase db dump --dry-run` issues is valid for five minutes (measured
# 2026-09-28), the restore takes about four, and re-reading the source after it
# made 32 failed logins in a row, which got this machine's address banned from
# the database. So a failed source read stops the drill at once.
source_counts=()
for t in "${TABLES[@]}"; do
  if ! c=$(psql "$SOURCE_DB_URL" -tAc "select count(*) from public.\"$t\"" 2>"$WORKDIR/count_err.txt"); then
    echo "ABORT: could not count source table $t:" >&2
    sed -E 's#://[^@]*@#://***@#' "$WORKDIR/count_err.txt" >&2
    exit 6
  fi
  source_counts+=("$c")
done

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
for i in "${!TABLES[@]}"; do
  t="${TABLES[$i]}"
  s="${source_counts[$i]}"
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
  echo "Record this run in docs/dr-restore-drill.md, then DELETE the scratch project."
else
  echo "RESULT: FAIL — investigate mismatches / errors above before trusting the backup path."
  exit 1
fi
