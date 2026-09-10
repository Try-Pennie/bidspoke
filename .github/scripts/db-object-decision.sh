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
#     expected_anon: 'denied' | 'allowed' | 'absent'
#
# Prints exactly one word: ok | missing | anon_can_execute | still_present |
# unreachable | probe_rejected. Always exits 0; the caller owns the verdict.
#
# `absent` is the inverse assertion, and it exists because a DROP needs a guard
# that outlives the migration that performed it (#1145). A scan of the migration
# text cannot see a function somebody recreates by hand in the database, and that
# is exactly how an ungated destructive routine comes back: under a name that
# reads like the right one, with no file anywhere recording it (L29, L346). Here
# the two answers simply swap, which is the whole reason this is cheap to add:
# PGRST202 becomes the pass, and any answer proving the object responded is the
# failure.
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
  # For an object that must be GONE, not finding it is the pass.
  if [ "$EXPECTED_ANON" = "absent" ]; then say ok; fi
  say missing
fi

case "$HTTP_CODE" in
  2*)
    # The function ran. Fine when anon is meant to reach it, a live grant hole
    # when it is not, and proof of survival for one that was supposed to be
    # dropped.
    if [ "$EXPECTED_ANON" = "absent" ]; then say still_present; fi
    if [ "$EXPECTED_ANON" = "allowed" ]; then say ok; fi
    say anon_can_execute
    ;;
esac

# A privilege error is the expected answer for a function anon must not reach: it
# proves the object EXISTS and that the grant is right, in one call.
if [ "$PG_CODE" = "42501" ]; then
  # A privilege error still PROVES the object is there, which for an entry that
  # must be absent is the failure rather than the reassurance it is elsewhere.
  # Both live answers collapse to one verdict deliberately: the consequence is
  # identical (somebody has to drop it), and two names for one consequence are
  # one outcome wearing two labels (L260). The row printed by the caller carries
  # the http and pg codes, so which of the two it was is not lost.
  if [ "$EXPECTED_ANON" = "absent" ]; then say still_present; fi
  if [ "$EXPECTED_ANON" = "denied" ]; then say ok; fi
  # Expected allowed but denied: the grant is missing, which breaks the caller.
  say probe_rejected
fi

# Anything else (a rejected apikey, an unrecognised error shape) means the probe
# never reached the question being asked.
say probe_rejected
