#!/usr/bin/env bash
#
# Decide whether a migration diff moved schema DDL, and therefore needs
# apps/worker/src/types/database.ts regenerated (#614).
#
# Reads a unified diff of supabase/migrations/*.sql on stdin. Prints exactly one
# word to stdout: `regen-required` or `not-required`.
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

set -uo pipefail

DIFF=$(cat)

# Content lines only: strip the leading +/- but drop the +++/--- file headers.
CHANGED=$(printf '%s\n' "$DIFF" | grep -E '^[+-]' | grep -Ev '^(\+\+\+|---)' | sed -E 's/^[+-]//')

if [ -z "$CHANGED" ]; then
  printf 'not-required\n'
  exit 0
fi

# A column DEFAULT is not part of the generated types, so `ALTER COLUMN ... SET/DROP
# DEFAULT` must not demand a regen: there would be nothing to regenerate. Every
# other ALTER COLUMN (a type change, SET NOT NULL) still counts.
if printf '%s\n' "$CHANGED" \
     | grep -ivE 'alter[[:space:]]+column[[:space:]]+[^;]*(set|drop)[[:space:]]+default' \
     | grep -qiE 'create table|drop table|add column|drop column|alter column|rename column|create type|alter type|create view|drop view|create materialized view'; then
  printf 'regen-required\n'
else
  printf 'not-required\n'
fi
