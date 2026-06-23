#!/usr/bin/env bash
# Regenerate the typed Supabase client's Database types from the live schema.
# Run via: pnpm --filter worker db:types  (cwd = apps/worker)
# Requires Supabase auth: `supabase login` locally, or SUPABASE_ACCESS_TOKEN in CI.
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
{
  echo "// GENERATED — do not edit by hand. Regenerate: pnpm --filter worker db:types"
  echo "// Supabase types for the typed client (lib/supabase.ts). ESLint-excluded."
  echo "// Drift from the live schema is checked nightly (.github/workflows/db-types-drift.yml)."
  echo ""
  supabase gen types typescript --project-id "$PROJECT_ID" \
    | grep -vF '// Allows to automatically instantiate createClient with right options' \
    | grep -vF "// instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)"
} > "$TMP"

mv "$TMP" "$OUT"
echo "Wrote $OUT from project $PROJECT_ID"
