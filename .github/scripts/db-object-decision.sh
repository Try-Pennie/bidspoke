#!/usr/bin/env bash
#
# Judge one PostgREST probe of a required database object (#764).
#
# deploy.yml checks that migrations are APPLIED, never that the objects the
# shipping code depends on exist and carry the permissions it assumes. Those are
# different questions, and both near misses on 2026-08-13 were in the gap: a
# migration's comment asserted `anon` was excluded from a security-definer
# function while Postgres had granted EXECUTE to PUBLIC anyway, and only a live
# privilege query caught it (LESSONS L124).
#
# Usage:
#   db-object-decision.sh <http_code> <pg_error_code> <expected_anon>
#     expected_anon: 'denied' | 'allowed'
#
# Prints exactly one word: ok | missing | anon_can_execute | unreachable |
# probe_rejected. Always exits 0; the caller owns the verdict.
#
# The mapping was measured against production on 2026-08-14 rather than assumed:
#   exists, anon EXECUTE revoked -> HTTP 401, code 42501
#   not present, or wrong args   -> HTTP 404, code PGRST202
#   anon may execute it          -> HTTP 2xx
#
# `unreachable` is deliberately its OWN outcome rather than folded into ok or
# missing. Finding nothing must never read as success (LESSONS L98), and a 502
# from in front of PostgREST says nothing about whether a function exists, so
# reporting it as missing would be a message claiming more than it measured
# (LESSONS L11).

set -uo pipefail

HTTP_CODE="${1-}"
PG_CODE="${2-}"
EXPECTED_ANON="${3-}"

say() { printf '%s\n' "$1"; exit 0; }

# No status at all, or curl's own 000, means the request never completed.
if [ -z "$HTTP_CODE" ] || [ "$HTTP_CODE" = "000" ]; then
  say unreachable
fi

# Platform-level failures in front of PostgREST. Not evidence about the object.
case "$HTTP_CODE" in
  500|502|503|504) say unreachable ;;
esac

# PGRST202 is "could not find the function", which also fires when the ARGUMENT
# NAMES do not match an existing overload. Both are real problems for an app that
# calls it with exactly these arguments, so both are reported as missing. The
# manifest carries the argument shape the app sends, which is what keeps this from
# accusing working functions.
if [ "$PG_CODE" = "PGRST202" ]; then
  say missing
fi

case "$HTTP_CODE" in
  2*)
    # The function ran. Fine when anon is meant to reach it, a live grant hole
    # when it is not.
    if [ "$EXPECTED_ANON" = "allowed" ]; then say ok; fi
    say anon_can_execute
    ;;
esac

# A privilege error is the expected answer for a function anon must not reach: it
# proves the object EXISTS and that the grant is right, in one call.
if [ "$PG_CODE" = "42501" ]; then
  if [ "$EXPECTED_ANON" = "denied" ]; then say ok; fi
  # Expected allowed but denied: the grant is missing, which breaks the caller.
  say probe_rejected
fi

# Anything else (a rejected apikey, an unrecognised error shape) means the probe
# never reached the question being asked.
say probe_rejected
