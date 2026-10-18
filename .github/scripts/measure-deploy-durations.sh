#!/usr/bin/env bash
#
# Measure how long healthy Deploy runs take, the reading the in-flight ceilings
# in deploy-inflight-ceiling.sh are set from (#2409, L316). Run by hand:
#
#   bash .github/scripts/measure-deploy-durations.sh [newest runs to read, default 100]
#
# Reads the newest runs of the Deploy workflow, keeps those that completed
# successfully on main at their first attempt (a re-run keeps its original
# createdAt, so its age would count the time between attempts), and prints one
# line per run and then the distribution of both numbers the gate judges:
#
#   age      created to finished, from the run's createdAt and updatedAt
#   running  the time at least one of its jobs held a runner, through the same
#            deploy-running-seconds.jq the drift check judges a live run by, so
#            the number measured is the number judged (L107)
#
# Percentiles are nearest rank. It reads one jobs list per run, so 100 runs is
# about 100 API calls. Exits non-zero, saying why, when the run list or any jobs
# list cannot be read, or when no run qualifies: a measurement that quietly
# covered fewer runs than it says is how a ceiling gets set from the wrong data.

set -uo pipefail

GH_BIN="${GH_BIN:-gh}"
DEPLOY_WORKFLOW="${DEPLOY_WORKFLOW:-deploy.yml}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
LIMIT="${1:-100}"
export DEPLOY_BRANCH

case "$LIMIT" in
  '' | *[!0-9]*) echo "measure-deploy-durations: '${LIMIT}' is not a number of runs" >&2; exit 2 ;;
esac

RUNNING_FILTER=$(cat "$(dirname "${BASH_SOURCE[0]}")/deploy-running-seconds.jq") || exit 1

if ! RUNS=$("$GH_BIN" run list --workflow="$DEPLOY_WORKFLOW" --limit "$LIMIT" \
  --json databaseId,status,conclusion,headBranch,attempt,createdAt,updatedAt,headSha \
  --jq '.[] | select(.headBranch == $ENV.DEPLOY_BRANCH and .status == "completed"
      and .conclusion == "success" and .attempt == 1)
    | "\(.databaseId) \(.headSha[0:7]) \(.createdAt) \((.updatedAt | fromdateiso8601) - (.createdAt | fromdateiso8601))"'); then
  echo "measure-deploy-durations: the run list could not be read" >&2
  exit 1
fi

TABLE=''
while read -r ID SHA CREATED AGE; do
  [ -z "${ID:-}" ] && continue
  if ! RUNNING=$("$GH_BIN" api "repos/{owner}/{repo}/actions/runs/${ID}/jobs?per_page=100" --jq "$RUNNING_FILTER"); then
    echo "measure-deploy-durations: the jobs of run ${ID} could not be read, so the measurement would be incomplete" >&2
    exit 1
  fi
  RUNNING=$(printf '%s' "$RUNNING" | tr -d '[:space:]')
  case "$RUNNING" in
    '' | *[!0-9]*) echo "measure-deploy-durations: the jobs of run ${ID} answered '${RUNNING}', not a number of seconds" >&2; exit 1 ;;
  esac
  printf 'run %s %s %s age=%s running=%s\n' "$ID" "$SHA" "$CREATED" "$AGE" "$RUNNING"
  TABLE="${TABLE}${CREATED} ${AGE} ${RUNNING}"$'\n'
done <<<"$RUNS"

if [ -z "$TABLE" ]; then
  echo "measure-deploy-durations: no successful first attempt Deploy run on ${DEPLOY_BRANCH} among the newest ${LIMIT}, so there is nothing to measure" >&2
  exit 1
fi

printf '%s' "$TABLE" | jq -R -s -r '
  [split("\n")[] | select(length > 0) | split(" ") | {created: .[0], age: (.[1] | tonumber), running: (.[2] | tonumber)}] as $runs
  | ($runs | length) as $n
  | def rank($p): (($p / 100 * $n) | ceil | if . < 1 then 1 else . end) - 1;
    def dist(f): ([$runs[] | f] | sort) as $v
      | "min=\($v[0]) p50=\($v[rank(50)]) p90=\($v[rank(90)]) p95=\($v[rank(95)]) p99=\($v[rank(99)]) max=\($v[-1])";
  "deploy-durations: runs=\($n) created \([$runs[].created] | min) to \([$runs[].created] | max)",
  "running \(dist(.running))",
  "age \(dist(.age))"'
