#!/usr/bin/env bash
#
# One sentence saying what happened to the newest Deploy run on main, for the
# Deploy Drift alert to quote when its remedy is a deploy (#3152).
#
# On 2026-10-30 drift posted "Worker code is committed but not deployed" a
# minute after the Deploy of 463814f failed at Verify (worker tests), and could
# only say "a deploy failed at Verify, or a merge started no Deploy". The newest
# Deploy run on main answers which, so the alert now says it: the step that
# failed, a run that succeeded on an older commit (so none ran since), a run
# that was cancelled or is still going.
#
# A lookup that fails says the cause is unknown, never a guess (L11), and the
# reason goes to stderr for the run log. Always exits 0: the alert is still
# worth sending without this sentence.
#
# The run list is filtered on the workflow alone and the branch is judged in
# jq, for the reason deploy-inflight-age.sh gives (#1650, L1014).

set -uo pipefail

GH_BIN="${GH_BIN:-gh}"
DEPLOY_WORKFLOW="${DEPLOY_WORKFLOW:-deploy.yml}"
RUN_LIMIT="${RUN_LIMIT:-20}"

ERR_FILE=$(mktemp)
trap 'rm -f "$ERR_FILE"' EXIT

say() {
  printf '%s\n' "$1"
  printf 'deploy-latest-outcome: %s\n' "$2" >&2
  exit 0
}

# id, url, short commit, status, conclusion of the newest run on main, tab
# separated, or nothing when no run on main is listed.
if ! RUN=$("$GH_BIN" run list --workflow="$DEPLOY_WORKFLOW" --limit "$RUN_LIMIT" \
  --json databaseId,url,headSha,headBranch,status,conclusion,createdAt \
  --jq '[.[] | select(.headBranch == "main")] | sort_by(.createdAt) | last
        | select(. != null)
        | [(.databaseId | tostring), .url, .headSha[0:7], .status, (.conclusion // "")] | @tsv' 2>"$ERR_FILE"); then
  WHY=$(tr '\n' ' ' <"$ERR_FILE" | cut -c1-300)
  say 'The newest Deploy run on main could not be read, so why the deploy did not land is unknown.' \
    "the run list failed: ${WHY:-no error text}"
fi

if [ -z "$(printf '%s' "$RUN" | tr -d '[:space:]')" ]; then
  say "No Deploy run on main is among the newest ${RUN_LIMIT} Deploy runs, so no Deploy has run for this commit." \
    'the run list succeeded and held no run on main'
fi

IFS=$'\t' read -r ID URL SHA STATUS CONCLUSION <<<"$RUN"
case "$ID" in
  '' | *[!0-9]*)
    say 'The newest Deploy run on main could not be read, so why the deploy did not land is unknown.' \
      "the run list answered '${RUN}', which is not a run" ;;
esac
LEAD="The newest Deploy run on main, <${URL}|run ${ID}> for \`${SHA}\`,"

if [ "$STATUS" != "completed" ]; then
  say "${LEAD} is still running." "run ${ID} is ${STATUS}"
fi

case "$CONCLUSION" in
  success)
    say "${LEAD} succeeded, so no Deploy has run on main since that commit." "run ${ID} succeeded" ;;
  failure)
    # The jobs endpoint answers the latest attempt, which is the one that failed.
    if ! FAILED=$("$GH_BIN" api "repos/{owner}/{repo}/actions/runs/${ID}/jobs?per_page=100" \
      --jq '[.jobs[] | select(.conclusion == "failure") | .name] | join(", ")' 2>"$ERR_FILE"); then
      WHY=$(tr '\n' ' ' <"$ERR_FILE" | cut -c1-300)
      say "${LEAD} failed, and which step failed could not be read." "the jobs of run ${ID} could not be read: ${WHY:-no error text}"
    fi
    FAILED=$(printf '%s' "$FAILED" | tr -d '\n')
    if [ -z "$FAILED" ]; then
      say "${LEAD} failed, and which step failed could not be read." "run ${ID} failed with no job marked failed"
    fi
    say "${LEAD} failed at ${FAILED}." "run ${ID} failed at ${FAILED}" ;;
  *)
    say "${LEAD} finished as ${CONCLUSION:-unknown}." "run ${ID} finished as ${CONCLUSION:-unknown}" ;;
esac
