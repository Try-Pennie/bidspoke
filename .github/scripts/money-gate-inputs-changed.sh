#!/usr/bin/env bash
#
# Decide whether a pull request touches anything the money gate reads (#1704).
#
# The gate replays synthetic leads through the bidding engine at the merge base
# and at the head. Its inputs are the Worker source, the workspace packages the
# Worker imports, the Worker's wrangler.toml and manifest, the lockfile, the gate's
# own harness, fixtures and configs, and the CI wiring that runs it. A pull request
# touching none of them cannot change what the gate would report, so the gate
# skips; apps/worker/money-gate/lib/__tests__/inputs-changed.test.ts derives the
# input set from disk and holds this pattern to it (L88).
#
# Usage:
#   money-gate-inputs-changed.sh <pr_number> <lookup_ok> <changed_files>
#
# Prints exactly one word to stdout: `true` (run the gate) or `false` (skip it).
# Reason to stderr. Always exits 0.
#
# THE FAIL-SAFE DIRECTION IS `true`, for the reason web-code-changed.sh gives: a
# gate that quietly switches itself off reports green while checking nothing
# (L42, L72). The ONLY path to `false` is a lookup that clearly succeeded,
# returned a non-empty list, and matched nothing below (L119).

set -uo pipefail

PR="${1-}"
LOOKUP_OK="${2-}"
FILES="${3-}"

decide() {
  printf '%s\n' "$1"
  printf 'money-gate-inputs-changed: %s (%s)\n' "$1" "$2" >&2
  exit 0
}

if [ "$#" -lt 3 ]; then
  decide true "called with $# of 3 arguments, so nothing was actually checked"
fi
if [ -z "$PR" ]; then
  decide true "not a pull request, so there is no changed-file list to narrow by"
fi
if [ "$LOOKUP_OK" != "true" ]; then
  decide true "the changed-files lookup did not clearly succeed (got '${LOOKUP_OK}')"
fi
if [ -z "$FILES" ]; then
  decide true "the changed-files lookup returned an empty list, so the query did not do what it claimed"
fi

# Anchored at the start of the path and terminated by `/` or end of string, so a
# whole path SEGMENT matches: apps/worker-tail and docs/apps/worker do not.
# packages/ is whole because the Worker imports workspace packages and a new one
# it starts to import must not need this line edited first.
PATTERN='^(apps/worker/(src|money-gate)/|apps/worker/(wrangler\.toml|package\.json|tsconfig[^/]*\.json|vitest\.money-gate[^/]*\.mts|scripts/export-money-fixture-shapes\.ts)$|packages/|pnpm-lock\.yaml$|package\.json$|pnpm-workspace\.yaml$|\.github/scripts/money-gate[^/]*\.sh$|\.github/workflows/(ci|deploy)\.yml$)'

matched=$(printf '%s\n' "$FILES" | grep -E "$PATTERN" | head -n 5)

if [ -n "$matched" ]; then
  decide true "$(printf '%s' "$matched" | tr '\n' ' ')"
fi

decide false "no changed file is an input of the money gate"
