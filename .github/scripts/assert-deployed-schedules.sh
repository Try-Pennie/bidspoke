#!/usr/bin/env bash
# assert-deployed-schedules.sh <wrangler deploy log> <cron>...
#
# Fails unless the deploy's own output lists exactly these cron schedules (#1949).
# "The deploy succeeded" and "the cron exists" are different claims: a config
# that names no cron leaves the old one firing (spike #1946, 2026-10-16), and
# CI's Cloudflare token cannot read a Worker's schedules, but wrangler deploy
# prints each one it set, as `schedule: <cron>` under `Deployed <name> triggers`.
# Exact, both ways: a schedule missing never fires, and one left over fires into
# whatever the Worker now is.
set -uo pipefail

log="${1:-}"
shift || true
if [ -z "$log" ] || [ ! -f "$log" ]; then
  echo "assert-deployed-schedules: no deploy log at '${log}'" >&2
  exit 2
fi
if [ "$#" -eq 0 ]; then
  echo "assert-deployed-schedules: name at least one expected schedule" >&2
  exit 2
fi
if ! grep -Eq 'Deployed .* triggers' "$log"; then
  echo "DEPLOYED SCHEDULES UNPROVEN: the deploy output lists no triggers, so whether the cron was set is not known" >&2
  exit 1
fi

got="$(sed -nE 's/^[[:space:]]*schedule:[[:space:]]*(.*[^[:space:]])[[:space:]]*$/\1/p' "$log" | sort -u)"
want="$(printf '%s\n' "$@" | sort -u)"
if [ "$got" != "$want" ]; then
  echo "DEPLOYED SCHEDULES WRONG: expected [$(printf '%s' "$want" | paste -sd ';' -)] but the deploy set [$(printf '%s' "$got" | paste -sd ';' -)]" >&2
  exit 1
fi
echo "deployed schedules: $(printf '%s' "$got" | paste -sd ';' -)"
