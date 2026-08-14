#!/usr/bin/env bash
#
# Decide whether the production worker actually needs redeploying (#727).
#
# deploy.yml's paths filter lists pnpm-lock.yaml and package.json under the
# worker filter, so a web-only dependency bump redeploys the live bidding engine
# with no worker source change (confirmed on 2026-07-30 merging #706, a test-only
# devDependency). Narrowing the filter would only be a heuristic, since pnpm can
# genuinely re-resolve a shared transitive dependency and move the worker bundle.
# So the caller builds the worker at the live worker's reported commit and at
# HEAD, and this decides from the two artifact hashes (LESSONS L40: compare the
# content, never a cheap stand-in for it).
#
# Usage:
#   worker-artifact-decision.sh <live_sha> <live_sha_in_history> <head_hash> <live_hash>
#
# Prints exactly one word to stdout: `deploy` or `skip`. The reason goes to
# stderr. Always exits 0: a problem inside the gate must never fail the pipeline,
# it must fall through to deploying.
#
# THE FAIL-SAFE DIRECTION IS `deploy`, which is the opposite of most gates.
# Every uncertainty deploys. Skipping on an unreadable signal is the dangerous
# half, because it strands the engine behind a green pipeline, which is exactly
# the defect #327 and the Deploy Drift check exist to catch. A needless redeploy
# is merely wasteful. In particular two FAILED builds both yield an empty hash,
# and a naive equality test would read that as "identical" and skip.

set -uo pipefail

LIVE_SHA="${1-}"
LIVE_SHA_IN_HISTORY="${2-}"
HEAD_HASH="${3-}"
LIVE_HASH="${4-}"

decide() {
  # $1 = decision, $2 = reason
  printf '%s\n' "$1"
  printf 'worker-artifact-gate: %s (%s)\n' "$1" "$2" >&2
  exit 0
}

if [ "$#" -lt 4 ]; then
  decide deploy "called with $# of 4 arguments, so the comparison never happened"
fi

if [ -z "$LIVE_SHA" ] || [ "$LIVE_SHA" = "unknown" ] || [ "$LIVE_SHA" = "null" ]; then
  decide deploy "live worker reports no deployed commit (got '${LIVE_SHA}'), so there is nothing to compare against"
fi

if [ "$LIVE_SHA_IN_HISTORY" != "true" ]; then
  decide deploy "live commit ${LIVE_SHA} is not in this repository history, so it cannot be built for comparison"
fi

# Checked before the equality test on purpose: a missing hash means a build did
# not produce an artifact, and two missing hashes must not read as a match.
if [ -z "$HEAD_HASH" ]; then
  decide deploy "the HEAD build produced no artifact hash"
fi

if [ -z "$LIVE_HASH" ]; then
  decide deploy "the build at live commit ${LIVE_SHA} produced no artifact hash"
fi

if [ "$HEAD_HASH" != "$LIVE_HASH" ]; then
  decide deploy "artifact changed (live ${LIVE_HASH:0:12} to head ${HEAD_HASH:0:12})"
fi

decide skip "artifact is byte identical to what is already live (${HEAD_HASH:0:12}), so the engine does not need redeploying"
