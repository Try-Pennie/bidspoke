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

{
  echo "// GENERATED — do not edit by hand. Regenerate: pnpm --filter worker db:types"
  echo "// Supabase types for the typed client (lib/supabase.ts). ESLint-excluded."
  echo "// Drift from the live schema is checked nightly (.github/workflows/db-types-drift.yml)."
  echo ""
  supabase gen types typescript --project-id "$PROJECT_ID"
} > "$OUT"

echo "Wrote $OUT from project $PROJECT_ID"
