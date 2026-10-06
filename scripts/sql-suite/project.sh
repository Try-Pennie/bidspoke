#!/usr/bin/env bash
# scripts/sql-suite/project.sh: which database the SQL suite builds (#1709), sourced
# by start-db.sh, replay.sh and run.sh. SQL_SUITE_PROJECT picks it:
#
#   main (default)  supabase/migrations and supabase/tests, the bidding database,
#                   with bootstrap.sql making the image look like that project.
#   ops             supabase-ops/supabase/migrations and supabase-ops/supabase/tests,
#                   the separate ops database of the Pipedream move. Its bootstrap
#                   only creates the suite's bookkeeping: the image's default grants
#                   already match the new ops project's (measured 2026-10-06,
#                   TRUNCATE included, unlike the main project's).
#
# Each project has its own container and port, so the two never share a database.
# An unknown name refuses rather than falling back to main (L320).
SQL_SUITE_PROJECT="${SQL_SUITE_PROJECT:-main}"
case "$SQL_SUITE_PROJECT" in
  main)
    SUITE_MIGRATIONS="$ROOT/supabase/migrations"
    SUITE_TESTS="$ROOT/supabase/tests"
    SUITE_BOOTSTRAP="$HERE/bootstrap.sql"
    SUITE_CONTAINER_DEFAULT="bidspoke-sql-suite"
    SUITE_PORT_DEFAULT="54329"
    ;;
  ops)
    SUITE_MIGRATIONS="$ROOT/supabase-ops/supabase/migrations"
    SUITE_TESTS="$ROOT/supabase-ops/supabase/tests"
    SUITE_BOOTSTRAP="$HERE/bootstrap-ops.sql"
    SUITE_CONTAINER_DEFAULT="bidspoke-sql-suite-ops"
    SUITE_PORT_DEFAULT="54330"
    ;;
  *)
    echo "SQL SUITE DID NOT RUN: SQL_SUITE_PROJECT is '$SQL_SUITE_PROJECT'; it must be main or ops" >&2
    exit 2
    ;;
esac
CONTAINER="${SQL_SUITE_CONTAINER:-$SUITE_CONTAINER_DEFAULT}"
PORT="${SQL_SUITE_PORT:-$SUITE_PORT_DEFAULT}"
