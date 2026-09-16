#!/usr/bin/env bash
#
# Fetch Deploy Drift's targets, taking a second look before calling one
# unreachable (#1371).
#
# On 2026-09-16 at 21:01 UTC the site's /dev/nodes route and the cost tail
# worker failed to answer within the same second, outlasted curl's own retries,
# which sit a few seconds apart, and paged. Minutes later both answered and were
# running current code. Two unrelated services failing together is the network
# between the runner and Cloudflare, not a stranded deploy, and a page for it is
# the noise that teaches people to skip alerts (L36).
#
# So every target is fetched once, and if any failed, this waits ONCE for the
# whole set and fetches only the failures again. A target that answers the
# second time is `recovered`, kept distinct from `ok` so the blip still shows in
# the run log (L11); one that fails both looks is `unreachable`, and a real
# outage still pages within minutes rather than an hour later.
#
# Usage:
#   second-look-fetch.sh <outdir> <url> [<url> ...]
#
# Prints one line per URL, in order: `<n> ok|recovered|unreachable`, where n
# counts from 1. The body of each URL that answered is written to <outdir>/<n>.
# Exits 0 whenever it ran; the caller acts on the states. Exits 2 on a usage
# error, never printing nothing as though every target were fine (L98).
#
# Seams, so a test never reaches the network or sleeps for real (L524):
#   DRIFT_FETCH         command given the URL as its last argument
#   DRIFT_SLEEP         command given the number of seconds to wait
#   SECOND_LOOK_DELAY   seconds between the looks, default DEFAULT_DELAY

set -uo pipefail

DEFAULT_DELAY=120

if [ "$#" -lt 2 ]; then
  echo "usage: second-look-fetch.sh <outdir> <url> [<url> ...]: needs an output directory and at least one URL" >&2
  exit 2
fi

OUT_DIR=$1
shift
mkdir -p "$OUT_DIR"

DELAY=${SECOND_LOOK_DELAY:-$DEFAULT_DELAY}
# A delay that is not a whole number is not compared or passed to sleep, where it
# would either error or skip the wait and quietly restore the single look (L50).
if ! [[ "$DELAY" =~ ^[0-9]+$ ]]; then
  echo "second-look: SECOND_LOOK_DELAY='$DELAY' is not a whole number of seconds, using $DEFAULT_DELAY" >&2
  DELAY=$DEFAULT_DELAY
fi

fetch() {
  if [ -n "${DRIFT_FETCH:-}" ]; then
    # shellcheck disable=SC2086
    $DRIFT_FETCH "$1"
  else
    # --retry absorbs a dropped connection within a few seconds; the second look
    # below is for a blip that outlasts it.
    curl -fsS --max-time 20 --retry 2 --retry-delay 3 "$1" 2>/dev/null
  fi
}

URLS=("$@")
STATES=()
FAILED=0

for i in "${!URLS[@]}"; do
  n=$((i + 1))
  if fetch "${URLS[$i]}" > "$OUT_DIR/$n.tmp"; then
    mv "$OUT_DIR/$n.tmp" "$OUT_DIR/$n"
    STATES[$i]=ok
  else
    rm -f "$OUT_DIR/$n.tmp"
    STATES[$i]=failed
    FAILED=$((FAILED + 1))
  fi
done

if [ "$FAILED" -gt 0 ]; then
  echo "second-look: $FAILED target(s) did not answer, looking again in ${DELAY}s" >&2
  ${DRIFT_SLEEP:-sleep} "$DELAY"
  for i in "${!URLS[@]}"; do
    [ "${STATES[$i]}" = failed ] || continue
    n=$((i + 1))
    if fetch "${URLS[$i]}" > "$OUT_DIR/$n.tmp"; then
      mv "$OUT_DIR/$n.tmp" "$OUT_DIR/$n"
      STATES[$i]=recovered
      echo "second-look: ${URLS[$i]} did not answer, then answered ${DELAY}s later" >&2
    else
      rm -f "$OUT_DIR/$n.tmp"
      STATES[$i]=unreachable
      echo "second-look: ${URLS[$i]} did not answer on either look" >&2
    fi
  done
fi

for i in "${!URLS[@]}"; do
  echo "$((i + 1)) ${STATES[$i]}"
done
