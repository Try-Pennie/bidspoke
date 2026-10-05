#!/usr/bin/env bash
#
# Merge a routine Dependabot pull request, then start Deploy on main (#1761).
#
# Usage: dependabot-merge-and-deploy.sh <owner/repo> <pr_number>
#   env: GH_TOKEN (the workflow token, with actions: write), GH_BIN (test seam)
#
# Why the dispatch: this merges with GITHUB_TOKEN, and GitHub starts no workflow
# from a push made with that token, so before #1761 no Deploy ran for any
# auto-merged pull request and main sat undeployed until a human merge followed.
# A workflow_dispatch sent with GITHUB_TOKEN is the documented exception that does
# start a run.
#
# Whether the merge happened is judged by the pull request's STATE afterwards,
# never by the merge command's exit code alone (L12, L184): with --delete-branch,
# gh can merge and then fail on the branch delete, and a dispatch that followed
# only a clean exit would skip Deploy for a merge that landed.
#
# Exits non zero, with an ::error:: naming why, when the merge did not land or the
# dispatch was refused, so the run goes red and GitHub's failure email says so. A
# merge that started no Deploy must never read as a success.

set -uo pipefail

REPO="${1-}"
PR="${2-}"
GH_BIN="${GH_BIN:-gh}"

if [ -z "$REPO" ] || [ -z "$PR" ]; then
  echo "::error::usage: dependabot-merge-and-deploy.sh <owner/repo> <pr_number>"
  exit 2
fi

"$GH_BIN" pr merge "$PR" --repo "$REPO" --squash --delete-branch
MERGE_EXIT=$?

STATE=""
MERGE_COMMIT=""
if VIEW=$("$GH_BIN" pr view "$PR" --repo "$REPO" --json state,mergeCommit --jq '.state + " " + (.mergeCommit.oid // "")'); then
  read -r STATE MERGE_COMMIT <<<"$VIEW"
fi

if [ "$STATE" = "MERGED" ]; then
  if [ "$MERGE_EXIT" -ne 0 ]; then
    echo "::warning::gh reported a failure (exit ${MERGE_EXIT}) but #${PR} is merged, most likely the branch delete. Deploy is still started; the branch may need deleting by hand."
  fi
elif [ -z "$STATE" ] && [ "$MERGE_EXIT" -eq 0 ]; then
  # The merge command succeeded and only the read back failed. Starting Deploy
  # on main is harmless if the merge somehow did not land (it redeploys what is
  # already there), and skipping it is the defect this script exists to end.
  echo "::warning::#${PR}'s state could not be read after a clean merge, so it is taken as merged and Deploy is started."
else
  echo "::error::#${PR} did not merge (state ${STATE:-unreadable}, merge exit ${MERGE_EXIT}), so Deploy was not started."
  exit 1
fi

# The commit main was at before this merge, which is what a push run would have
# given the money gate as its base. Unreadable is not fatal: the dispatched run
# then compares against the commit the live worker reports, and refuses by name
# if that is unusable too.
BASE_ARGS=()
if [ -n "$MERGE_COMMIT" ]; then
  if PARENT=$("$GH_BIN" api "repos/${REPO}/commits/${MERGE_COMMIT}" --jq '.parents[0].sha') \
     && [[ "$PARENT" =~ ^[0-9a-f]{40}$ ]]; then
    BASE_ARGS=(-f "money_gate_base=${PARENT}")
  else
    echo "::warning::the commit before #${PR}'s merge could not be read, so the money gate will compare against the commit the live worker reports."
  fi
fi

echo "Starting Deploy on main for the merge of #${PR}"
if ! "$GH_BIN" workflow run deploy.yml --repo "$REPO" --ref main -f "reason=auto-merge of #${PR}" ${BASE_ARGS[@]+"${BASE_ARGS[@]}"}; then
  echo "::error::#${PR} merged, but starting Deploy on main was refused, so main is NOT deployed. Start Deploy on main from the Actions tab (Actions, Deploy, Run workflow), and check this workflow still grants actions: write."
  exit 1
fi
echo "Deploy on main started."
