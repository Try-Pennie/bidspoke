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
git fetch --quiet origin main >/dev/null 2>&1 || true

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
