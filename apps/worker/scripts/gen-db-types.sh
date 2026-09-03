#!/usr/bin/env bash
# Regenerate the typed Supabase client's Database types from the live schema.
# Run via: pnpm --filter worker db:types  (cwd = apps/worker)
# Requires Supabase auth: `supabase login` locally, or SUPABASE_ACCESS_TOKEN in CI.
#
# The committed src/types/database.ts MUST equal this script's output exactly.
# The nightly drift check (.github/workflows/db-types-drift.yml) regenerates and
# fails if `git diff` shows any change, which is what catches a migration that
# landed without a types regen.
set -euo pipefail

# Captured BEFORE anything can change directory, so the helper text is found
# relative to where this script LIVES rather than where it was invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPERS="$SCRIPT_DIR/db-types-helpers.ts.txt"

PROJECT_ID="${SUPABASE_PROJECT_ID:-xvrmivmpfykwwtriqwpg}"
OUT="src/types/database.ts"
RAW="$(mktemp)"
TMP="$(mktemp)"
trap 'rm -f "$RAW" "$TMP"' EXIT

if [ ! -s "$HELPERS" ]; then
  echo "gen-db-types: the frozen helper text is missing or empty at $HELPERS" >&2
  exit 1
fi

# Write to a temp file first, then move into place only on success. A failed
# `supabase gen types` (a transient 504, say) must not clobber the committed
# types with a partial or empty file.
#
# The hosted generator is non-deterministic about one boilerplate comment block
# (the "// Allows to automatically instantiate createClient ..." note above
# __InternalSupabase): consecutive runs sometimes include it, sometimes don't.
# Both this script and the nightly drift check run the SAME pipeline, so we
# strip those two lines here to keep the committed file and the regenerated one
# byte identical regardless of which variant the API returns.
#
# We also strip dated partition CHILD tables (execution_steps_2026_06_14,
# achieve_evaluations_2026_07, ...). Production auto-creates a new daily/monthly
# partition on a schedule, so leaving them in makes the nightly drift check fail
# roughly monthly with no real schema change (#322). The app only ever queries the
# PARENT table, never a child by name, so the child types are pure noise. The awk
# below drops any 6 space indented table block whose key matches <name>_YYYY_MM
# (optionally _DD), from its `{` through its matching 6 space `}`. Guarded by
# apps/web/src/lib/__guards__/worker/db-types-no-partitions.test.ts.
{
  printf '// GENERATED \xe2\x80\x94 do not edit by hand. Regenerate: pnpm --filter worker db:types\n'
  echo "// Supabase types for the typed client (lib/supabase.ts). ESLint-excluded."
  echo "// Drift from the live schema is checked nightly (.github/workflows/db-types-drift.yml)."
  echo ""
  supabase gen types typescript --project-id "$PROJECT_ID" \
    | grep -vF '// Allows to automatically instantiate createClient with right options' \
    | grep -vF "// instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)" \
    | awk '
        skip==0 && /^      [a-z_]+_[0-9][0-9][0-9][0-9]_[0-9][0-9](_[0-9][0-9])?: \{$/ { skip=1; next }
        skip==1 && /^      \}$/ { skip=0; next }
        skip==1 { next }
        { print }
      '
} > "$RAW"

# ---------------------------------------------------------------------------
# Freeze the boilerplate helper region (#1105).
#
# `supabase gen types --project-id` does NOT generate anything locally: it asks
# Supabase's Management API to produce the file. So the PINNED CLI VERSION CANNOT
# PIN THIS OUTPUT (LESSONS L552). On 2026-09-02 the hosted generator started
# wrapping a conditional type in parentheses in its helper types, and the pinned
# 2.107.0 emitted one format at 09:00 UTC and another at 12:22 the same day, on
# the identical commit. The drift check compares byte for byte, so it went red for
# three runs over two days on five added parentheses, alerting Slack each time
# about a migration that never happened.
#
# The region between `type DatabaseWithoutInternals` and `export const Constants`
# carries NO schema information: it is the same text for every Supabase project.
# So it is replaced with a copy this repo owns, and only the schema bearing parts
# (the `Database` type above it and the `Constants` block below it) still come
# from the generator. That keeps the check measuring the live schema while making
# it immune to this region being reformatted upstream.
#
# Substituting text found by matching is only safe if a MISS IS LOUD (L100), so
# each way this can fail to find what it expects gets its own message below. The
# one that matters most is a declaration the frozen copy does not have: without
# that check, a helper type ADDED upstream would be silently discarded.
# ---------------------------------------------------------------------------
START_RE='^type DatabaseWithoutInternals = '
END_RE='^export const Constants = '

start_count=$(grep -c "$START_RE" "$RAW" || true)
end_count=$(grep -c "$END_RE" "$RAW" || true)

if [ "$start_count" != "1" ]; then
  echo "gen-db-types: expected exactly one 'type DatabaseWithoutInternals' line to start the" >&2
  echo "  boilerplate region, found $start_count. The generator's output shape changed; review it" >&2
  echo "  and update this script and $HELPERS deliberately." >&2
  exit 1
fi

if [ "$end_count" != "1" ]; then
  echo "gen-db-types: expected exactly one 'export const Constants' line to end the boilerplate" >&2
  echo "  region, found $end_count. The generator's output shape changed; review it and update" >&2
  echo "  this script and $HELPERS deliberately." >&2
  exit 1
fi

start=$(grep -n "$START_RE" "$RAW" | head -1 | cut -d: -f1)
end=$(grep -n "$END_RE" "$RAW" | head -1 | cut -d: -f1)

if [ "$start" -ge "$end" ]; then
  echo "gen-db-types: the boilerplate region's end (line $end) is not after its start (line $start)." >&2
  echo "  The generator's output order changed; review it before regenerating." >&2
  exit 1
fi

# Compare which top level declarations the region holds against the frozen copy,
# rather than keeping a hand written list beside it that can drift (L41).
declaration_names() {
  grep -oE '^(export )?(type|const|interface) [A-Za-z_][A-Za-z0-9_]*' \
    | awk '{ print $NF }' \
    | sort -u
}

region_declarations=$(sed -n "${start},$((end - 1))p" "$RAW" | declaration_names || true)
frozen_declarations=$(declaration_names < "$HELPERS" || true)

if [ "$region_declarations" != "$frozen_declarations" ]; then
  echo "gen-db-types: the generator's boilerplate region no longer holds the same declarations as" >&2
  echo "  the frozen copy, so substituting it would silently change what the file exports." >&2
  echo "  generator: $(echo "$region_declarations" | tr '\n' ' ')" >&2
  echo "  frozen:    $(echo "$frozen_declarations" | tr '\n' ' ')" >&2
  echo "  Review the difference and update $HELPERS deliberately. It is NOT refreshed automatically." >&2
  exit 1
fi

{
  sed -n "1,$((start - 1))p" "$RAW"
  cat "$HELPERS"
  sed -n "${end},\$p" "$RAW"
} > "$TMP"

mv "$TMP" "$OUT"
echo "Wrote $OUT from project $PROJECT_ID"
