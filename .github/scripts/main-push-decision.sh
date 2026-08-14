#!/usr/bin/env bash
#
# Decide whether a commit on main arrived without a reviewed pull request (#760).
#
# Server-side branch protection is unavailable on this repo (both
# `.../rulesets` and `.../branches/main/protection` return 403 "Upgrade to GitHub
# Pro or make this repository public"), so #266 stays open on that billing
# decision. Merges to main deploy the production bidding engine, and the husky
# hooks that partially cover the gap are bypassable with `--no-verify` /
# `SKIP_TEST_CHECK`. This reports a direct push after the fact instead.
#
# Usage:
#   main-push-decision.sh <sha> <assoc_pr_count> <prs_recording_this_merge> <lookups_ok>
#
# Prints exactly one word to stdout: `ok` or `violation`. Reason to stderr.
# Always exits 0; the caller decides what a violation does to the build.
#
# THE FAIL-SAFE DIRECTION IS `ok`, and it is deliberately the OPPOSITE of the
# artifact deploy gate in this same repo. That gate withholds an ACTION, so
# uncertainty must let the action through. This one makes an ACCUSATION, so
# uncertainty must stay quiet. An alert that cries wolf trains everyone to ignore
# it (LESSONS L36), which costs more than the misses it prevents.
#
# LESSONS L119 is the specific trap and the reason two independent sources are
# required. GitHub's commit-to-PR association index can return empty for a
# genuinely reviewed, merged PR, and can stay permanently incomplete rather than
# catch up. It did exactly that on another repo during an API incident and paged
# "direct push to main, review bypassed" about a squash merge of a green,
# reviewed PR. A missing index entry and a real violation are indistinguishable,
# so the empty answer is confirmed against the PR record before anything is said.

set -uo pipefail

SHA="${1-}"
ASSOC_COUNT="${2-}"
MERGE_SHA_PRS="${3-}"
LOOKUPS_OK="${4-}"

decide() {
  printf '%s\n' "$1"
  printf 'main-push-guard: %s (%s)\n' "$1" "$2" >&2
  exit 0
}

# A count is only usable if it is a non-negative integer. `gh api --jq length`
# prints nothing on failure, and a caller may pass an error marker through;
# neither may be read as "zero PRs, therefore guilty".
is_count() {
  case "${1-}" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

if [ "$#" -lt 4 ]; then
  decide ok "called with $# of 4 arguments, so nothing was actually checked"
fi

if [ "$LOOKUPS_OK" != "true" ]; then
  decide ok "the GitHub lookups did not clearly succeed (got '${LOOKUPS_OK}'), so a missing PR cannot be told from a failed query"
fi

if ! is_count "$ASSOC_COUNT" || ! is_count "$MERGE_SHA_PRS"; then
  decide ok "a lookup returned a non-numeric result (assoc='${ASSOC_COUNT}', merge_sha='${MERGE_SHA_PRS}'), which is a failed query rather than an absence"
fi

if [ "$ASSOC_COUNT" -gt 0 ]; then
  decide ok "commit ${SHA:0:7} is associated with ${ASSOC_COUNT} pull request(s)"
fi

# The L119 confirmation. Reached only when the association index says nothing,
# which is exactly the state that is NOT evidence on its own.
if [ "$MERGE_SHA_PRS" -gt 0 ]; then
  decide ok "the association index is empty for ${SHA:0:7}, but ${MERGE_SHA_PRS} merged pull request(s) record it as their merge commit, so the index is incomplete rather than the review being skipped"
fi

decide violation "commit ${SHA:0:7} is on main with no associated pull request and no merged pull request recording it as a merge commit, so it was pushed directly and skipped CI gating and review"
