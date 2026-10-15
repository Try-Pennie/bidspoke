#!/usr/bin/env bash
# scripts/sql-suite/replay.sh: apply every migration in supabase/migrations, in
# filename order, to the throwaway Postgres, and name the first one that errors.
#
# This is the replay #1139 asked for. Until it existed nothing in this repo had
# run the migrations against a real database from empty: every SQL guard read
# migration TEXT, and applying the set to an empty database had silently stopped
# at migration 22 of 119 for four months. The buyer profile SQL suite (#1409)
# runs on the database this produces, so the suite is only as real as this.
#
# One file per psql invocation, never the set concatenated: six migrations carry
# COMMIT or CREATE INDEX CONCURRENTLY and cannot share a transaction. psql runs a
# file's statements one at a time and stops at the first error (ON_ERROR_STOP).
# Applied files are recorded in sql_suite.replayed, so a rerun continues from
# the first unapplied one; `start-db.sh --reset` starts from nothing again.
#
# Usage: bash scripts/sql-suite/replay.sh
# Env: SQL_SUITE_PROJECT (main or ops, see project.sh), SQL_SUITE_CONTAINER.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=project.sh
. "$HERE/project.sh"
MIGRATIONS_LABEL="${SUITE_MIGRATIONS#"$ROOT"/}"

# The image's `postgres` database on purpose: pg_cron is preloaded with
# cron.database_name = postgres, and the auth schema and roles live there.
psql_as() {
  local role="$1"; shift
  docker exec -i "$CONTAINER" psql -U "$role" -h 127.0.0.1 -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

if ! docker exec "$CONTAINER" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then
  echo "SQL SUITE DID NOT RUN: no Postgres answering in container '$CONTAINER'." >&2
  echo "Start one with: bash scripts/sql-suite/start-db.sh" >&2
  exit 2
fi

# The bootstrap runs on an empty container, and again whenever the file has
# changed since this container last ran it (#2131). Without the second half, a
# container built before a bootstrap change kept the old shape for ever, and the
# first migration needing the new part (the realtime stub) failed to replay on
# every machine that already had a container, while a fresh one passed. Every
# statement in both bootstrap files is idempotent, so a rerun over a database the
# migrations have already reached changes only what the file newly adds.
bootstrap_sha="$(shasum -a 256 "$SUITE_BOOTSTRAP" | awk '{print $1}')"
# The read and the record both fail the replay by name: a read swallowed into
# an empty answer, or a record that silently did not land, would rerun the
# bootstrap on every replay with nothing ever saying why.
# Two statements, because a CASE cannot guard a relation that does not exist:
# the reference fails when the query is parsed, before any branch is chosen.
if ! recorded="$(psql_as postgres -Atc "SELECT to_regclass('sql_suite.bootstrap_applied') IS NOT NULL" 2>&1)"; then
  echo "REPLAY FAILED: could not read which bootstrap this container last ran: $recorded" >&2
  exit 1
fi
applied_sha=""
if [ "$recorded" = "t" ]; then
  if ! applied_sha="$(psql_as postgres -Atc "SELECT coalesce(max(sha), '') FROM sql_suite.bootstrap_applied" 2>&1)"; then
    echo "REPLAY FAILED: could not read which bootstrap this container last ran: $applied_sha" >&2
    exit 1
  fi
fi
if [ "$applied_sha" != "$bootstrap_sha" ]; then
  if ! out="$(psql_as supabase_admin -f - < "$SUITE_BOOTSTRAP" 2>&1)"; then
    echo "REPLAY FAILED in ${SUITE_BOOTSTRAP#"$ROOT"/}:" >&2
    printf '%s\n' "$out" | grep -v '^$' | tail -8 >&2
    exit 1
  fi
  if ! out="$(psql_as postgres -Atc "SET client_min_messages = warning; CREATE TABLE IF NOT EXISTS sql_suite.bootstrap_applied (sha text NOT NULL); DELETE FROM sql_suite.bootstrap_applied; INSERT INTO sql_suite.bootstrap_applied (sha) VALUES ('$bootstrap_sha')" 2>&1)"; then
    echo "REPLAY FAILED: the bootstrap ran but recording it did not: $out" >&2
    exit 1
  fi
  echo "bootstrap applied: ${SUITE_BOOTSTRAP#"$ROOT"/} (${bootstrap_sha:0:12})"
fi

files=()
while IFS= read -r f; do files+=("$f"); done < <(ls "$SUITE_MIGRATIONS"/*.sql 2>/dev/null | sort)
total="${#files[@]}"
if [ "$total" -eq 0 ]; then
  echo "REPLAY DID NOT RUN: no migrations found under $MIGRATIONS_LABEL" >&2
  exit 2
fi

n=0
skipped=0
for f in "${files[@]}"; do
  n=$((n + 1))
  name="$(basename "$f")"
  done_already="$(psql_as postgres -Atc "SELECT 1 FROM sql_suite.replayed WHERE version = '$name'")"
  if [ "$done_already" = "1" ]; then skipped=$((skipped + 1)); continue; fi
  if ! out="$(psql_as postgres -f - < "$f" 2>&1)"; then
    echo "REPLAY FAILED at $n of $total: $MIGRATIONS_LABEL/$name" >&2
    printf '%s\n' "$out" | grep -v '^$' | tail -8 >&2
    exit 1
  fi
  psql_as postgres -Atc "INSERT INTO sql_suite.replayed(version) VALUES ('$name')" >/dev/null
done
echo "REPLAY OK ($SQL_SUITE_PROJECT): $total migrations present, $((total - skipped)) applied now, $skipped already applied, in container $CONTAINER"
