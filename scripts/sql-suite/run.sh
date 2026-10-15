#!/usr/bin/env bash
# scripts/sql-suite/run.sh: the SQL suite. Starts the throwaway Postgres if it is
# not running, replays every migration onto it (incrementally), then runs each
# project's tests (supabase/tests/*.test.sql for main) with psql, one statement at a time, and stops at the
# first that errors (#1409).
#
# It never exits 0 on finding nothing to run (L98): no Docker, no migrations, or
# no test files each refuse by name. The pre push hook calls this when a change
# under supabase/ or the read only rpc list is being pushed; SKIP_SQL_SUITE=1
# skips it for one push, explained to the user first like every other gate.
#
# Nothing here can reach production: the only connection is to the local
# container, and the tests carry no real identity (L222).
#
# Usage: bash scripts/sql-suite/run.sh [--reset]
#        SQL_SUITE_PROJECT=ops bash scripts/sql-suite/run.sh   (the ops database, #1709)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=project.sh
. "$HERE/project.sh"
TESTS_LABEL="${SUITE_TESTS#"$ROOT"/}"

if ! command -v docker >/dev/null 2>&1; then
  echo "SQL SUITE DID NOT RUN: docker is not installed. Install Docker Desktop, or push with SKIP_SQL_SUITE=1 after saying why." >&2
  exit 2
fi

if ! bash "$HERE/start-db.sh" ${1:-}; then exit 2; fi
if ! bash "$HERE/replay.sh"; then
  echo "SQL SUITE FAILED: the migrations do not replay from empty (see above)." >&2
  exit 1
fi

tests=()
while IFS= read -r f; do tests+=("$f"); done < <(ls "$SUITE_TESTS"/*.test.sql 2>/dev/null | sort)
if [ "${#tests[@]}" -eq 0 ]; then
  echo "SQL SUITE DID NOT RUN: no *.test.sql files under $TESTS_LABEL" >&2
  exit 2
fi

# The container's own address on the Docker network, handed to every test as the
# psql variable self_host. A test that needs a second, concurrent session (#2100:
# two racing opens of one incident) connects back to it through dblink, which a
# non superuser may do only over a connection that really used a password, and
# the loopback is trust, so it must come in through this address instead.
SELF_HOST="$(docker exec "$CONTAINER" hostname -i 2>/dev/null | awk '{print $1}')"
# Only a test that needs it is affected when it cannot be read: the variable is
# left undefined, and such a test refuses by name rather than every test failing.
SELF_HOST_ARG=()
if [ -n "$SELF_HOST" ]; then
  SELF_HOST_ARG=(-v "self_host=$SELF_HOST")
else
  echo "WARN  could not read the address of container $CONTAINER; a test needing a second session will refuse" >&2
fi

# Shared fixtures (#2132, A6). Each test reaches psql over stdin, so it cannot
# open a repository file: the fixture folders are copied into the container,
# the test role may read files there (in this throwaway container only), and
# every fixture a test names must be present, or the suite refuses by name.
docker exec "$CONTAINER" rm -rf /sql-suite-fixtures
docker exec "$CONTAINER" mkdir -p /sql-suite-fixtures
for d in ${SUITE_FIXTURES[@]+"${SUITE_FIXTURES[@]}"}; do
  if ! docker cp "$d/." "$CONTAINER:/sql-suite-fixtures/$(basename "$(dirname "$d")")/" >/dev/null; then
    echo "SQL SUITE DID NOT RUN: could not copy the fixtures in $d" >&2
    exit 2
  fi
done
docker exec "$CONTAINER" chmod -R a+rX /sql-suite-fixtures
docker exec "$CONTAINER" psql -U supabase_admin -h 127.0.0.1 -d postgres -q -v ON_ERROR_STOP=1 \
  -c 'SET client_min_messages = warning' -c 'GRANT pg_read_server_files TO postgres' -c 'GRANT EXECUTE ON FUNCTION pg_read_file(text) TO postgres' >/dev/null
missing=0
for t in "${tests[@]}"; do
  for f in $(grep -o "/sql-suite-fixtures/[A-Za-z0-9._/-]*" "$t" | sort -u); do
    if ! docker exec "$CONTAINER" test -f "$f"; then
      echo "MISSING FIXTURE  $(basename "$t") reads $f, which is not in the container" >&2
      missing=1
    fi
  done
done
if [ "$missing" -ne 0 ]; then
  echo "SQL SUITE FAILED ($SQL_SUITE_PROJECT): a test names a fixture the harness did not copy" >&2
  exit 1
fi

status=0
for t in "${tests[@]}"; do
  name="$(basename "$t")"
  # verified_deletion_gate.test.sql documents its own two part protocol (part 2
  # needs partitions and a scheduler) and is still run by hand; the suite runs
  # the files written for it.
  if [ "$name" = "verified_deletion_gate.test.sql" ]; then
    echo "SKIP  $name (hand run, see its header)"
    continue
  fi
  if out="$(docker exec -i "$CONTAINER" psql -U postgres -h 127.0.0.1 -d postgres -v ON_ERROR_STOP=1 ${SELF_HOST_ARG[@]+"${SELF_HOST_ARG[@]}"} -q -f - < "$t" 2>&1)"; then
    summary="$(printf '%s\n' "$out" | grep -E 'cases passed' | tail -1 | sed -E 's/^psql:<stdin>:[0-9]+: NOTICE:  //; s/^NOTICE:  //')"
    echo "PASS  $name${summary:+: $summary}"
  else
    echo "FAIL  $name" >&2
    printf '%s\n' "$out" | grep -v '^$' | tail -12 >&2
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo "SQL SUITE FAILED ($SQL_SUITE_PROJECT)" >&2
  exit 1
fi
echo "SQL SUITE OK ($SQL_SUITE_PROJECT)"
