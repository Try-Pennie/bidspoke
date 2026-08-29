#!/usr/bin/env bash
#
# Decide whether a pull request touches anything that can move the Next.js
# artifact Cloudflare Pages serves (#968, #887).
#
# Two jobs build that artifact on every pull request: the accessibility scan and
# the auth gate probe. Each spends about 84 to 96 seconds building it, and both
# ran in full on pure backend pull requests where nothing that could reach it had
# changed.
#
# Usage:
#   web-code-changed.sh <pr_number> <lookup_ok> <changed_files>
#
# Prints exactly one word to stdout: `true` (do the work) or `false` (skip it).
# Reason to stderr. Always exits 0; the caller decides what to do with it.
#
# THE FAIL-SAFE DIRECTION IS `true`, and it is the opposite of this repo's
# main-push guard for a reason worth keeping straight. That guard makes an
# ACCUSATION, so uncertainty must stay quiet. This one withholds a GATE, so
# uncertainty must let the work happen. A gate that quietly switches itself off
# is the exact rot the accessibility job exists to prevent, and it would report
# green the whole time (L42, L72). Seven wasted minutes is cheap; a regression
# waved through by a detection bug is not.
#
# So the ONLY path to `false` is a lookup that clearly succeeded, returned a
# non-empty list, and contained nothing under the paths below. Every other
# outcome, including a query that failed and a query that answered nothing,
# runs the work: an empty answer from a failed lookup is not evidence of
# absence (L119).

set -uo pipefail

PR="${1-}"
LOOKUP_OK="${2-}"
FILES="${3-}"

decide() {
  printf '%s\n' "$1"
  printf 'web-code-changed: %s (%s)\n' "$1" "$2" >&2
  exit 0
}

if [ "$#" -lt 3 ]; then
  decide true "called with $# of 3 arguments, so nothing was actually checked"
fi

if [ -z "$PR" ]; then
  decide true "not a pull request, so there is no changed-file list to narrow by"
fi

if [ "$LOOKUP_OK" != "true" ]; then
  decide true "the changed-files lookup did not clearly succeed (got '${LOOKUP_OK}'), so 'nothing matched' cannot be told from 'nothing was read'"
fi

if [ -z "$FILES" ]; then
  decide true "the changed-files lookup returned an empty list, and a pull request always changes at least one file, so the query did not do what it claimed"
fi

# Anything that can reach the built artifact. Deliberately a SUPERSET of
# apps/web, matching the reasoning deploy.yml already documents for its own
# paths filter: a shared package is compiled into the site, and a dependency
# bump can move the middleware and the rendered CSS without a line of apps/web
# changing. Dependabot pull requests touch pnpm-lock.yaml, so they stay covered.
#
# Anchored at the start of the path and terminated by `/` or end of string, so a
# whole path SEGMENT has to match. `docs/apps/web-guide.md` and
# `apps/worker-tail/src/index.ts` both contain the characters "apps/web", and a
# substring match would run these jobs on documentation forever, while the same
# looseness in the other direction is how a filter starts matching things
# nobody meant (L104).
PATTERN='^(apps/web/|packages/|pnpm-lock\.yaml$|package\.json$)'

matched=$(printf '%s\n' "$FILES" | grep -E "$PATTERN" | head -n 5)

if [ -n "$matched" ]; then
  decide true "$(printf '%s' "$matched" | tr '\n' ' ')"
fi

decide false "no changed file is under apps/web/, packages/, or a manifest that can move the build"
