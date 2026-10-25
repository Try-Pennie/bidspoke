#!/usr/bin/env bash
#
# Serve the built Pages artifact (apps/web/.vercel/output/static) for the browser
# checks, on a port nobody else holds, and hand its address to the later steps as
# BASE_URL (#2768). Run from apps/web. Usage: serve-pages-artifact.sh <log file>
#
# The accessibility and auth gate jobs both served on port 3000. On the Mac
# runners every job shares one machine, with each other, with Slate's jobs and
# with a developer's own dev server, so a fixed port collides, and a job whose
# server failed to start would find someone else's answering and test that. So
# the port is picked free, and the server counts as up only while the process
# this script started is still alive.
#
# The server is left running for the later steps; the runner stops it when the
# job ends.

set -uo pipefail

LOG="${1:?usage: serve-pages-artifact.sh <log file>}"
WRANGLER="${WRANGLER:-${GITHUB_WORKSPACE}/apps/worker/node_modules/.bin/wrangler}"
WAIT="${SERVE_WAIT_SECONDS:-60}"

# Port 0 asks the operating system for a free one. Listening on every address
# rather than 127.0.0.1 alone, so the port is free for IPv6 localhost too. It is
# released before wrangler binds it, and wrangler opens its own internal ports
# from the same pool first, so now and then the one picked is gone by then (CI on
# 2026-10-25): a start that fails with the address in use tries a fresh port, up
# to ATTEMPTS times. Any other failure is not retried.
ATTEMPTS=3
for attempt in $(seq 1 "$ATTEMPTS"); do
  PORT=$(node -e "const s = require('net').createServer(); s.listen(0, () => { console.log(s.address().port); s.close() })")
  if [ -z "$PORT" ]; then
    echo "::error::Could not find a free port for the Pages dev server."
    exit 1
  fi

  # workerd refuses a compatibility date it does not support yet, so it is pinned.
  "$WRANGLER" pages dev .vercel/output/static \
    --port "$PORT" \
    --compatibility-date=2026-04-06 \
    --compatibility-flags=nodejs_compat \
    > "$LOG" 2>&1 &
  PID=$!

  for i in $(seq 1 "$WAIT"); do
    if ! kill -0 "$PID" 2>/dev/null; then
      if grep -q "Address already in use" "$LOG" && [ "$attempt" -lt "$ATTEMPTS" ]; then
        echo "Port ${PORT} was in use by the time the server started, trying another."
        continue 2
      fi
      if grep -q "Address already in use" "$LOG"; then
        echo "::error::The Pages dev server could not start: ${ATTEMPTS} ports were each in use by the time it bound them."
      else
        echo "::error::The Pages dev server exited before it answered on port ${PORT}."
      fi
      cat "$LOG"
      exit 1
    fi
    if curl -sf -o /dev/null "http://localhost:${PORT}/login"; then
      echo "Pages dev server up on port ${PORT} after ${i}s."
      echo "BASE_URL=http://localhost:${PORT}" >> "$GITHUB_ENV"
      exit 0
    fi
    sleep 1
  done
  break
done
echo "::error::Pages dev server did not come up within ${WAIT}s."
kill "$PID" 2>/dev/null
cat "$LOG"
exit 1
