#!/usr/bin/env bash
#
# Turn two worker build hashes into the verdict the Deploy Drift check acts on (#802).
#
# The drift check used to accuse from git history over the apps/worker PATH,
# while the deploy decides what shipped from the built BUNDLE. A commit touching
# only worker TEST files satisfied the first and not the second, so it read as a
# stranded worker that no deploy could ever clear. The check now builds the
# bundle at the live commit and at HEAD and confirms before paging, and this is
# the step that says what those two builds mean.
#
# Usage:
#   drift-artifact-verdict.sh <live_sha> <head_hash> <live_hash>
#
# Prints exactly one word: `identical`, `differs`, or `unknown`. The reason goes
# to stderr. Always exits 0; the caller acts on the word.
#
# THREE answers, deliberately, not two. `identical` and `differs` are both real
# measurements. `unknown` says the measurement did not happen, and it must never
# collapse into either of the others: a failed build produces no hash, and TWO
# failed builds produce two empty hashes that a plain equality test would read as
# a match and certify a stranded worker as healthy (LESSONS L98).
#
# `identical` is reachable only through worker-artifact-decision.sh, which is the
# same predicate the deploy uses to decide whether to ship at all. Asking it,
# rather than comparing the hashes here, is what stops the two from drifting into
# different ideas of "the worker changed" (L16), which is the whole defect this
# script exists to close.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LIVE_SHA="${1-}"
HEAD_HASH="${2-}"
LIVE_HASH="${3-}"

answer() {
  printf '%s\n' "$1"
  printf 'drift-artifact-verdict: %s (%s)\n' "$1" "$2" >&2
  exit 0
}

if [ "$#" -lt 3 ]; then
  answer unknown "called with $# of 3 arguments, so no comparison happened"
fi

# Checked before the shared predicate is consulted. It answers `deploy` on a
# missing hash, which is the right answer for the DEPLOY (when in doubt, ship)
# and the wrong one here, where "deploy" would be read as evidence the worker is
# behind. The two callers want opposite things from the same uncertainty, so the
# uncertainty is resolved here first.
if [ -z "$HEAD_HASH" ]; then
  answer unknown "the build at HEAD produced no artifact hash"
fi

if [ -z "$LIVE_HASH" ]; then
  answer unknown "the build at live commit '${LIVE_SHA}' produced no artifact hash"
fi

if [ -z "$LIVE_SHA" ] || [ "$LIVE_SHA" = "unknown" ] || [ "$LIVE_SHA" = "null" ]; then
  answer unknown "no live commit was reported, so there was nothing to build a comparison against"
fi

# `true` for in-history: the caller only reaches this script after checking the
# live commit out, which cannot have succeeded otherwise.
DECISION=$(bash "$HERE/worker-artifact-decision.sh" "$LIVE_SHA" true "$HEAD_HASH" "$LIVE_HASH")

if [ "$DECISION" = "skip" ]; then
  answer identical "the deploy's own predicate reports the bundle is byte identical to what is live, so nothing is unshipped"
fi

answer differs "the deploy's own predicate reports the bundle has moved (live ${LIVE_HASH:0:12} to head ${HEAD_HASH:0:12})"
