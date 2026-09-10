#!/usr/bin/env bash
#
# Assert the live database still carries the objects and grants the app needs (#764).
#
# deploy.yml checks that migrations are APPLIED, which is a different question
# from whether the specific objects the shipping code calls exist and have the
# permissions it assumes. Both near misses on 2026-08-13 were in that gap.
#
# Runs against the real database with nothing but the PUBLIC anon key, which is
# already a repo variable and is baked into the client bundle anyway. One POST per
# object answers both questions at once, because PostgREST distinguishes the
# failure modes (measured against prod 2026-08-14):
#
#   exists, anon EXECUTE revoked -> HTTP 401, code 42501
#   not present, or wrong args   -> HTTP 404, code PGRST202
#   anon may execute it          -> HTTP 2xx
#
# An entry may also expect `absent`, which asserts the object is NOT there. That
# is the guard a DROP needs in order to outlive the migration that performed it:
# a scan of migration text cannot see a routine recreated by hand in the database
# (#1145).
#
# Each object's ARGUMENT SHAPE comes from the manifest and matches what the app
# actually sends. That is not cosmetic: probed with an empty body,
# auth_user_with_allowlist returns PGRST202, which is indistinguishable from the
# function being absent, so a prober that sent `{}` would report most of the
# app's own RPCs as missing.
#
# KNOWN LIMITATION, measured on 2026-08-14 rather than assumed: PostgREST does
# not expose PROCEDUREs (prokind='p'), only functions. A throwaway function and a
# throwaway procedure were created with identical anon grants; the function
# answered HTTP 200 and the procedure answered 404 PGRST202. So a procedure cannot
# be probed here and must not be listed in the manifest, or it would report
# `missing` forever. That also means this check cannot see a procedure's grants at
# all, which is worth knowing before trusting it as complete coverage: it measures
# the REST-reachable surface, which is the attack surface, and nothing more.
#
# Env: SUPABASE_URL, SUPABASE_ANON_KEY
# Args: [path to manifest]  (default supabase/required-live-objects.json)

set -uo pipefail

MANIFEST="${1:-supabase/required-live-objects.json}"
: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY is required}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DECIDE="$HERE/db-object-decision.sh"

if [ ! -f "$MANIFEST" ]; then
  echo "::error::manifest not found: $MANIFEST"
  exit 1
fi

COUNT=$(jq 'length' "$MANIFEST" 2>/dev/null) || COUNT=""
# Zero objects checked must never read as a pass (LESSONS L98): an empty or
# mis-parsed manifest is exactly how this job would go green while asserting
# nothing at all.
#
# The count is validated as a POSITIVE INTEGER before it is compared, not just
# tested for emptiness (LESSONS L50). jq prints `null` for a manifest that parses
# but is not an array, and `[ "null" -lt 1 ]` is a bash arithmetic ERROR, not a
# false: with `set -uo pipefail` and no `-e` that error prints to stderr, the
# condition evaluates false, `seq 0 -1` yields nothing, the loop never runs, and
# the script reports success having checked nothing.
case "$COUNT" in
  ''|*[!0-9]*)
    echo "::error::could not read an object count from $MANIFEST (got '${COUNT:-empty}'). Refusing to report success on a manifest this script cannot parse."
    exit 1
    ;;
esac
if [ "$COUNT" -lt 1 ]; then
  echo "::error::manifest lists no objects, so this check asserted nothing. Refusing to report success."
  exit 1
fi

echo "Asserting $COUNT required database objects against $SUPABASE_URL"

FAILURES=0
UNREACHABLE=0

probe_once() {
  # $1 name, $2 args json. Echoes "<http_code> <pg_code>".
  local name="$1" args="$2" http pg
  http=$(curl -s -o /tmp/dbobj.json -w '%{http_code}' --max-time 20 \
    -X POST "$SUPABASE_URL/rest/v1/rpc/$name" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
    -H 'Content-Type: application/json' \
    -d "$args" 2>/dev/null) || http=""
  pg=$(jq -r '.code // ""' /tmp/dbobj.json 2>/dev/null) || pg=""
  echo "$http $pg"
}

for i in $(seq 0 $((COUNT - 1))); do
  NAME=$(jq -r ".[$i].name" "$MANIFEST")
  ARGS=$(jq -c ".[$i].args" "$MANIFEST")
  EXPECT=$(jq -r ".[$i].anon" "$MANIFEST")

  read -r HTTP PG <<<"$(probe_once "$NAME" "$ARGS")"
  VERDICT=$(bash "$DECIDE" "$HTTP" "$PG" "$EXPECT")

  # Retry only an unreachable probe, and only once: a network blip should not
  # page anyone, but a genuinely wrong grant must not be retried into looking OK.
  if [ "$VERDICT" = "unreachable" ]; then
    sleep 5
    read -r HTTP PG <<<"$(probe_once "$NAME" "$ARGS")"
    VERDICT=$(bash "$DECIDE" "$HTTP" "$PG" "$EXPECT")
  fi

  printf '%-42s expect_anon=%-8s http=%-4s pg=%-10s -> %s\n' "$NAME" "$EXPECT" "${HTTP:-none}" "${PG:-none}" "$VERDICT"

  case "$VERDICT" in
    ok) ;;
    missing)
      echo "::error::$NAME is not callable with the arguments the app sends. Either the object is absent from the live database or its signature changed, and any code path calling it is broken right now."
      FAILURES=$((FAILURES + 1))
      ;;
    anon_can_execute)
      echo "::error::$NAME is executable by anon over /rest/v1/rpc, which the manifest says it must not be. Postgres grants EXECUTE to PUBLIC on every new function, so the fix is an explicit REVOKE in a migration."
      FAILURES=$((FAILURES + 1))
      ;;
    still_present)
      echo "::error::$NAME answered a probe, and the manifest says it must not exist at all. It was dropped deliberately; something has recreated it. Check the manifest's note for why it was removed before restoring anything."
      FAILURES=$((FAILURES + 1))
      ;;
    probe_rejected)
      echo "::error::the probe of $NAME did not reach the question (http=$HTTP pg=$PG). Either the anon key is wrong or a grant the manifest expects is absent."
      FAILURES=$((FAILURES + 1))
      ;;
    unreachable)
      echo "::error::could not reach the database to check $NAME after a retry. This ran after the deploy, so an unreachable database is itself the alarm."
      UNREACHABLE=$((UNREACHABLE + 1))
      ;;
  esac
done

TOTAL=$((FAILURES + UNREACHABLE))
if [ "$TOTAL" -gt 0 ]; then
  echo "::error::$TOTAL of $COUNT required database objects did not check out."
  exit 1
fi

ABSENT=$(jq '[.[] | select(.anon == "absent")] | length' "$MANIFEST")
if [ "$ABSENT" -gt 0 ]; then
  echo "All $COUNT manifest entries check out: $((COUNT - ABSENT)) present with the expected grants, $ABSENT confirmed absent."
else
  echo "All $COUNT required database objects exist and carry the expected grants."
fi
