#!/usr/bin/env bash
#
# How long Deploy runs still queued or running on main have been in flight, and
# how much of that they spent running, for the three Deploy Drift jobs to stand
# down on (#790, #899, #2409).
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
#
# So this prints THREE distinct answers, never two, because a query that failed
# and a pipeline that is genuinely idle need different actions from whoever reads
# the alert (L11), and folding them onto one value is what made the broken state
# indistinguishable from the healthy one (L98):
#
#   age=<s>,running=<s>   a deploy is queued or running (see below)
#   (empty)               the query SUCCEEDED and no deploy is queued or running
#   unavailable           the query could not be answered, so nothing is known
#
# `unavailable` is a distinct word rather than an empty string precisely so a
# caller cannot accidentally read it as an idle pipeline. Every caller's gate
# treats it as its own loud outcome.
#
# TWO NUMBERS SINCE #2409. `age` is how long ago the OLDEST in-flight Deploy run
# on main was created. `running` is the longest any in-flight run on main has
# actually spent running: the time at least one of its jobs held a runner, from
# deploy-running-seconds.jq, so time spent waiting for a runner does not count.
# On 2026-10-18 the age alone (1483s) paged a healthy deploy as stuck while its
# jobs had held a runner for 753s of it, and the rest was waiting. The gate
# (deploy-inflight-ceiling.sh) judges stuck by the running time, with a backstop
# on the age, so a run that never gets a runner still pages.
#
# When a run's jobs cannot be read, `running` is the word `unknown` and the gate
# judges the age in its place, which can only overstate it. That keeps the
# partial failure on the loud side without calling the whole query unavailable,
# since the run list did answer and a deploy IS in flight.
#
# Always exits 0. The caller acts on the word, and the reason goes to stderr so
# the run log shows which of the three states was reached even when the answer is
# the empty one, which is otherwise unreadable in a log.

set -uo pipefail

GH_BIN="${GH_BIN:-gh}"
DEPLOY_WORKFLOW="${DEPLOY_WORKFLOW:-deploy.yml}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"

# How many of the workflow's newest runs to read. Deploy runs only on pushes to
# main today, so every listed run is normally a main run; the branch is still
# judged below rather than assumed, and 20 is far more than can be in flight.
RUN_LIMIT="${RUN_LIMIT:-20}"

# ONE filter on the query, the workflow, and the branch and status judged here
# (#1650). GitHub answers a run list filtered on two fields at once from an index
# that can lag a run that has just started (LESSONS L1014): on 2026-09-30 Deploy
# Drift run 36731631369 asked with `--branch main` about a minute after Deploy run
# 36731518395 started, was told nothing was running, and paged a stranded worker
# that was mid deploy, while the same query a minute later saw it at 126s.
#
# One line per in-flight run on main, oldest first: its id, then its age in
# seconds. jq does the clock arithmetic so this does not depend on GNU date,
# which the macOS `date` does not provide.
JQ_FILTER='[.[] | select(.headBranch == $ENV.DEPLOY_BRANCH)
    | select(.status == "in_progress" or .status == "queued")]
  | sort_by(.createdAt) | .[]
  | "\(.databaseId) \(now - (.createdAt | fromdateiso8601) | floor)"'
export DEPLOY_BRANCH

RUNNING_FILTER_FILE="$(dirname "${BASH_SOURCE[0]}")/deploy-running-seconds.jq"

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

if ! OUT=$("$GH_BIN" run list --workflow="$DEPLOY_WORKFLOW" \
  --limit "$RUN_LIMIT" --json databaseId,status,createdAt,headBranch --jq "$JQ_FILTER" 2>"$ERR_FILE"); then
  # Judged by the EXIT CODE, never by whether it happened to print something
  # (L184). A failing gh can still write to stdout, and that output is its
  # complaint rather than an answer.
  WHY=$(tr '\n' ' ' <"$ERR_FILE" | cut -c1-300)
  answer unavailable "the query for in-flight deploys failed, so whether one is running is unknown: ${WHY:-no error text}"
fi

if [ -z "$(printf '%s' "$OUT" | tr -d '[:space:]')" ]; then
  answer '' "the query succeeded and no Deploy run is queued or running on ${DEPLOY_BRANCH}"
fi

# Every line must be two whole numbers. Anything else is mapped to the loud side
# rather than passed on, so a non-numeric value cannot reach a caller's
# comparison, where it would compare false and buy silence (L50).
AGE=''
IDS=''
while IFS= read -r LINE; do
  [ -z "$LINE" ] && continue
  if ! [[ "$LINE" =~ ^[0-9]+\ [0-9]+$ ]]; then
    answer unavailable "the query answered '${LINE}', which is not a run id and a whole number of seconds, so it cannot be trusted to excuse anything"
  fi
  # Oldest first, so the first line carries the age.
  [ -z "$AGE" ] && AGE="${LINE#* }"
  IDS="${IDS:+$IDS }${LINE%% *}"
done <<<"$OUT"

if [ ! -r "$RUNNING_FILTER_FILE" ]; then
  answer "age=${AGE},running=unknown" "a Deploy run has been in flight ${AGE}s on ${DEPLOY_BRANCH}, and how long it has been running cannot be read because ${RUNNING_FILTER_FILE} is missing"
fi
RUNNING_FILTER=$(cat "$RUNNING_FILTER_FILE")

# The longest any in-flight run has held a runner. One unreadable run makes the
# whole answer `unknown`, because the run that could not be read may be the one
# that is stuck.
RUNNING=0
for ID in $IDS; do
  if ! R=$("$GH_BIN" api "repos/{owner}/{repo}/actions/runs/${ID}/jobs?per_page=100" \
    --jq "$RUNNING_FILTER" 2>"$ERR_FILE"); then
    WHY=$(tr '\n' ' ' <"$ERR_FILE" | cut -c1-300)
    answer "age=${AGE},running=unknown" "a Deploy run has been in flight ${AGE}s on ${DEPLOY_BRANCH}, and the jobs of run ${ID} could not be read, so how long it has been running is unknown: ${WHY:-no error text}"
  fi
  R=$(printf '%s' "$R" | tr -d '[:space:]')
  case "$R" in
    '' | *[!0-9]*) answer "age=${AGE},running=unknown" "a Deploy run has been in flight ${AGE}s on ${DEPLOY_BRANCH}, and the jobs of run ${ID} answered '${R}', which is not a whole number of seconds running" ;;
  esac
  [ "$R" -gt "$RUNNING" ] && RUNNING="$R"
done

answer "age=${AGE},running=${RUNNING}" "a Deploy run has been in flight ${AGE}s on ${DEPLOY_BRANCH}, and the longest any in-flight run has held a runner is ${RUNNING}s (runs ${IDS})"
