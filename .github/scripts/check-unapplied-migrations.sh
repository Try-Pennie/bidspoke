#!/usr/bin/env bash
#
# Refuses a deploy while a migration in the repository is not applied to its
# database (#1829). One script for both databases: the bidding one (Verify,
# deploy.yml) and the ops one (Deploy Ops Worker), so the two cannot drift.
#
# Usage: check-unapplied-migrations.sh <project-ref> <supabase-workdir>
#
# <supabase-workdir> is the directory holding `supabase/` (`.` for the bidding
# database, `supabase-ops` for the ops one), passed to the CLI as --workdir and
# read for the repository's migrations. Run from the repository root.
#
# Migrations are applied by hand (`supabase db push`), so this is the only thing
# that notices one merged but never applied. It counts a migration as applied
# only when `migration list --linked` shows a row whose Local and Remote columns
# both carry its version. Looking instead for the unapplied shape (a blank Remote
# column) would pass whenever the table could not be read at all, which is the
# check finding nothing because it measured nothing (L98, L156).
#
# Exits 0 when every repository migration is applied, 1 otherwise, naming each
# unapplied version and the command that applies it. SUPABASE_BIN overrides the
# CLI, for tests.

set -uo pipefail

REF="${1-}"
WORKDIR="${2-}"
SUPABASE="${SUPABASE_BIN:-supabase}"

if [ -z "$REF" ] || [ -z "$WORKDIR" ]; then
  echo "::error::usage: check-unapplied-migrations.sh <project-ref> <supabase-workdir>. An empty project ref usually means the repository variable is unset." >&2
  exit 1
fi

if [ "$WORKDIR" = "." ]; then
  PUSH="supabase db push"
else
  PUSH="supabase --workdir $WORKDIR db push --linked"
fi

MIGRATIONS="$WORKDIR/supabase/migrations"
LOCAL=$(ls "$MIGRATIONS" 2>/dev/null | sed -n -E 's/^([0-9]{14})_.*\.sql$/\1/p' | sort)
if [ -z "$LOCAL" ]; then
  echo "::error::Found no migrations in ${MIGRATIONS}, so there is nothing to compare. That is a wrong directory, not a clean database." >&2
  exit 1
fi

if ! LINK_OUT=$("$SUPABASE" --workdir "$WORKDIR" link --project-ref "$REF" 2>&1); then
  echo "$LINK_OUT"
  # A laptop `supabase link` or `db push` against the same project re-initialises
  # the shared cli_login_postgres role, and the loser of that race fails here
  # with an authentication error (#392). Re-running the deploy clears it.
  echo "::error::The migration check could not link to Supabase project ${REF}, so it cannot say whether every migration is applied. If the error above names cli_login_postgres, a local supabase link or db push raced this run: re-run the deploy." >&2
  exit 1
fi

if ! TABLE=$("$SUPABASE" --workdir "$WORKDIR" migration list --linked 2>&1); then
  echo "$TABLE"
  echo "::error::The migration check could not list the migrations of Supabase project ${REF}, so it cannot say whether every migration is applied. Re-run the deploy; if it fails again, run '${PUSH%% db push*} migration list --linked' locally." >&2
  exit 1
fi
echo "$TABLE"

MISSING=""
COUNT=0
for VERSION in $LOCAL; do
  COUNT=$((COUNT + 1))
  if ! echo "$TABLE" | grep -E "^[[:space:]]*${VERSION}[[:space:]]*\|[[:space:]]*${VERSION}[[:space:]]*\|" >/dev/null; then
    MISSING="${MISSING} ${VERSION}"
  fi
done

if [ -n "$MISSING" ]; then
  echo "::error::Unapplied migrations in ${MIGRATIONS}:${MISSING}. Run '${PUSH}', then re-run this deploy. Migrations must be backward-compatible (expand/contract) so apply order is safe, see docs/adr/0007-expand-contract-migrations.md." >&2
  exit 1
fi

echo "All ${COUNT} migration(s) in ${MIGRATIONS} are applied to ${REF}."
