#!/usr/bin/env bash
# Decides whether a Dependabot PR is safe to auto-merge.
#
# Usage: dependabot-automerge-decision.sh <author-login> <head-branch>
# Prints "merge" or "skip" to stdout and always exits 0, so the caller can
# branch on the word rather than on an exit code.
#
# Two gates, both must pass to merge:
#   1. Author must be Dependabot. The gh CLI has rendered this login as both
#      "dependabot[bot]" (legacy) and "app/dependabot" (current). Accepting the
#      wrong spelling silently skipped every routine PR for weeks (2026-07-24),
#      so both are allowlisted here and covered by tests.
#   2. Branch must be a routine, low-risk category:
#        - dependabot/npm_and_yarn/minor-and-patch-*  (the grouped non-major npm
#          PR; any ungrouped npm branch is a major bump and left for review)
#        - dependabot/github_actions/*                (CI-only; a bad bump fails
#          CI loudly rather than shipping broken production code)
set -euo pipefail

AUTHOR="${1:-}"
BRANCH="${2:-}"

case "$AUTHOR" in
  "dependabot[bot]" | "app/dependabot") ;;
  *)
    echo "skip"
    exit 0
    ;;
esac

case "$BRANCH" in
  dependabot/npm_and_yarn/minor-and-patch-*) echo "merge" ;;
  dependabot/github_actions/*) echo "merge" ;;
  *) echo "skip" ;;
esac
