#!/usr/bin/env bash
#
# Decide whether a pull request actually CLOSES the issues its title names.
#
# THE DEFECT, measured rather than assumed. This repo's title convention names
# the issue in parentheses:
#
#   Give the execution retention window one source of truth (#1017)
#
# 191 of 360 merged pull requests do that. A parenthesised mention closes
# NOTHING: GitHub acts only on a keyword such as `Closes #1017`. So the title
# reads as a link, the work ships, and the issue stays open forever. Measured
# across every merged pull request on 2026-09-03: zero open issues carry a
# closing keyword from a merged pull request, so the keyword never fails when it
# is present; 119 merged pull requests (34%) carry no keyword at all; and seven
# open issues are named in a merged pull request's title with no keyword
# anywhere. #986 and #1017 were two of those seven, both confirmed shipped and
# closed by hand that day.
#
# Usage:
#   issue-closure-decision.sh <pr_number> <pr_title>   # body on stdin
#
# Prints exactly one line to stdout: `ok`, or `missing:<comma list of issues>`.
# Reason to stderr. Always exits 0; the caller decides what that does to a build.
#
# THIS ONE BLOCKS, which is the OPPOSITE fail direction from
# `main-push-decision.sh` beside it, and the difference is deliberate. That guard
# makes an ACCUSATION about something already merged, so uncertainty must stay
# quiet (LESSONS L36). This one WITHHOLDS a merge while the author is still
# there, and the entire remedy is one line in the body.
#
# IT MAY ONLY REFUSE WHAT IS GENUINELY WRONG (LESSONS L54). Three consequences:
#
#   1. A title naming no issue is untouched. That is every Dependabot bump and
#      every chore, and they must never be blocked by this.
#   2. A bare verb is NOT a closure. Every title in this repo opens with one
#      ("Fix the three defects behind the finalize alert (#1111)"), so reading
#      `fix` loosely would make the guard permanently silent while still looking
#      active, which is the shape of a guard that can never fail (L1).
#   3. A reference is not always a closure. A phase issue, a partial fix or a
#      related note legitimately names an issue it does not finish, and that is
#      this repo's commonest shape. `Refs only: #875` marks that intent, and it
#      is honoured PER ISSUE rather than per pull request: an exemption that
#      waved through the whole pull request would let one line silence every
#      other issue in the title.
#
# The fail direction on unreadable input falls out of the design rather than
# being bolted on: no readable title means no candidate issues means nothing to
# demand. A blocker that fires on garbage blocks good work.
#
# Word boundaries are written as `(^|[^A-Za-z])` rather than `\b` on purpose.
# CI runs GNU grep and a developer machine runs BSD grep, which spell `\b`
# differently, and this script is driven by the same test suite in both places.

set -uo pipefail

PR_NUMBER="${1-}"
TITLE="${2-}"

# Read the body before any early exit, so stdin is always drained and a caller
# piping into this never sees a broken pipe.
BODY="$(cat 2>/dev/null || true)"

decide() {
  printf '%s\n' "$1"
  printf 'issue-closure-guard: %s (%s)\n' "$1" "$2" >&2
  exit 0
}

is_number() {
  case "${1-}" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# The reference forms GitHub itself honours, longest alternative first so a
# leftmost-longest match does not stop at the bare `#123` inside a URL.
REF='(https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/[0-9]+|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+|#[0-9]+)'
KEYWORD='(close[sd]?|fix(es|ed)?|resolve[sd]?)'

# Issue numbers named by a closing keyword, in either the title or the body.
closing_numbers() {
  printf '%s\n%s\n' "$TITLE" "$BODY" \
    | grep -oiE "(^|[^A-Za-z])${KEYWORD}[[:space:]]*:?[[:space:]]*${REF}" 2>/dev/null \
    | grep -oE '[0-9]+$' 2>/dev/null || true
}

# Issue numbers the author deliberately exempted with a `Refs only:` line.
exempt_numbers() {
  printf '%s\n' "$BODY" \
    | grep -oiE 'refs[ -]only[[:space:]]*:.*' 2>/dev/null \
    | grep -oE '#[0-9]+' 2>/dev/null | tr -d '#' || true
}

# Issue numbers the TITLE names inside parentheses, which is the convention this
# guard exists for. Deliberately not the whole title: a number written loose in
# the prose is not this repo's way of naming the issue a pull request is for.
title_numbers() {
  printf '%s\n' "$TITLE" \
    | grep -oE '\([^)]*\)' 2>/dev/null \
    | grep -oE '#[0-9]+' 2>/dev/null | tr -d '#' || true
}

if ! is_number "$PR_NUMBER"; then
  decide ok "the pull request number '${PR_NUMBER}' is not a number, so the caller's lookup failed rather than an issue being left open"
fi

CANDIDATES="$(title_numbers)"
if [ -z "$CANDIDATES" ]; then
  decide ok "the title names no issue in parentheses, so there is nothing this pull request claims to be for"
fi

COVERED="$(closing_numbers)"
EXEMPT="$(exempt_numbers)"

MISSING=''
for n in $CANDIDATES; do
  # The pull request's own number, which a squash merge appends to the title.
  [ "$n" = "$PR_NUMBER" ] && continue
  printf '%s\n' "$COVERED" | grep -qxF "$n" && continue
  printf '%s\n' "$EXEMPT" | grep -qxF "$n" && continue
  MISSING="${MISSING}${n}
"
done

MISSING="$(printf '%s' "$MISSING" | grep -E '^[0-9]+$' 2>/dev/null | sort -n -u | paste -sd, - || true)"

if [ -z "$MISSING" ]; then
  decide ok "every issue the title names is closed by a keyword or marked as a reference only"
fi

decide "missing:${MISSING}" "the title names ${MISSING} but no closing keyword covers them, so merging would ship the fix and leave the issue open"
