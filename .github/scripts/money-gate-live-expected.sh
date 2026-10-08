#!/usr/bin/env bash
#
# The live worker's expected-changes.json, for the money gate's verdict (#1836).
# An entry the live worker already carries has shipped and can never excuse a
# difference again, so the verdict fails on it by name. Split out of
# money-gate.sh so each outcome is tested by running it (#1921).
#
# Usage: money-gate-live-expected.sh <work dir>, from the repository root.
#   env: MONEY_GATE_LIVE_WORKER_URL  the live worker; only the pull request job
#                                    sets it, so a Deploy never fails on this
#        CURL_BIN, JQ_BIN            test seams, default curl and jq
#
# Prints two lines and always exits 0, because nothing here may stop the gate:
#   1. the value for MONEY_GATE_EXPECTED_LIVE: empty when not asked, the path of a
#      copy written into the work dir, absent-at-live, or unreadable:<why>
#   2. the live commit, empty when there is none

set -uo pipefail

WORK="${1-}"
CURL_BIN="${CURL_BIN:-curl}"
JQ_BIN="${JQ_BIN:-jq}"
EXPECTED_PATH="apps/worker/money-gate/expected-changes.json"

EXPECTED_LIVE=""
LIVE_COMMIT=""
if [ -n "${MONEY_GATE_LIVE_WORKER_URL+set}" ]; then
  if [ -z "$MONEY_GATE_LIVE_WORKER_URL" ]; then
    EXPECTED_LIVE="unreadable:MONEY_GATE_LIVE_WORKER_URL is empty, so the live worker could not be asked"
  # Each way the answer can fail is named, so a runner problem is never blamed on the worker.
  elif ! command -v "$JQ_BIN" >/dev/null 2>&1; then
    EXPECTED_LIVE="unreadable:jq is not installed on this runner, so the live worker's answer could not be read"
  elif ! BODY=$("$CURL_BIN" -fsS --max-time 20 "${MONEY_GATE_LIVE_WORKER_URL}/" 2>/dev/null); then
    EXPECTED_LIVE="unreadable:the live worker at ${MONEY_GATE_LIVE_WORKER_URL} could not be reached"
  elif ! LIVE_COMMIT=$(printf '%s' "$BODY" | "$JQ_BIN" -r '.version // ""' 2>/dev/null); then
    EXPECTED_LIVE="unreadable:the live worker's answer is not JSON"
    LIVE_COMMIT=""
  else
    if ! [[ "$LIVE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
      # Line breaks folded to spaces, so the answer stays two lines.
      SHOWN=$(printf '%s' "$LIVE_COMMIT" | tr '\r\n' '  ' | cut -c1-80)
      EXPECTED_LIVE="unreadable:the live worker reported no commit (got '${SHOWN:-nothing}')"
      LIVE_COMMIT=""
    else
      git cat-file -e "${LIVE_COMMIT}^{commit}" 2>/dev/null || git fetch -q --depth=1 origin "$LIVE_COMMIT" >/dev/null 2>&1 || true
      if ! git cat-file -e "${LIVE_COMMIT}^{commit}" 2>/dev/null; then
        EXPECTED_LIVE="unreadable:the live worker's commit ${LIVE_COMMIT} could not be fetched"
      elif ! live_listed="$(git ls-tree --name-only "$LIVE_COMMIT" -- "$EXPECTED_PATH" 2>/dev/null)"; then
        EXPECTED_LIVE="unreadable:git could not list ${EXPECTED_PATH} at ${LIVE_COMMIT}"
      elif [ -z "$live_listed" ]; then
        EXPECTED_LIVE="absent-at-live"
      elif [ -n "$WORK" ] && git show "${LIVE_COMMIT}:${EXPECTED_PATH}" > "$WORK/expected-live.json" 2>/dev/null; then
        EXPECTED_LIVE="$WORK/expected-live.json"
      else
        EXPECTED_LIVE="unreadable:git could not read ${EXPECTED_PATH} at ${LIVE_COMMIT}"
      fi
    fi
  fi
fi

printf '%s\n%s\n' "$EXPECTED_LIVE" "$LIVE_COMMIT"
exit 0
