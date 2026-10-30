#!/usr/bin/env bash
# scripts/sql-suite/project.sh: which database the SQL suite builds (#1709), sourced
# by start-db.sh, replay.sh and run.sh. SQL_SUITE_PROJECT picks it:
#
#   main (default)  supabase/migrations and supabase/tests, the bidding database,
#                   with bootstrap.sql making the image look like that project.
#   ops             supabase-ops/supabase/migrations and supabase-ops/supabase/tests,
#                   the separate ops database of the Pipedream move, with
#                   bootstrap-ops.sql giving the image that project's default
#                   grants as measured 2026-10-06.
#
# Both then take the platform's default grants away at the cutover of 2026-10-30
# (default-grants-cutover.sql, which replay.sh applies, #3097), and both suites
# load the shared checks in scripts/sql-suite/checks.
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
    # Fixture folders a test reads with pg_read_file (#2132): copied into the
    # container at /sql-suite-fixtures/<the folder's package name>/.
    # The partner delete labels (#2140) are read by the Worker and by
    # partner_delete.test.sql, at /sql-suite-fixtures/partner-delete/.
    # The money gate's live workflow definitions (#2338, build PR 7), at
    # /sql-suite-fixtures/money-gate/definitions/, which
    # workflow_connection_check.test.sql saves through the workflows trigger to
    # prove a money workflow's definition is stored exactly as sent.
    # The suites' shared SQL helpers (#2187), at /sql-suite-fixtures/tests/,
    # which a suite loads with \i: save_profile.sql saves a profile through
    # save_partner_page for the suites that used save_buyer_profile.
    # The migrations themselves (#2638), at /sql-suite-fixtures/supabase/, so a
    # test can run a migration again against a state it must refuse, as the ops
    # suite does.
    # The checks both projects share (#3097), at /sql-suite-fixtures/sql-suite/.
    SUITE_FIXTURES=("$ROOT/packages/buyer-profile/fixtures" "$ROOT/apps/worker/src/partner-delete/labels" "$ROOT/apps/worker/money-gate/fixtures" "$ROOT/supabase/tests/helpers" "$ROOT/supabase/migrations" "$ROOT/scripts/sql-suite/checks")
    ;;
  ops)
    SUITE_MIGRATIONS="$ROOT/supabase-ops/supabase/migrations"
    SUITE_TESTS="$ROOT/supabase-ops/supabase/tests"
    SUITE_BOOTSTRAP="$HERE/bootstrap-ops.sql"
    SUITE_CONTAINER_DEFAULT="bidspoke-sql-suite-ops"
    SUITE_PORT_DEFAULT="54330"
    # The ops migrations themselves (#2336), at /sql-suite-fixtures/supabase/,
    # so a test can run a migration again against a state it must refuse.
    # The checks both projects share (#3097), at /sql-suite-fixtures/sql-suite/.
    SUITE_FIXTURES=("$ROOT/supabase-ops/supabase/migrations" "$ROOT/scripts/sql-suite/checks")
    ;;
  *)
    echo "SQL SUITE DID NOT RUN: SQL_SUITE_PROJECT is '$SQL_SUITE_PROJECT'; it must be main or ops" >&2
    exit 2
    ;;
esac
CONTAINER="${SQL_SUITE_CONTAINER:-$SUITE_CONTAINER_DEFAULT}"
PORT="${SQL_SUITE_PORT:-$SUITE_PORT_DEFAULT}"
