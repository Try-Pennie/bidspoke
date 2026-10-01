#!/usr/bin/env bash
#
# The money gate (#1704): runs the synthetic fixtures through the bidding engine at
# BASE and at the checked out commit (the head), then compares what each sent and
# decided. Fails on any difference, naming the fixture, the check, the node and the
# field, and fails if a workflow executed no node. Prints coverage either way.
#
# Usage (from the repository root, after `pnpm install`):
#   .github/scripts/money-gate.sh <base_commit_or_ref>
#
# ci.yml passes the pull request's base commit (the merge base is computed here);
# deploy.yml's verify-worker passes the commit main was at before the push.
#
# The harness, the fixtures and the stub rules always come from the head, so base
# and head are driven identically and differ only in the engine under test. The
# base is a detached worktree with its own install, because the engine's imports
# resolve from its own node_modules.
#
# Network is off inside the replay; nothing here reaches a partner, Salesforce,
# Supabase or Pipedream. Stale fixture shapes print a warning and never block.

set -euo pipefail

BASE="${1-}"
if [ -z "$BASE" ]; then
  echo "::error::money gate: no base commit was given, so there is nothing to compare the head with"
  exit 1
fi
# github.event.before is all zeros on the first push of a branch and after some
# forced pushes. There is no previous commit to compare with, so say so by name
# rather than failing inside git fetch with a message about something else.
if [[ "$BASE" =~ ^0+$ ]]; then
  echo "::error::money gate: the base commit is all zeros (a first push or a forced push), so there is no previous engine to compare with; run the gate by hand against the commit main was at, .github/scripts/money-gate.sh <commit>"
  exit 1
fi

ROOT="$(git rev-parse --show-toplevel)"
WORK="${RUNNER_TEMP:-$(mktemp -d)}/money-gate"
BASE_TREE="$WORK/base"
rm -rf "$WORK"
mkdir -p "$WORK"

if ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  git fetch --no-tags --depth=1 origin "$BASE"
fi

# The merge base of the pull request, so the comparison isolates what the pull
# request changes rather than what landed on main since it branched. A push to
# main passes the previous tip, which is its own merge base; with a shallow
# checkout git cannot compute one, and the given commit is then used as it is.
MERGE_BASE="$(git merge-base "$BASE" HEAD 2>/dev/null || true)"
if [ -z "$MERGE_BASE" ]; then
  MERGE_BASE="$(git rev-parse "${BASE}^{commit}")"
  echo "money gate: no merge base in this checkout's history, comparing with ${MERGE_BASE} as given"
fi
BASE="$MERGE_BASE"
git worktree add --detach "$BASE_TREE" "$BASE" >/dev/null
trap 'git -C "$ROOT" worktree remove --force "$BASE_TREE" >/dev/null 2>&1 || true' EXIT

echo "money gate: base $(git rev-parse --short "$BASE"), head $(git rev-parse --short HEAD)"
(cd "$BASE_TREE" && pnpm install --frozen-lockfile --ignore-scripts >/dev/null)

run_side() {
  local side="$1" root="$2"
  echo "money gate: replaying the fixtures through the $side engine"
  (cd "$ROOT/apps/worker" && TZ=UTC LANG=en_US.UTF-8 MONEY_GATE_SIDE="$side" MONEY_GATE_ENGINE_ROOT="$root" MONEY_GATE_OUT="$WORK/$side.json" \
    pnpm exec vitest run --config vitest.money-gate.config.mts)
}

run_side head "$ROOT"
run_side base "$BASE_TREE"

echo "money gate: comparing base with head"

# The merge base's expected-changes.json: an entry excuses a difference only when it
# is new at the head, so the verdict needs the base's copy. Git decides which case
# this is: the file at the base commit (its path in the base worktree), or git's
# word that the path does not exist there (the change that first adds it). A git
# error is neither, and stops here by name; the verdict also refuses an unreadable
# path rather than reading it as empty, which would let old entries excuse again.
EXPECTED_PATH="apps/worker/money-gate/expected-changes.json"
if ! listed="$(git ls-tree --name-only "$BASE" -- "$EXPECTED_PATH")"; then
  echo "::error::money gate: git could not list ${EXPECTED_PATH} at the merge base ${BASE}"
  exit 1
fi
if [ -n "$listed" ]; then
  EXPECTED_BASE="$BASE_TREE/$EXPECTED_PATH"
else
  EXPECTED_BASE="absent-at-base"
  echo "money gate: the merge base has no ${EXPECTED_PATH}, so every entry at the head is new"
fi

set +e
(cd "$ROOT/apps/worker" && MONEY_GATE_BASE="$WORK/base.json" MONEY_GATE_HEAD="$WORK/head.json" MONEY_GATE_VERDICT_OUT="$WORK/verdict.txt" \
  MONEY_GATE_EXPECTED_BASE="$EXPECTED_BASE" \
  pnpm exec vitest run --config vitest.money-gate-verdict.config.mts > "$WORK/verdict-run.log" 2>&1)
status=$?
set -e

if [ -s "$WORK/verdict.txt" ]; then
  cat "$WORK/verdict.txt"
else
  # The verdict never ran (a transcript missing or unreadable): show why.
  cat "$WORK/verdict-run.log"
  echo "::error::money gate: the verdict produced no report"
  exit 1
fi
if grep -q '^warning: the fixture shapes are' "$WORK/verdict.txt"; then
  echo "::warning::$(grep -m1 '^warning: the fixture shapes are' "$WORK/verdict.txt")"
fi
if [ "$status" -ne 0 ]; then
  # The first reason the verdict gave, of any kind, so the annotation names it.
  reason="$(grep -m1 -E '^money gate: ([0-9]+ difference\(s\) between|.*(executed no node|holds no|did not replay|matched no difference|expected-changes\.json (entry|does not|has no|was not|at )))' "$WORK/verdict.txt" || true)"
  echo "::error::${reason:-money gate: the verdict failed}"
fi
exit "$status"
