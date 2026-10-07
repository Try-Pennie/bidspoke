#!/usr/bin/env bash
# Runs the outage drill (#1305): every money flow with the database up, then down
# in each outage shape, from the same warmed stored copies. The one home for how
# it is run, called by outage-drill.yml (pull requests) and outage-drill-weekly.yml
# (main, weekly). How to read it: apps/worker/money-gate/README.md, "The outage drill".
#
#   MONEY_GATE_OUT  where the report is written (default: the runner's temp dir)
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
OUT="${MONEY_GATE_OUT:-${RUNNER_TEMP:-$(mktemp -d)}/outage-drill.json}"
cd "$ROOT/apps/worker"
TZ=UTC LANG=en_US.UTF-8 MONEY_GATE_OUT="$OUT" pnpm exec vitest run --config vitest.outage-drill.config.mts
