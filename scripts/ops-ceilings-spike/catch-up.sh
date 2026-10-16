#!/usr/bin/env bash
# scripts/ops-ceilings-spike/catch-up.sh (#1946, Spike 0 S0.1b): run catch-up.sql
# in a throwaway local Postgres held to roughly the ops project's compute size.
#
# The container is Supabase's own Postgres image, the version the SQL suite uses,
# limited to 2 CPUs and 1 GB of memory, the published shape of the Micro compute
# the ops project runs on. It is a PROXY: a laptop core is not a shared cloud
# core, so its timings are a floor on what Micro takes, never a measurement of it.
# The row counts do not depend on the hardware and are exact for the inputs given.
# Stage 2 of the spike re-measures the timings on the real project
# (docs/ops-ceilings-spike.md).
#
# Nothing here can reach production: the only connection is docker exec into the
# container this script starts, which it removes afterwards.
#
# Usage: bash scripts/ops-ceilings-spike/catch-up.sh [psql -v overrides...]
#   e.g. bash scripts/ops-ceilings-spike/catch-up.sh -v outage_h=24 -v period_s=300
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="supabase/postgres:17.6.1.175"
CONTAINER="${SPIKE_CONTAINER:-bidspoke-ops-ceilings-spike}"
CPUS="${SPIKE_CPUS:-2}"
MEMORY="${SPIKE_MEMORY:-1g}"

if ! docker info >/dev/null 2>&1; then
  echo "CATCH-UP SPIKE DID NOT RUN: the Docker daemon is not running." >&2
  exit 2
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --cpus "$CPUS" --memory "$MEMORY" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null || exit 2
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT

tries=0
until docker exec "$CONTAINER" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 120 ]; then
    echo "CATCH-UP SPIKE DID NOT RUN: Postgres in $CONTAINER did not answer within 120 s." >&2
    exit 2
  fi
  sleep 1
done
# The image restarts once after its first boot; wait for the second readiness.
sleep 3
until docker exec "$CONTAINER" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; do sleep 1; done

echo "container $CONTAINER: image $IMAGE, --cpus $CPUS, --memory $MEMORY"
docker exec -i "$CONTAINER" psql -U postgres -h 127.0.0.1 -d postgres -X -q "$@" -f - < "$HERE/catch-up.sql"
