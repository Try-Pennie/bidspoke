#!/usr/bin/env bash
#
# Which Deploy legs run on this run (#1761).
#
# Usage: deploy-targets-decision.sh <event_name> <worker> <worker_tail> <pages>
#
# The last three are dorny/paths-filter's outputs, which are only meaningful on a
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
# Prints three `name=true|false` lines for $GITHUB_OUTPUT. Always exits 0.

set -uo pipefail

EVENT="${1-}"
shift || true

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

echo "worker=$WORKER"
echo "worker_tail=$WORKER_TAIL"
echo "pages=$PAGES"

if [ "$EVENT" != "push" ]; then
  echo "deploy-targets: '$EVENT' has no previous push to compare with, so every target deploys" >&2
fi
