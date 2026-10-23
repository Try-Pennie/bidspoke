#!/usr/bin/env bash
# Decides the `CI passed` check: did every leg of ci.yml succeed?
#
# Usage: ci-passed-decision.sh '<toJSON(needs)>'
# Exits 0 only when every leg's result is "success". Exits 1 on any other
# result (failure, cancelled, skipped), and also when it read no legs or could
# not read the input at all, because a summary that checked nothing must not
# read as green: this is the one check the main ruleset requires (#2749).
#
# Skipped counts as a failure on purpose. Every leg runs on a pull request, so
# a skipped one means its own `needs` failed upstream, and GitHub would count a
# skipped required check as passing.
set -uo pipefail

NEEDS="${1:-}"

if ! results="$(jq -r 'to_entries[] | "\(.key)=\(.value.result)"' <<<"$NEEDS" 2>/dev/null)"; then
  echo "::error::CI passed could not read its legs' results, so it has verified nothing. Failing rather than passing green."
  exit 1
fi
if [ -z "$results" ]; then
  echo "::error::CI passed read no leg results at all, so it has verified nothing. Failing rather than passing green."
  exit 1
fi

echo "leg results: $(tr '\n' ' ' <<<"$results")"
failed="$(grep -v '=success$' <<<"$results" | tr '\n' ' ' || true)"
if [ -n "$failed" ]; then
  echo "::error::Not every CI leg succeeded: ${failed% }"
  exit 1
fi
echo "Every CI leg succeeded."
