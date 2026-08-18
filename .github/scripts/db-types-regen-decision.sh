#!/usr/bin/env bash
#
# Decide whether a migration diff moved schema DDL, and therefore needs
# apps/worker/src/types/database.ts regenerated (#614, #853).
#
# Reads a unified diff of supabase/migrations/*.sql on stdin. Prints exactly one
# word to stdout: `regen-required` or `not-required`. Reasons go to stderr.
#
# WHY THE DIFF AND NOT THE FILE. The previous version `cat`-ed every changed
# migration and grepped the WHOLE FILE for DDL keywords. That is a proxy for the
# question, not the question: it says "this file changed AND it contains a CREATE
# TABLE somewhere", which is true of a pure comment edit in any migration that ever
# created a table. The gate then demands a regen that has nothing to regenerate, so
# the change cannot be made green and the only exits are reverting it or overriding
# the gate. Correcting a wrong statement_timeout figure in the header comment of
# 20260515000001 hit exactly this, 100 lines above its CREATE TABLE.
#
# Only ADDED and REMOVED lines are read, which is the real question: did any DDL
# move. `+++`/`---` file headers are skipped, or a filename containing
# "create_table" would read as a DDL line.
#
# THE FAIL-SAFE DIRECTION IS `regen-required`. A missed regen drifts the typed
# client from the live schema silently; a needless one is a nuisance. So anything
# unreadable asks for the regen.
#
# NO `grep -q` AT THE END OF A PIPELINE HERE, EVER (#853). `grep -q` exits the
# instant it matches, so on a diff larger than the 64KB pipe buffer the upstream
# producer dies of SIGPIPE, `pipefail` promotes that to status 141, and the `if`
# reads a MATCH as no match. Measured: a 1.2MB diff whose first content line was
# `CREATE TABLE opportunities` answered `not-required`, in the fail-UNSAFE
# direction. Every match below is therefore captured into a variable and tested for
# emptiness, so the producer always runs to completion.

set -uo pipefail

# The committed types are the only available statement of the schema's previous
# shape (see the function rules below). Overridable so the tests can point at a
# fixture without rewriting the real file.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DB_TYPES_FILE="${DB_TYPES_FILE:-${HERE}/../../apps/worker/src/types/database.ts}"

DIFF=$(cat)

# Content lines only: strip the leading +/- but drop the +++/--- file headers.
CHANGED=$(printf '%s\n' "$DIFF" | grep -E '^[+-]' | grep -Ev '^(\+\+\+|---)' | sed -E 's/^[+-]//')

if [ -z "$CHANGED" ]; then
  printf 'not-required\n'
  exit 0
fi

decided() {
  printf '%s\n' "$1"
  exit 0
}

# ---------------------------------------------------------------------------
# 1. Keyword DDL. These move the generated types with no further reasoning.
# ---------------------------------------------------------------------------
#
# A column DEFAULT is not part of the generated types, so `ALTER COLUMN ... SET/DROP
# DEFAULT` must not demand a regen: there would be nothing to regenerate. Every
# other ALTER COLUMN (a type change, SET NOT NULL) still counts.
#
# `rename to` is scoped to ALTER TABLE on purpose. Bare `rename to` would also match
# `ALTER INDEX ... RENAME TO`, which the types do not carry, and a regen demanded
# for that has nothing to regenerate. `RENAME COLUMN x TO y` and `RENAME CONSTRAINT
# x TO y` do not match `rename[[:space:]]+to`; the column case is covered by the
# `rename column` keyword.
KEYWORD_HIT=$(printf '%s\n' "$CHANGED" \
  | grep -ivE 'alter[[:space:]]+column[[:space:]]+[^;]*(set|drop)[[:space:]]+default' \
  | grep -iE 'create table|drop table|add column|drop column|alter column|rename column|create type|alter type|create view|drop view|create materialized view|drop materialized view|alter[[:space:]]+table[[:space:]]+[^;]*rename[[:space:]]+to')

if [ -n "$KEYWORD_HIT" ]; then
  decided 'regen-required'
fi

# ---------------------------------------------------------------------------
# 2. Function DDL. This one cannot be answered from the migration text alone.
# ---------------------------------------------------------------------------
#
# `supabase gen types` emits a `Functions` block, so adding a function moves the
# generated types while matching none of the keywords above. #770 added
# `public.pg_cron_health`, this gate passed, and the nightly drift check failed the
# next morning with the committed types stale (#845).
#
# DO NOT just add `create function` to the list above. Every migration arrives as a
# NEW FILE, so git reports the whole thing as added lines, and a body-only
# `CREATE OR REPLACE FUNCTION` is therefore textually identical to a signature
# change. `public.reduce_finalize_stranded` has been replaced in FIVE migrations
# with a character-for-character identical declaration, so a keyword rule would
# demand a regen on all five, each producing no diff, each unmergeable. That is
# the #614 trap in a new shape.
#
# So the names the diff declares are compared against the names the committed types
# already record, which is the only available statement of the previous shape.
FUNCTION_EVENTS=$(printf '%s\n' "$CHANGED" \
  | sed -E 's/--.*$//' \
  | tr 'A-Z' 'a-z' \
  | awk '
      function bare(n) {
        gsub(/["'"'"';]/, "", n)
        sub(/\(.*/, "", n)
        sub(/^.*\./, "", n)
        return n
      }
      # NET EFFECT, NOT FIRST SIGHTING. One diff can both create and drop the same
      # function: cb66b3e added `reduce_finalize_stranded_executions` and dropped it
      # again across three migrations in a single commit. After that diff is applied
      # the function does not exist, so a regen would produce no diff and a gate
      # demanding one could never be satisfied. Keeping only the LAST event per name
      # answers that, and the reverse order (drop then create, which is how a
      # signature change is done properly) still reads as a create. Migration
      # filenames sort by timestamp and git orders a diff by path, so the order these
      # arrive in is the order Postgres will apply them in.
      function emit(k, n) { kind[n] = k }
      {
        line = $0

        if (match(line, /drop[ \t]+function([ \t]+if[ \t]+exists)?[ \t]+[^ \t(;]+/)) {
          seg = substr(line, RSTART, RLENGTH)
          sub(/^.*[ \t]/, "", seg)
          emit("drop", bare(seg))
        }

        if (match(line, /create[ \t]+(or[ \t]+replace[ \t]+)?function([ \t]|$)/)) {
          # A previous declaration whose RETURNS never showed up: emit it rather
          # than lose it. An unknown return type is treated as a real one, which
          # is the fail-safe direction.
          if (pending != "") emit("create", pending)
          rest = substr(line, RSTART + RLENGTH)
          name = rest
          sub(/^[ \t]+/, "", name)
          sub(/[ \t(;].*/, "", name)
          # A name on the following line leaves nothing to extract. Emit a token no
          # types file can contain, so the answer is regen-required rather than a
          # silently skipped function.
          pending = (name == "") ? "__name_not_on_the_create_line__" : bare(name)
          line = rest
        }

        if (pending != "") {
          # A trigger function is NEVER in the generated types: `supabase gen types`
          # omits them, which is why set_updated_at, handle_new_auth_user,
          # handle_auth_user_updated, folders_prevent_cycle and
          # env_var_folders_prevent_cycle are all absent from the Functions block
          # today. Reading that absence as "new" would demand a regen with nothing
          # to regenerate on every trigger migration: the #614 trap once more.
          if (match(line, /returns[ \t]+(setof[ \t]+)?(trigger|event_trigger)/)) {
            pending = ""
          } else if (match(line, /returns[ \t]/)) {
            emit("create", pending)
            pending = ""
          } else if (match(line, /\$\$|as[ \t]+\$/)) {
            emit("create", pending)
            pending = ""
          }
        }
      }
      END {
        if (pending != "") emit("create", pending)
        for (n in kind) print kind[n] " " n
      }
    ')

if [ -z "$FUNCTION_EVENTS" ]; then
  printf 'not-required\n'
  exit 0
fi

if [ ! -r "$DB_TYPES_FILE" ]; then
  echo "db-types-regen-decision: cannot read the generated types file ${DB_TYPES_FILE}, so the declared functions cannot be compared against what the types already record. Answering regen-required." >&2
  decided 'regen-required'
fi

# Direct children of a `Functions: {` block, matched by indent so the nested `Args`
# and `Returns` keys are not mistaken for function names. Exit 3 means the block
# itself was not found, which is a different failure from an unreadable file and
# gets its own message (LESSONS L11).
RECORDED=$(awk '
  state == 0 {
    if ($0 ~ /^[ \t]*Functions:[ \t]*\{[ \t]*$/) {
      n = match($0, /[^ \t]/)
      indent = substr($0, 1, n - 1)
      state = 1
      found = 1
    }
    next
  }
  $0 == indent "}" { state = 0; next }
  {
    if ($0 ~ /^[ \t]*[A-Za-z_][A-Za-z0-9_]*:[ \t]*\{/) {
      n = match($0, /[^ \t]/)
      if (substr($0, 1, n - 1) == indent "  ") {
        name = $0
        sub(/^[ \t]+/, "", name)
        sub(/:.*/, "", name)
        print tolower(name)
      }
    }
  }
  END { if (!found) exit 3 }
' "$DB_TYPES_FILE")

if [ $? -ne 0 ]; then
  echo "db-types-regen-decision: ${DB_TYPES_FILE} has no Functions block to compare the declared functions against. Answering regen-required." >&2
  decided 'regen-required'
fi

recorded_has() {
  case $'\n'"$RECORDED"$'\n' in
    *$'\n'"$1"$'\n'*) return 0 ;;
  esac
  return 1
}

# WHAT THIS DELIBERATELY DOES NOT CATCH (LESSONS L65, L93). A SAME-NAME signature
# change (a parameter added to an existing function, a changed return type) answers
# `not-required` here and drifts until the nightly db-types-drift check reports it
# the following morning. So does a non-trigger function created in a schema other
# than `public`, which the generated types never carry. Both residues are
# deliberate: the alternative is comparing parsed SQL signatures against parsed
# TypeScript shapes, which is brittle in both directions. Do not read a quiet
# answer here as proof there was nothing to find.
NEED_REGEN=''
while read -r kind name; do
  [ -z "${kind:-}" ] && continue
  case "$kind" in
    create) recorded_has "$name" || NEED_REGEN="new function ${name}" ;;
    drop)   recorded_has "$name" && NEED_REGEN="dropped function ${name} is still recorded in the types" ;;
  esac
done <<EOF
$FUNCTION_EVENTS
EOF

if [ -n "$NEED_REGEN" ]; then
  echo "db-types-regen-decision: ${NEED_REGEN}." >&2
  decided 'regen-required'
fi

printf 'not-required\n'
