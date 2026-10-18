#!/usr/bin/env bash
# scripts/pre-push-sql-suites.sh: which SQL suites this push must run (#2412).
#
# Prints one line per suite to run, `main` and/or `ops`, and nothing when no
# suite is needed. `.husky/pre-push` reads it; the tests in
# apps/web/src/lib/__tests__/pre-push-sql-suites.test.ts drive it against
# throwaway repositories.
#
# The decision is made from the branch's OWN changes: the files changed between
# its merge base with origin/main and HEAD. Not from `@{upstream}`, which used
# to make a branch that changed no database file run the suites in the shared
# Docker containers: a first push has no upstream, and with the upstream set to
# origin/main a two dot diff counts every file main changed since the branch was
# cut as the branch's own.
#
# When the merge base cannot be computed (no origin/main, unrelated history),
# both suites run: the branch's changes could not be measured, so the loud side
# wins over passing on nothing (L98). The reason goes to stderr.
#
# This file lives outside scripts/sql-suite/ deliberately: that directory is in
# both suites' trigger patterns, and a change to the decision alone changes
# nothing either suite replays.
set -u

BASE_REF="origin/main"

# Bring origin/main up to date so the merge base is the branch's real cut point.
# Quiet, and allowed to fail: offline, an older origin/main only makes the diff
# larger (it then includes main commits after it), which errs towards running.
#
# Bounded, because this runs on every push: a hung network or a credential
# prompt must not stall the push with nothing saying which step is waiting.
# GIT_TERMINAL_PROMPT=0 refuses a prompt outright, and a watchdog kills the
# fetch after PRE_PUSH_FETCH_TIMEOUT seconds (default 20). The watchdog writes
# to /dev/null: this script's stdout is captured by the hook, and a watchdog
# still holding it would keep that capture open until its sleep ended.
FETCH_TIMEOUT="${PRE_PUSH_FETCH_TIMEOUT:-20}"
GIT_TERMINAL_PROMPT=0 git fetch --quiet origin main >/dev/null 2>&1 </dev/null &
fetch_pid=$!
(
  sleep "$FETCH_TIMEOUT"
  kill "$fetch_pid" 2>/dev/null
) >/dev/null 2>&1 </dev/null &
watchdog_pid=$!
if ! wait "$fetch_pid"; then
  if ! kill -0 "$watchdog_pid" 2>/dev/null; then
    echo "pre-push: fetching origin/main did not finish in ${FETCH_TIMEOUT}s, deciding the SQL suites from the local origin/main" >&2
  else
    echo "pre-push: could not fetch origin/main, deciding the SQL suites from the local origin/main" >&2
  fi
fi
kill "$watchdog_pid" 2>/dev/null
wait "$watchdog_pid" 2>/dev/null

both() {
  echo "pre-push: $1, so running both SQL suites" >&2
  echo main
  echo ops
  exit 0
}

base=$(git merge-base "$BASE_REF" HEAD 2>/dev/null) || both "could not compute the merge base of HEAD and $BASE_REF"
[ -n "$base" ] || both "could not compute the merge base of HEAD and $BASE_REF"

changed=$(git diff --name-only "$base" HEAD 2>/dev/null) || both "could not list the files changed since the merge base $base"

if printf '%s\n' "$changed" | grep -qE '^(supabase/|apps/worker/src/lib/read-only-rpcs\.json|scripts/sql-suite/)'; then
  echo main
fi
# The ops database (#1709) has its own migrations, tests and container.
if printf '%s\n' "$changed" | grep -qE '^(supabase-ops/|scripts/sql-suite/)'; then
  echo ops
fi
exit 0
