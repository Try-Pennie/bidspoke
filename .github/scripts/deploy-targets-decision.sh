#!/usr/bin/env bash
#
# Which Deploy legs run on this run (#1761).
#
# Usage: deploy-targets-decision.sh <event_name> <ref> <worker> <worker_tail> <pages> <compare_outbound>
#
# <ref> is github.ref. Only refs/heads/main deploys. Deploy Worker and Deploy
# Worker Tail (and Deploy Compare Outbound) run `wrangler deploy`, which goes to production whatever branch the
# run is on, and the worker drift check skips a commit that is not in main's
# history, so a Deploy dispatched from a branch would put unreviewed code live with
# nothing reporting it and nothing having passed through a pull request. A run on
# any other ref deploys nothing and refuses by name (exit 1), so it reads red
# rather than as a green run that did nothing.
#
# The last four are dorny/paths-filter's outputs, which are only meaningful on a
# push: the filter compares the push with the commit before it. A dispatched run
# has no previous push, and the filter then compares HEAD with HEAD^ alone, so a
# Deploy started on a tip that touched only docs would deploy nothing and report
# green. That is the exact stranded state a dispatched run exists to repair (the
# Dependabot auto-merge dispatches Deploy because its GITHUB_TOKEN merge starts no
# push run, and the drift alerts tell a person to start one by hand).
#
# So a dispatched run deploys every target, and so does any event this does not
# know. Over deploying is safe: Deploy Worker still skips a byte identical bundle
# (the artifact gate), a Pages redeploy is free, and a tail redeploy is harmless.
# On a push, a filter value that is not exactly `true` or `false` was not
# measured, and a value nobody measured must not be what skips a deploy.
#
# Prints four `name=true|false` lines for $GITHUB_OUTPUT. Exits 0 on main, and
# 1 (after printing all four false) on any other ref. compare_outbound is the
# compare namespace's outbound Worker (#1708 part B).

set -uo pipefail

EVENT="${1-}"
REF="${2-}"
shift 2 || shift $# || true

if [ "$REF" != "refs/heads/main" ]; then
  echo "worker=false"
  echo "worker_tail=false"
  echo "pages=false"
  echo "compare_outbound=false"
  echo "::error::Deploy runs only on main, and this run is on '${REF}', so nothing deploys. Start Deploy on main from the Actions tab (Actions, Deploy, Run workflow, branch main)." >&2
  exit 1
fi

judge() {
  case "$EVENT" in
    push)
      case "$1" in
        false) echo false ;;
        *) echo true ;;
      esac ;;
    *) echo true ;;
  esac
}

WORKER=$(judge "${1-}")
WORKER_TAIL=$(judge "${2-}")
PAGES=$(judge "${3-}")
COMPARE_OUTBOUND=$(judge "${4-}")

echo "worker=$WORKER"
echo "worker_tail=$WORKER_TAIL"
echo "pages=$PAGES"
echo "compare_outbound=$COMPARE_OUTBOUND"

if [ "$EVENT" != "push" ]; then
  echo "deploy-targets: '$EVENT' has no previous push to compare with, so every target deploys" >&2
fi
