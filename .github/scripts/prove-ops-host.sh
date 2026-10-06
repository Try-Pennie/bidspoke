#!/usr/bin/env bash
#
# Prove ops.trypennie.dev is served by the ops Worker (#1709 part 4).
#
# Usage: prove-ops-host.sh <capture url of a workflow that is not enrolled>
#
# One POST to an unknown workflow's capture address. The ops Worker answers it
# 404 unknown_workflow and stores nothing, and only after its lane check (LANE
# must be ops) and its master secret check (PORTING_CAPTURE_MASTER must be set),
# so that one answer, carrying the identity header the ops Worker puts on every
# response, proves all three. The bidding Worker's *.trypennie.dev route covers
# the same host, so a status alone proves nothing: the header is what names who
# answered.
#
# A new route can take a little while to reach every edge, so an answer without
# the header is asked again, up to PROVE_ATTEMPTS times, PROVE_WAIT seconds apart.
# Every other outcome, and running out of attempts, fails with an ::error:: line
# naming what was seen.
#
# Seams for tests: PROVE_PROBE replaces the request (it prints
# `<status>\t<identity header value>\t<body>`), PROVE_SLEEP replaces sleep.

set -uo pipefail

URL="${1-}"
HEADER=x-bidspoke-worker
ATTEMPTS="${PROVE_ATTEMPTS:-12}"
WAIT="${PROVE_WAIT:-10}"
SLEEP="${PROVE_SLEEP:-sleep}"

if [ -z "$URL" ]; then
  echo "usage: prove-ops-host.sh <capture url of a workflow that is not enrolled>" >&2
  exit 1
fi

probe() {
  if [ -n "${PROVE_PROBE:-}" ]; then
    "$PROVE_PROBE"
    return
  fi
  local headers body status
  headers=$(mktemp)
  body=$(mktemp)
  status=$(curl -sS --max-time 15 -X POST -H 'content-type: application/json' --data '{}' \
    -D "$headers" -o "$body" -w '%{http_code}' "$URL" 2>/dev/null || echo 000)
  local who
  who=$(grep -i "^${HEADER}:" "$headers" | head -n 1 | cut -d: -f2- | tr -d ' \r')
  printf '%s\t%s\t%s' "$status" "$who" "$(head -c 300 "$body" | tr -d '\n')"
  rm -f "$headers" "$body"
}

last=""
for attempt in $(seq 1 "$ATTEMPTS"); do
  answer=$(probe)
  status=$(printf '%s' "$answer" | cut -f1)
  who=$(printf '%s' "$answer" | cut -f2)
  body=$(printf '%s' "$answer" | cut -f3-)
  last="status ${status}, ${HEADER} '${who}', body ${body}"
  if [ "$who" = "ops" ]; then
    if [ "$status" = "404" ] && printf '%s' "$body" | grep -q '"unknown_workflow"'; then
      echo "prove-ops-host: the ops Worker answered ${URL} (attempt ${attempt}): lane ops, master secret set"
      exit 0
    fi
    # The ops Worker is answering but refusing: its config, not propagation.
    echo "::error::prove-ops-host: the ops Worker answered ${URL} but not as a healthy ops lane: ${last}" >&2
    exit 1
  fi
  [ "$attempt" -lt "$ATTEMPTS" ] && "$SLEEP" "$WAIT"
done

echo "::error::prove-ops-host: ${URL} was not answered by the ops Worker after ${ATTEMPTS} attempt(s); last answer: ${last}" >&2
exit 1
