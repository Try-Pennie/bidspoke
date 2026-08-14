#!/usr/bin/env bash
#
# Decide whether the Deploy Drift check should page (#790).
#
# The check compares the live worker's stamped commit to the latest commit
# touching apps/worker. It had no idea whether a deploy was IN FLIGHT, so a merge
# landing shortly before it fired produced a false page. Observed 2026-08-14:
#
#   19:54:54  deploy of 5687bc6 starts (takes about 6 minutes)
#   19:55:40  drift check runs, reads the worker mid-deploy, sees the old commit, pages
#   20:00:56  deploy completes successfully
#
# Nothing was stranded, and the alert's own advice (re-run the deploy) was a
# no-op. Not a rare collision either: GitHub's scheduled runs drift badly, and
# that day's hourly job actually fired at :55, :12, :05, :10 and :05, so it can
# land inside any deploy window.
#
# Usage:
#   deploy-drift-decision.sh <live_sha> <up_to_date:yes|no> <inflight_age_seconds|"">
#
# Prints exactly one word: `ok`, `deploy-in-flight`, or `alert`. The reason goes
# to stderr. Always exits 0; the caller acts on the word.
#
# THE FAIL-SAFE DIRECTION IS `alert`. Standing down is the narrow exception, and
# it applies only while an in-flight deploy is YOUNGER than one deploy's worth of
# time. A deploy stuck in progress must still page, or "a deploy is running"
# becomes a permanent excuse for silence (LESSONS L98) and this check quietly
# stops being able to report the thing it exists for (#327).

set -uo pipefail

# A deploy takes about 6 minutes. 15 gives generous headroom for a slow run while
# still catching one that has genuinely wedged.
MAX_INFLIGHT_SECONDS=${MAX_INFLIGHT_SECONDS:-900}

LIVE_SHA="${1-}"
UP_TO_DATE="${2-}"
INFLIGHT_AGE="${3-}"

decide() {
  printf '%s\n' "$1"
  printf 'deploy-drift-gate: %s (%s)\n' "$1" "$2" >&2
  exit 0
}

if [ "$#" -lt 2 ]; then
  decide alert "called with $# of 3 arguments, so no comparison happened"
fi

if [ -z "$LIVE_SHA" ] || [ "$LIVE_SHA" = "unknown" ] || [ "$LIVE_SHA" = "null" ]; then
  decide alert "live worker reports no deployed commit (got '${LIVE_SHA}'), so stamping itself is broken"
fi

if [ "$UP_TO_DATE" = "yes" ]; then
  decide ok "the latest worker commit is already live"
fi

if [ -z "$INFLIGHT_AGE" ]; then
  decide alert "worker is behind and no deploy is running"
fi

# Parse through one check and map anything unreadable to the loud side, rather
# than letting it compare false against the threshold and buy silence (L50).
case "$INFLIGHT_AGE" in
  ''|*[!0-9]*) decide alert "in-flight deploy age '${INFLIGHT_AGE}' is not a whole number of seconds, so it cannot be trusted to excuse the drift" ;;
esac

if [ "$INFLIGHT_AGE" -gt "$MAX_INFLIGHT_SECONDS" ]; then
  decide alert "a deploy has been in flight ${INFLIGHT_AGE}s, past the ${MAX_INFLIGHT_SECONDS}s ceiling, so it is stuck rather than merely slow"
fi

decide deploy-in-flight "a deploy started ${INFLIGHT_AGE}s ago is still running, so the worker is expected to be behind for now"
