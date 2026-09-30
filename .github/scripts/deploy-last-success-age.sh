#!/usr/bin/env bash
#
# How long ago the newest Pages upload on main finished, for the propagation
# grace in the site half of Deploy Drift (#901).
#
# A Pages deploy propagates per route, and it goes on doing so AFTER the Deploy
# run has completed. The in-flight gate (deploy-inflight-age.sh, #790) stands
# down while a run is still going, so it cannot cover that window, and an hourly
# check landing in it sees routes behind with no deploy running and pages for a
# site that is simply settling. The decision script excuses `behind` while the
# age printed here is under a measured grace.
#
# Three things about what is measured, each from a recorded failure:
#
#   - It is the age of the UPLOAD STEP ("Deploy to Cloudflare Pages"), not the
#     job or the run. The job goes on to watch the routes flip after uploading,
#     and the run goes on to check the database, so anchoring on either would
#     apply a grace calibrated against a different instant (LESSONS L209). The
#     propagation sampler in deploy.yml starts its clock right after that same
#     step, so both sides measure from one anchor.
#   - It reads the NEWEST attempt, never the newest success. If the newest Pages
#     deploy FAILED, the site is behind because of that failure, and excusing it
#     on the strength of an older success would hide the stranding for the whole
#     grace window (L458). A run whose Deploy Pages job was skipped by its paths
#     filter shipped nothing to the site, so it is not an attempt and is walked
#     past.
#   - It answers with THREE states, like the in-flight script, because a query
#     that failed and a pipeline with nothing to excuse need different actions
#     from whoever reads the alert (L11), and folding them together is what made
#     the in-flight gate cause the false page it existed to prevent (#899, L98):
#
#       <seconds>      the newest Pages attempt succeeded, that long ago
#       (empty)        the query SUCCEEDED and there is no upload to excuse: no
#                      recent run attempted a Pages deploy, or the newest attempt
#                      did not succeed
#       unavailable    the query could not be answered, so nothing is known
#
# Always exits 0. The caller acts on the word; the reason goes to stderr so the
# run log shows which state was reached even when the answer is the empty one.
#
# Reads: `gh run list` for the recent runs, then the jobs of each completed run
# newest first until one that attempted a Pages deploy is found. At most
# RUN_WINDOW + 1 calls, once an hour.

set -uo pipefail

GH_BIN="${GH_BIN:-gh}"
DEPLOY_WORKFLOW="${DEPLOY_WORKFLOW:-deploy.yml}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
RUN_WINDOW="${RUN_WINDOW:-10}"
# Injectable for tests, so a fixture's age is exact (L130, L524).
CLOCK_EPOCH="${CLOCK_EPOCH:-$(date +%s)}"

# Load-bearing names (L305). A test reads these two lines and checks deploy.yml
# still declares a job and a step by these names.
PAGES_JOB_NAME="Deploy Pages"
PAGES_UPLOAD_STEP_NAME="Deploy to Cloudflare Pages"

answer() {
  printf '%s\n' "$1"
  printf 'deploy-last-success: %s (%s)\n' "${1:-none}" "$2" >&2
  exit 0
}

# stderr captured to a file rather than folded into the answer: gh writes
# upgrade notices to stderr on perfectly good calls, and merging those in would
# make a cosmetic notice read as a broken answer for good.
ERR_FILE=$(mktemp)
trap 'rm -f "$ERR_FILE"' EXIT

# ONE filter on the query, the workflow, with the branch judged below (#1650).
# GitHub answers a run list filtered on two fields at once from an index that can
# lag a run that has just changed (LESSONS L1014), which on 2026-09-30 hid a
# running Deploy from the in-flight gate beside this one. Here the same lag would
# hide the newest completed run and measure the grace from an older upload.
if ! RUNS_JSON=$("$GH_BIN" run list --workflow="$DEPLOY_WORKFLOW" \
  --limit "$RUN_WINDOW" --json databaseId,status,headBranch 2>"$ERR_FILE"); then
  # Judged by the EXIT CODE, never by whether it printed something (L184).
  WHY=$(tr '\n' ' ' <"$ERR_FILE" | cut -c1-300)
  answer unavailable "listing recent Deploy runs failed, so the age of the last Pages upload is unknown: ${WHY:-no error text}"
fi

# Completed runs only, newest first (gh lists newest first). A run still in
# flight belongs to the in-flight gate, which judges it before this is consulted.
if ! RUN_IDS=$(printf '%s' "$RUNS_JSON" | jq -r --arg branch "$DEPLOY_BRANCH" \
  '.[] | select(.headBranch == $branch and .status == "completed") | .databaseId' 2>"$ERR_FILE"); then
  WHY=$(tr '\n' ' ' <"$ERR_FILE" | cut -c1-300)
  answer unavailable "the run list could not be parsed: ${WHY:-no error text}"
fi

if [ -z "$RUN_IDS" ]; then
  answer '' "the query succeeded and no completed Deploy run on ${DEPLOY_BRANCH} was found among the last ${RUN_WINDOW} Deploy runs"
fi

for RUN_ID in $RUN_IDS; do
  # A failed read is NOT "this run attempted nothing". Walking on to an older run
  # would answer with a deploy that is not the newest attempt, which is the L458
  # mistake reached by another road (L173, L211).
  if ! JOBS_JSON=$("$GH_BIN" api "repos/{owner}/{repo}/actions/runs/${RUN_ID}/jobs" 2>"$ERR_FILE"); then
    WHY=$(tr '\n' ' ' <"$ERR_FILE" | cut -c1-300)
    answer unavailable "the jobs of Deploy run ${RUN_ID} could not be read, so the newest Pages attempt is unknown: ${WHY:-no error text}"
  fi

  JOB_CONCLUSION=$(printf '%s' "$JOBS_JSON" | jq -r --arg job "$PAGES_JOB_NAME" \
    '[.jobs[] | select(.name == $job)] | (.[0].conclusion // "absent")' 2>/dev/null)

  case "$JOB_CONCLUSION" in
    skipped | absent)
      # Nothing shipped to the site from this run. Not an attempt; keep walking.
      continue ;;
    success) ;;
    *)
      answer '' "the newest Pages deploy attempt, Deploy run ${RUN_ID}, ended ${JOB_CONCLUSION} rather than success, so there is no upload whose propagation could excuse a stale route" ;;
  esac

  COMPLETED_AT=$(printf '%s' "$JOBS_JSON" | jq -r --arg job "$PAGES_JOB_NAME" --arg step "$PAGES_UPLOAD_STEP_NAME" \
    '[.jobs[] | select(.name == $job) | .steps[] | select(.name == $step and .conclusion == "success")] | (.[0].completed_at // empty)' 2>/dev/null)

  if [ -z "$COMPLETED_AT" ]; then
    answer unavailable "Deploy run ${RUN_ID} has a successful '${PAGES_JOB_NAME}' job with no successful step named '${PAGES_UPLOAD_STEP_NAME}', so the upload instant cannot be read; the step may have been renamed in deploy.yml"
  fi

  AGE=$(jq -n --arg t "$COMPLETED_AT" --argjson now "$CLOCK_EPOCH" '($now - ($t | fromdateiso8601)) | floor' 2>/dev/null | tr -d '[:space:]')

  # Mapped to the loud side rather than passed on, so a non-numeric or negative
  # value cannot reach a caller's comparison (L50).
  case "$AGE" in
    '' | *[!0-9]*)
      answer unavailable "the upload instant '${COMPLETED_AT}' of Deploy run ${RUN_ID} did not yield a whole number of seconds (got '${AGE}'), so it cannot be trusted to excuse anything" ;;
  esac

  answer "$AGE" "the newest Pages upload, Deploy run ${RUN_ID}, finished ${AGE}s ago"
done

answer '' "the query succeeded and none of the completed Deploy runs on ${DEPLOY_BRANCH} among the last ${RUN_WINDOW} Deploy runs attempted a Pages deploy"
