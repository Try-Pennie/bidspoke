#!/usr/bin/env bash
#
# Measure how long each site route takes to serve the commit just uploaded to
# Cloudflare Pages (#901).
#
# Deploy Drift excuses a route that is behind while the newest Pages upload is
# younger than a grace period. That grace has to be MEASURED across several real
# deploys, not written from one reading or a guess (LESSONS L656, L172), so the
# Deploy Pages job runs this right after uploading: it fetches the same routes
# the drift check samples, through the same commit stamp reader, and logs the
# seconds until each one first served the new commit.
#
# Usage:
#   pages-propagation-sample.sh <site_url> <expected_sha> <max_wait_seconds> <interval_seconds> [<route> ...]
#
# Prints one line per route:
#   pages-propagation: route=<r> result=flipped seconds=<n>
#   pages-propagation: route=<r> result=not-within seconds=<max> last=<sha7|unstamped|unreachable>
# and one summary line:
#   pages-propagation: summary routes=<n> flipped=<k>/<n> slowest_seconds=<n|none> max_wait=<n> interval=<n> sha=<sha7>
# The same lines go to $GITHUB_STEP_SUMMARY when it is set.
#
# `seconds` is the elapsed time at the LOOK that first saw the new commit, so it
# is an upper bound with a granularity of one interval. A route that never
# flipped within the wait is a censored reading and is reported as one rather
# than dropped (L540): a grace set only from the routes that happened to be quick
# would be too short.
#
# This is a measurement, never a gate. It always exits 0 (L632), it says so out
# loud when it measured nothing (L98), the clock and the sleep are injectable so
# tests set time instead of waiting on it (L290, L524), and the loop is bounded
# by a look count as well as by the clock, so a clock that does not advance
# cannot spin it for ever (L704).
#
# Seams: CURL_BIN, SLEEP_BIN, NOW_BIN (each defaults to the real tool).

set -uo pipefail

CURL_BIN="${CURL_BIN:-curl}"
SLEEP_BIN="${SLEEP_BIN:-sleep}"
NOW_BIN="${NOW_BIN:-date}"
HERE=$(cd "$(dirname "$0")" && pwd)
STAMP_READER="$HERE/pages-commit-from-html.sh"

SITE_URL="${1-}"
EXPECTED="${2-}"
MAX_WAIT="${3-}"
INTERVAL="${4-}"
shift 4 2>/dev/null || true
ROUTES=("$@")

say() {
  printf '%s\n' "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n\n' "$1" >>"$GITHUB_STEP_SUMMARY"; fi
}

now() { "$NOW_BIN" +%s; }

for NAME in SITE_URL EXPECTED MAX_WAIT INTERVAL; do
  if [ -z "${!NAME}" ]; then
    say "pages-propagation: ${NAME} was not given, so nothing was measured"
    exit 0
  fi
done
case "$MAX_WAIT$INTERVAL" in
  *[!0-9]*)
    say "pages-propagation: max_wait '${MAX_WAIT}' and interval '${INTERVAL}' must be whole seconds, so nothing was measured"
    exit 0 ;;
esac
if [ "$INTERVAL" -lt 1 ]; then INTERVAL=1; fi

if [ "${#ROUTES[@]}" -eq 0 ]; then
  say "pages-propagation: no routes were given, so nothing was measured"
  exit 0
fi

# The same fetch shape as second-look-fetch.sh, so what is measured is what the
# drift check will see (L472). No cache busting for the same reason.
fetch() {
  "$CURL_BIN" -fsS --max-time 20 --retry 2 --retry-delay 3 "$1" 2>/dev/null
}

T0=$(now)
MAX_LOOKS=$((MAX_WAIT / INTERVAL + 1))
LOOK=0
# Indexed arrays, one slot per route, because the macOS bash the tests run
# under is 3.2 and has no associative arrays. An empty FLIPPED slot means the
# route has not flipped yet.
N=${#ROUTES[@]}
FLIPPED=()
LAST=()
I=0
while [ "$I" -lt "$N" ]; do FLIPPED[$I]=''; LAST[$I]=unmeasured; I=$((I + 1)); done

while :; do
  LOOK=$((LOOK + 1))
  ELAPSED=$(( $(now) - T0 ))
  PENDING=0
  I=0
  while [ "$I" -lt "$N" ]; do
    if [ -z "${FLIPPED[$I]}" ]; then
      ROUTE=${ROUTES[$I]}
      if BODY=$(fetch "${SITE_URL}${ROUTE}"); then
        SERVED=$(printf '%s' "$BODY" | bash "$STAMP_READER")
        if [ "$SERVED" = "$EXPECTED" ]; then
          FLIPPED[$I]=$ELAPSED
        else
          if [ "$SERVED" = "unstamped" ]; then LAST[$I]=unstamped; else LAST[$I]="${SERVED:0:7}"; fi
          PENDING=$((PENDING + 1))
        fi
      else
        LAST[$I]=unreachable
        PENDING=$((PENDING + 1))
      fi
    fi
    I=$((I + 1))
  done

  [ "$PENDING" -eq 0 ] && break
  [ "$ELAPSED" -ge "$MAX_WAIT" ] && break
  [ "$LOOK" -ge "$MAX_LOOKS" ] && break
  "$SLEEP_BIN" "$INTERVAL"
done

SLOWEST=none
COUNT=0
I=0
while [ "$I" -lt "$N" ]; do
  ROUTE=${ROUTES[$I]}
  if [ -n "${FLIPPED[$I]}" ]; then
    COUNT=$((COUNT + 1))
    S=${FLIPPED[$I]}
    say "pages-propagation: route=${ROUTE} result=flipped seconds=${S}"
    if [ "$SLOWEST" = none ] || [ "$S" -gt "$SLOWEST" ]; then SLOWEST=$S; fi
  else
    say "pages-propagation: route=${ROUTE} result=not-within seconds=${MAX_WAIT} last=${LAST[$I]}"
  fi
  I=$((I + 1))
done

say "pages-propagation: summary routes=${#ROUTES[@]} flipped=${COUNT}/${#ROUTES[@]} slowest_seconds=${SLOWEST} max_wait=${MAX_WAIT} interval=${INTERVAL} sha=${EXPECTED:0:7}"
exit 0
