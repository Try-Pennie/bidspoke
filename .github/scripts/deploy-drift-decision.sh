#!/usr/bin/env bash
#
# Decide whether the Deploy Drift check should page (#790, #802).
#
# The check compares the live worker's stamped commit to the latest commit
# touching apps/worker. Two things made it page when nothing was wrong.
#
# #790: it had no idea whether a deploy was IN FLIGHT, so a merge landing shortly
# before it fired produced a false page. Observed 2026-08-14:
#
#   19:54:54  deploy of 5687bc6 starts (takes about 6 minutes)
#   19:55:40  drift check runs, reads the worker mid-deploy, sees the old commit, pages
#   20:00:56  deploy completes successfully
#
# Not a rare collision either: GitHub's scheduled runs drift badly, and that day's
# hourly job actually fired at :55, :12, :05, :10 and :05, so it can land inside
# any deploy window.
#
# #802: "the worker changed" was decided from git history over the apps/worker
# PATH, while the deploy decides it from the built BUNDLE. A commit touching only
# worker TEST files therefore read as a strand that no deploy could ever clear,
# because Deploy Worker correctly skips it (the bytes are identical) and the next
# hourly run sees the same gap again. Live 2026-08-14: #799 merged at 20:55 with
# Deploy Worker skipped, and this check then failed every hour from 21:40 onward
# with nothing whatsoever unshipped. Its own advice was a no-op, since re-running
# the deploy hits the same artifact gate. So the caller now CONFIRMS against the
# artifact before accusing (LESSONS L119), through the same predicate the deploy
# uses (L16), and passes the verdict in as the fourth argument.
#
# Usage:
#   deploy-drift-decision.sh <live_sha> <up_to_date:yes|no> <inflight_age_seconds|""> \
#                            <artifact:identical|differs|not-gated|unknown>
#
# `not-gated` is for a deploy target with no artifact gate, where the paths filter
# is the deploy's own predicate and history therefore settles the question on its
# own (#739).
#
# Prints exactly one word: `ok`, `deploy-in-flight`, `alert`, or
# `alert-unconfirmed`. The reason goes to stderr. Always exits 0; the caller acts
# on the word.
#
# THE FAIL-SAFE DIRECTION IS `alert`. Standing down is the narrow exception, and
# it applies only while an in-flight deploy is YOUNGER than one deploy's worth of
# time. A deploy stuck in progress must still page, or "a deploy is running"
# becomes a permanent excuse for silence (LESSONS L98) and this check quietly
# stops being able to report the thing it exists for (#327).
#
# The same reasoning governs the artifact verdict. Only an explicit `identical`
# buys silence. A comparison that could not be completed is its own loud outcome,
# never a pass, because a build that failed to run is not evidence of a healthy
# worker, and it is reported separately from a confirmed strand so the two are
# never read as the same fault (L11).

set -uo pipefail

# A deploy takes about 6 minutes. 15 gives generous headroom for a slow run while
# still catching one that has genuinely wedged.
MAX_INFLIGHT_SECONDS=${MAX_INFLIGHT_SECONDS:-900}

LIVE_SHA="${1-}"
UP_TO_DATE="${2-}"
INFLIGHT_AGE="${3-}"
ARTIFACT="${4-}"

decide() {
  printf '%s\n' "$1"
  printf 'deploy-drift-gate: %s (%s)\n' "$1" "$2" >&2
  exit 0
}

if [ "$#" -lt 4 ]; then
  decide alert-unconfirmed "called with $# of 4 arguments, so no comparison happened"
fi

if [ -z "$LIVE_SHA" ] || [ "$LIVE_SHA" = "unknown" ] || [ "$LIVE_SHA" = "null" ]; then
  decide alert "live worker reports no deployed commit (got '${LIVE_SHA}'), so stamping itself is broken"
fi

if [ "$UP_TO_DATE" = "yes" ]; then
  decide ok "the latest worker commit is already live"
fi

# Checked before anything to do with deploys: an identical artifact means there
# is nothing to ship, whatever else is happening. This is the #802 case, where
# the worker is behind only by commits that cannot reach the bundle.
if [ "$ARTIFACT" = "identical" ]; then
  decide ok "the worker is behind in history, but the built artifact is byte identical to what is live, so nothing is unshipped"
fi

if [ -n "$INFLIGHT_AGE" ]; then
  # Parse through one check and map anything unreadable to the loud side, rather
  # than letting it compare false against the threshold and buy silence (L50).
  case "$INFLIGHT_AGE" in
    *[!0-9]*) decide alert "in-flight deploy age '${INFLIGHT_AGE}' is not a whole number of seconds, so it cannot be trusted to excuse the drift" ;;
  esac

  if [ "$INFLIGHT_AGE" -gt "$MAX_INFLIGHT_SECONDS" ]; then
    decide alert "a deploy has been in flight ${INFLIGHT_AGE}s, past the ${MAX_INFLIGHT_SECONDS}s ceiling, so it is stuck rather than merely slow"
  fi

  decide deploy-in-flight "a deploy started ${INFLIGHT_AGE}s ago is still running, so the worker is expected to be behind for now"
fi

if [ "$ARTIFACT" = "differs" ]; then
  decide alert "worker is behind, the built artifact differs from what is live, and no deploy is running"
fi

# A target with NO artifact gate (#739). The engine worker's deploy decides from
# the built bundle, which is why history is only a pre-filter for it and an
# accusation must be confirmed against the artifact first (#802). The tail worker
# has no such gate: its deploy fires on its paths filter alone. So there the paths
# filter IS the deploy's own predicate, this check asks the identical question,
# and the two cannot disagree.
#
# Which makes being behind in history the CONFIRMED condition rather than a
# suspicion awaiting evidence that will never arrive. Letting it fall through to
# alert-unconfirmed below would leave that check permanently reporting that it
# could not confirm, which is a guard unable to ever say the thing it exists for.
if [ "$ARTIFACT" = "not-gated" ]; then
  decide alert "the target is behind, it has no artifact gate so history is the deploy's own predicate, and no deploy is running"
fi

decide alert-unconfirmed "worker is behind and the confirming artifact comparison did not complete (got '${ARTIFACT}'), so this check cannot currently tell a strand from a no-op"
