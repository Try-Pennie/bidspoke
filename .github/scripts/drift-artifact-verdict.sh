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
# TWO DIMENSIONS (#1420). wrangler.toml's [vars], crons, limits and bindings are
# applied BY the deploy and appear nowhere in the bundle, so a change to any of
# them leaves both builds hashing the same. On 2026-09-21 #1404 changed a var,
# the deploy gate skipped, and this check then reported success 47 minutes later:
# the backstop was blind to exactly what the gate was blind to, which is what
# made the failure silent on both sides. The config hash is the second dimension.
#
# Usage:
#   drift-artifact-verdict.sh <live_sha> <head_hash> <live_hash> \
#                             <head_config_hash> <live_config_hash>
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
HEAD_CONFIG_HASH="${4-}"
LIVE_CONFIG_HASH="${5-}"

answer() {
  printf '%s\n' "$1"
  printf 'drift-artifact-verdict: %s (%s)\n' "$1" "$2" >&2
  exit 0
}

if [ "$#" -lt 5 ]; then
  answer unknown "called with $# of 5 arguments, so no comparison happened"
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

if [ -z "$HEAD_CONFIG_HASH" ]; then
  answer unknown "the deploy-time config at HEAD produced no hash"
fi

if [ -z "$LIVE_CONFIG_HASH" ]; then
  answer unknown "the deploy-time config at live commit '${LIVE_SHA}' produced no hash"
fi

if [ -z "$LIVE_SHA" ] || [ "$LIVE_SHA" = "unknown" ] || [ "$LIVE_SHA" = "null" ]; then
  answer unknown "no live commit was reported, so there was nothing to build a comparison against"
fi

# `true` for in-history: the caller only reaches this script after checking the
# live commit out, which cannot have succeeded otherwise.
DECISION=$(bash "$HERE/worker-artifact-decision.sh" "$LIVE_SHA" true \
  "$HEAD_HASH" "$LIVE_HASH" "$HEAD_CONFIG_HASH" "$LIVE_CONFIG_HASH")

if [ "$DECISION" = "skip" ]; then
  answer identical "the deploy's own predicate reports the bundle and the deploy-time config are both identical to what is live, so nothing is unshipped"
fi

if [ "$HEAD_HASH" != "$LIVE_HASH" ]; then
  answer differs "the deploy's own predicate reports the bundle has moved (live ${LIVE_HASH:0:12} to head ${HEAD_HASH:0:12})"
fi

answer differs "the deploy's own predicate reports the deploy-time config has moved (live ${LIVE_CONFIG_HASH:0:12} to head ${HEAD_CONFIG_HASH:0:12}), so vars, crons, limits or bindings are unapplied"
