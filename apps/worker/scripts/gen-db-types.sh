#!/usr/bin/env bash
# Regenerate the typed Supabase client's Database types from the live schema.
# Run via: pnpm --filter worker db:types  (cwd = apps/worker)
# Requires Supabase auth: `supabase login` locally, or SUPABASE_ACCESS_TOKEN in CI.
# Generate with the SAME Supabase CLI version pinned in the drift workflow
# (.github/workflows/db-types-drift.yml: supabase/setup-cli -> 2.107.0); a
# different CLI may format the output differently and trip a spurious drift.
# The committed src/types/database.ts MUST equal this script's output exactly —
# the nightly drift check (.github/workflows/db-types-drift.yml) regenerates and
# fails if `git diff` shows any change.
set -euo pipefail

PROJECT_ID="${SUPABASE_PROJECT_ID:-xvrmivmpfykwwtriqwpg}"
OUT="src/types/database.ts"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# Write to a temp file first, then move into place only on success — a failed
# `supabase gen types` (e.g. a transient 504) must not clobber the committed
# types with a partial/empty file.
#
# The hosted generator is non-deterministic about one boilerplate comment block
# (the "// Allows to automatically instantiate createClient ..." note above
# __InternalSupabase): consecutive runs sometimes include it, sometimes don't.
# Both this script and the nightly drift check run the SAME pipeline, so we
# strip those two lines here to keep the committed file and the regenerated one
# byte-identical regardless of which variant the API returns.
#
# We also strip dated partition CHILD tables (execution_steps_2026_06_14,
# achieve_evaluations_2026_07, ...). Production auto-creates a new daily/monthly
# partition on a schedule, so leaving them in makes the nightly drift check fail
# ~monthly with no real schema change (#322). The app only ever queries the
# PARENT table, never a child by name, so the child types are pure noise. The awk
# below drops any 6-space-indented table block whose key matches <name>_YYYY_MM
# (optionally _DD), from its `{` through its matching 6-space `}`. Guarded by
# apps/web/src/lib/__tests__/db-types-no-partitions.test.ts.
{
  echo "// GENERATED — do not edit by hand. Regenerate: pnpm --filter worker db:types"
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
} > "$TMP"

mv "$TMP" "$OUT"
echo "Wrote $OUT from project $PROJECT_ID"
