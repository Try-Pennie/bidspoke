#!/usr/bin/env bash
# scripts/sql-suite/start-db.sh: start (or reset) the throwaway Postgres the SQL
# suite runs on (#1409, #1139).
#
# The image is Supabase's own Postgres build at the version production runs
# (17.6, measured 2026-09-21), so the roles, the auth schema, the preloaded
# pg_cron and pg_net, and the default privileges are the ones the migrations
# were written against. It listens only on localhost. Nothing here can reach
# production: SUPABASE_URL is never read and no network but the local Docker
# daemon is touched.
#
# Usage:
#   bash scripts/sql-suite/start-db.sh          # start if not running, keep its data
#   bash scripts/sql-suite/start-db.sh --reset  # remove the container and start empty
# Env: SQL_SUITE_PROJECT (main or ops, see project.sh), SQL_SUITE_CONTAINER and
# SQL_SUITE_PORT (each project's own by default).
set -uo pipefail

IMAGE="supabase/postgres:17.6.1.175"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=project.sh
. "$HERE/project.sh"

if ! docker info >/dev/null 2>&1; then
  echo "SQL SUITE DID NOT RUN: the Docker daemon is not running. Start Docker Desktop (open -a Docker) and retry." >&2
  exit 2
fi

if [ "${1:-}" = "--reset" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null
fi

tries=0
until docker exec "$CONTAINER" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 120 ]; then
    echo "SQL SUITE DID NOT RUN: Postgres in $CONTAINER did not answer within 120 s." >&2
    exit 2
  fi
  sleep 1
done
echo "postgres ready: container $CONTAINER, image $IMAGE, port $PORT"
