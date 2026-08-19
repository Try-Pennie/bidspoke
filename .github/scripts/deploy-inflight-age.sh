#!/usr/bin/env bash
#
# How long the oldest Deploy run still queued or running on main has been in
# flight, for the three Deploy Drift jobs to stand down on (#790, #899).
#
# All three jobs need this and all three carried their own copy of the query.
# They now share one (LESSONS L16), because the interesting part is not the query
# but what it means when it fails, and three copies is three chances to get that
# wrong.
#
# #899 is what the old copies got wrong. Each ran:
#
#     INFLIGHT_AGE=$(gh run list ... 2>/dev/null || true)
#
# and the job declared no `permissions:` block, so the call ran with this
# repository's default workflow token of `read`, which grants contents and
# packages and nothing else. Refused for want of `actions: read`, the error went
# to /dev/null and the empty result reached the gate as "no deploy is running",
# which is deliberately its LOUD side. So the gate written to PREVENT a false
# page was the direct cause of one, and had never once been able to fire.
#
# Both of the only two Deploy Drift failures ever recorded were runs that
# overlapped a healthy in-flight deploy, and both logged `inflight_age=none`:
#
#   2026-08-19 19:38:36  drift ran; deploy of a6c2fac was live 19:33:30-19:39:32
#   2026-08-18 13:56:20  drift ran; deploy of a401cbf was live 13:51:28-13:57:43
#
# So this prints THREE distinct answers, never two, because a query that failed
# and a pipeline that is genuinely idle need different actions from whoever reads
# the alert (L11), and folding them onto one value is what made the broken state
# indistinguishable from the healthy one (L98):
#
#   <seconds>      a deploy is queued or running, and has been for that long
#   (empty)        the query SUCCEEDED and no deploy is queued or running
#   unavailable    the query could not be answered, so nothing is known
#
# `unavailable` is a distinct word rather than an empty string precisely so a
# caller cannot accidentally read it as an idle pipeline. Every caller's gate
# treats it as its own loud outcome.
#
# Always exits 0. The caller acts on the word, and the reason goes to stderr so
# the run log shows which of the three states was reached even when the answer is
# the empty one, which is otherwise unreadable in a log.

set -uo pipefail

GH_BIN="${GH_BIN:-gh}"
DEPLOY_WORKFLOW="${DEPLOY_WORKFLOW:-deploy.yml}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"

# jq does the clock arithmetic so this does not depend on GNU date, which the
# macOS `date` does not provide.
JQ_FILTER='[.[] | select(.status == "in_progress" or .status == "queued")]
  | sort_by(.createdAt) | (.[0].createdAt // empty)
  | (now - fromdateiso8601 | floor)'

answer() {
  # $1 is the answer, which is EMPTY for a definite "no deploy is running". A
  # bare newline keeps that readable to `$(...)`, which strips it back to "".
  printf '%s\n' "$1"
  printf 'deploy-inflight: %s (%s)\n' "${1:-none}" "$2" >&2
  exit 0
}

# stderr is captured to a file rather than folded into stdout with 2>&1. gh
# writes upgrade and deprecation notices to stderr on perfectly good calls, and
# merging those into the answer would make a cosmetic notice read as a
# non-numeric reading, so the check would report itself broken for good on a
# message that meant nothing.
ERR_FILE=$(mktemp)
trap 'rm -f "$ERR_FILE"' EXIT

if ! OUT=$("$GH_BIN" run list --workflow="$DEPLOY_WORKFLOW" --branch "$DEPLOY_BRANCH" \
  --limit 20 --json status,createdAt --jq "$JQ_FILTER" 2>"$ERR_FILE"); then
  # Judged by the EXIT CODE, never by whether it happened to print something
  # (L184). A failing gh can still write to stdout, and that output is its
  # complaint rather than an answer.
  WHY=$(tr '\n' ' ' <"$ERR_FILE" | cut -c1-300)
  answer unavailable "the query for in-flight deploys failed, so whether one is running is unknown: ${WHY:-no error text}"
fi

AGE=$(printf '%s' "$OUT" | tr -d '[:space:]')

if [ -z "$AGE" ]; then
  answer '' "the query succeeded and no Deploy run is queued or running on ${DEPLOY_BRANCH}"
fi

# Mapped to the loud side rather than passed on, so a non-numeric value cannot
# reach a caller's `-gt` comparison, where it would compare false and buy silence
# (L50).
case "$AGE" in
  *[!0-9]*)
    answer unavailable "the query answered '${AGE}', which is not a whole number of seconds, so it cannot be trusted to excuse anything" ;;
esac

answer "$AGE" "a Deploy run has been in flight ${AGE}s on ${DEPLOY_BRANCH}"
