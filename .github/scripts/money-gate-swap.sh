#!/usr/bin/env bash
#
# The money gate's definition A/B mode (#2591, part of #934): instrument 2 of a
# lead validation swap. Replays one workflow's money gate fixtures through the
# head's engine twice, once with the committed definition and once with the
# candidate lead validation node swapped in, and compares what the two sent and
# decided with the gate's own comparator. Fails on any difference outside the
# replaced step's own record that the candidate does not accept in gate_accepted.
#
# Usage (from the repository root, after `pnpm install`):
#   .github/scripts/money-gate-swap.sh <candidate> [<check>:<lenient|strict>]
#
# <candidate> is a file name under apps/worker/money-gate/swap/candidates (with or
# without .json). The optional second argument seeds a defect in one check of the
# candidate, to see the mode name the difference (apps/worker/money-gate/swap/candidate.ts).
#
# Same engine on both sides, so no expected-changes.json entry is read or needed.
# Network is off inside the replay, as in the gate.

set -euo pipefail

CANDIDATE="${1-}"
SEED="${2-}"
if [ -z "$CANDIDATE" ]; then
  echo "::error::money gate swap: no candidate was named; pass a file name from apps/worker/money-gate/swap/candidates"
  exit 1
fi

ROOT="$(git rev-parse --show-toplevel)"
if [ ! -f "$ROOT/apps/worker/money-gate/swap/candidates/${CANDIDATE%.json}.json" ]; then
  echo "::error::money gate swap: there is no candidate ${CANDIDATE%.json}.json in apps/worker/money-gate/swap/candidates"
  exit 1
fi
WORK="${RUNNER_TEMP:-$(mktemp -d)}/money-gate-swap"
rm -rf "$WORK"
mkdir -p "$WORK"

run_side() {
  local side="$1" gate_side="$2" seed="$3"
  echo "money gate swap: replaying ${CANDIDATE} with the ${side} definition"
  (cd "$ROOT/apps/worker" && TZ=UTC LANG=en_US.UTF-8 MONEY_GATE_SIDE="$gate_side" MONEY_GATE_ENGINE_ROOT="$ROOT" MONEY_GATE_OUT="$WORK/$side.json" \
    MONEY_GATE_CANDIDATE="$CANDIDATE" MONEY_GATE_CANDIDATE_SIDE="$side" MONEY_GATE_CANDIDATE_SEED="$seed" \
    pnpm exec vitest run --config vitest.money-gate.config.mts)
}

run_side current base ""
run_side candidate head "$SEED"

echo "money gate swap: comparing the current definition with the candidate"
set +e
(cd "$ROOT/apps/worker" && MONEY_GATE_CURRENT="$WORK/current.json" MONEY_GATE_CANDIDATE_TRANSCRIPT="$WORK/candidate.json" \
  MONEY_GATE_CANDIDATE="$CANDIDATE" MONEY_GATE_CANDIDATE_SEED="$SEED" MONEY_GATE_VERDICT_OUT="$WORK/verdict.txt" \
  pnpm exec vitest run --config vitest.money-gate-swap.config.mts > "$WORK/verdict-run.log" 2>&1)
status=$?
set -e

if [ -s "$WORK/verdict.txt" ]; then
  cat "$WORK/verdict.txt"
else
  cat "$WORK/verdict-run.log"
  echo "::error::money gate swap: the verdict produced no report"
  exit 1
fi
exit "$status"
