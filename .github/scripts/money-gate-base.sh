#!/usr/bin/env bash
#
# The commit Deploy's money gate compares the engine against (#1761).
#
# Usage: money-gate-base.sh <event_name> <github.event.before> <money_gate_base input>
#   env: WORKER_URL (the live worker, read only on a dispatch with no input)
#        CURL_BIN   (test seam, default curl)
#
# Prints the base on stdout and exits 0, or prints an ::error:: naming the fix and
# exits 1. It never prints a guess.
#
#   push               github.event.before, passed through as it is. money-gate.sh
#                      already refuses an empty or all zeros value by name.
#   workflow_dispatch  the money_gate_base input when given (a commit hash). The
#                      Dependabot auto-merge passes the commit main was at before
#                      its merge, which is what a push would have carried.
#                      Otherwise the commit the LIVE worker reports at GET /, so
#                      the gate compares exactly the engine production runs and
#                      covers every commit that never had a deploy time gate.
#                      A worker that is down or unstamped gives no usable commit,
#                      and that is refused by name rather than compared with
#                      nothing; the fix is to start Deploy again with the input.
#   anything else      refused: no rule here says what its base would be.

set -uo pipefail

EVENT="${1-}"
BEFORE="${2-}"
INPUT_BASE="${3-}"
CURL_BIN="${CURL_BIN:-curl}"

refuse() {
  echo "::error::money gate base: $1" >&2
  exit 1
}

case "$EVENT" in
  push)
    printf '%s\n' "$BEFORE"
    exit 0 ;;
  workflow_dispatch) ;;
  *)
    refuse "a Deploy started by '${EVENT}' has no rule for what the money gate compares against, so it refuses rather than guess. Start Deploy on main from the Actions tab instead." ;;
esac

if [ -n "$INPUT_BASE" ]; then
  if [[ "$INPUT_BASE" =~ ^[0-9a-f]{7,40}$ ]]; then
    printf '%s\n' "$INPUT_BASE"
    echo "money gate base: the money_gate_base input, ${INPUT_BASE}" >&2
    exit 0
  fi
  refuse "the money_gate_base input '${INPUT_BASE}' is not a commit hash. Start Deploy on main again with money_gate_base set to a full commit hash, or left empty to use the commit the live worker reports."
fi

if [ -z "${WORKER_URL:-}" ]; then
  refuse "the NEXT_PUBLIC_WORKER_URL repository variable is empty, so the live worker's commit cannot be read. Start Deploy on main again with money_gate_base set to the commit to compare against."
fi

# Judged by the exit code and then by the shape of what came back (L184): a curl
# that failed, a body that is not JSON and a worker that reports `unknown` all
# leave LIVE short of a full hash, and each is refused the same way below.
LIVE=""
if BODY=$("$CURL_BIN" -fsS --max-time 20 "${WORKER_URL}/" 2>/dev/null); then
  LIVE=$(printf '%s' "$BODY" | jq -r '.version // ""' 2>/dev/null) || LIVE=""
fi

if [[ "$LIVE" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' "$LIVE"
  echo "money gate base: the commit the live worker reports, ${LIVE}" >&2
  exit 0
fi

refuse "the live worker reported no usable commit (got '${LIVE:-nothing}'), so there is no deployed engine to compare with. Start Deploy on main again with money_gate_base set to the commit to compare against."
