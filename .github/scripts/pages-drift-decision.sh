#!/usr/bin/env bash
#
# Decide whether the site half of Deploy Drift should page (#804).
#
# Deploy Drift has always watched the Worker only. Nothing watched Cloudflare
# Pages, so a failed or skipped Pages deploy left the site serving an older build
# with no signal at all, which is the same class of defect #327 filed for the
# Worker and #802 refined.
#
# The worker reports its commit at one endpoint, so one reading answers for the
# whole deploy. The site does not work that way: a Pages deploy propagates per
# route, and a prod scan has genuinely served the old bundle on some routes and
# the new one on others, which reads exactly like a missed fix. So the caller
# samples several routes, spanning both the prerendered static assets and the
# edge-rendered functions, and hands every reading to this script.
#
# Usage:
#   pages-drift-decision.sh <inflight_age_seconds|""> [<path>=<state> ...]
#
#   state is one of:
#     current      the route served the latest apps/web commit
#     behind       the route served an older commit
#     unstamped    the route answered but carries no usable commit stamp
#     unknown      the route named a commit this repository does not have
#     unreachable  the route could not be fetched at all
#
# Prints exactly one word: `ok`, `deploy-in-flight`, `alert-behind`,
# `alert-stuck-deploy`, `alert-unstamped`, `alert-unknown-commit`,
# `alert-unreachable`, `alert-no-samples`, or `alert-malformed`. The reason, naming the route
# responsible, goes to stderr. Always exits 0; the caller acts on the word.
#
# THE FAIL-SAFE DIRECTION IS AN ALERT, and each of the ways this can go wrong is
# its own outcome rather than a shared "something is wrong", because a site that
# cannot be reached, a build carrying no stamp, and a genuinely older commit need
# three different actions (LESSONS L11).
#
# Three specific guards:
#
#  - Sampling ZERO routes is loud, never a pass. A checker that found nothing to
#    check is indistinguishable from one that found everything healthy, and the
#    empty result arrives exactly when the sampling itself has broken (L98).
#  - An unreadable in-flight age is mapped to the loud side rather than compared
#    against the ceiling, where a non-numeric value would land on the permissive
#    side with no error raised (L50).
#  - A deploy STUCK in flight still pages, so "a deploy is running" cannot become
#    a permanent excuse for silence, which is how the worker's own version of
#    this check was nearly lost.
#
# An in-flight deploy excuses a route being BEHIND and nothing else. It does not
# explain a build with no stamp or a route that will not answer, so those are
# judged first.

set -uo pipefail

# A Pages deploy takes a few minutes. 15 gives generous headroom for a slow run
# while still catching one that has genuinely wedged. Matches the worker gate.
MAX_INFLIGHT_SECONDS=${MAX_INFLIGHT_SECONDS:-900}

INFLIGHT_AGE="${1-}"
shift || true

decide() {
  printf '%s\n' "$1"
  printf 'pages-drift-gate: %s (%s)\n' "$1" "$2" >&2
  exit 0
}

# Parse every observation before judging any of them, so a malformed one is
# reported as a broken caller rather than silently skipped. A state word this
# script does not recognise must not fall through every branch onto `ok`, which
# is what a typo in the caller would otherwise produce.
BEHIND=''
UNSTAMPED=''
UNKNOWN=''
UNREACHABLE=''
SAMPLES=0

for OBSERVATION in "$@"; do
  case "$OBSERVATION" in
    *=*) ;;
    *) decide alert-malformed "observation '${OBSERVATION}' is not <path>=<state>, so the sample cannot be read" ;;
  esac

  ROUTE="${OBSERVATION%%=*}"
  STATE="${OBSERVATION#*=}"
  SAMPLES=$((SAMPLES + 1))

  case "$STATE" in
    current) ;;
    behind) BEHIND="${BEHIND:+$BEHIND }$ROUTE" ;;
    unstamped) UNSTAMPED="${UNSTAMPED:+$UNSTAMPED }$ROUTE" ;;
    unknown) UNKNOWN="${UNKNOWN:+$UNKNOWN }$ROUTE" ;;
    unreachable) UNREACHABLE="${UNREACHABLE:+$UNREACHABLE }$ROUTE" ;;
    *) decide alert-malformed "route ${ROUTE} reported state '${STATE}', which is not one of current, behind, unstamped, unknown or unreachable" ;;
  esac
done

if [ "$SAMPLES" -eq 0 ]; then
  decide alert-no-samples "no routes were sampled at all, so this check measured nothing and cannot vouch for the site"
fi

# Judged ahead of anything else, including a stale route: with a route unstamped
# the sample is not measuring what it claims to, so "behind" is not the finding
# to report. This is also the signal that stamping itself has broken, which is
# precisely the condition that makes stranding undetectable.
if [ -n "$UNSTAMPED" ]; then
  decide alert-unstamped "these routes answered with no usable commit stamp, so the site cannot report what it is serving: ${UNSTAMPED}"
fi

# A commit the site names and this repository does not have is its own fault,
# reported separately from a missing stamp: the first means the deploy shipped
# something outside main's history, the second means stamping is broken. Folding
# them together would send the reader to check the wrong thing (L11).
if [ -n "$UNKNOWN" ]; then
  decide alert-unknown-commit "these routes named a commit that is not in this repository's history, so what is live cannot be placed against main: ${UNKNOWN}"
fi

if [ -n "$UNREACHABLE" ]; then
  decide alert-unreachable "these routes could not be fetched, so their state is unknown: ${UNREACHABLE}"
fi

# Before the in-flight branch on purpose. The next deploy starting does not make
# the current one unshipped, and judging in-flight first would make the check say
# less the healthier the site is.
if [ -z "$BEHIND" ]; then
  decide ok "every sampled route (${SAMPLES}) is serving the latest apps/web commit"
fi

if [ -n "$INFLIGHT_AGE" ]; then
  case "$INFLIGHT_AGE" in
    *[!0-9]*) decide alert-malformed "in-flight deploy age '${INFLIGHT_AGE}' is not a whole number of seconds, so it cannot be trusted to excuse these stale routes: ${BEHIND}" ;;
  esac

  if [ "$INFLIGHT_AGE" -gt "$MAX_INFLIGHT_SECONDS" ]; then
    decide alert-stuck-deploy "a deploy has been in flight ${INFLIGHT_AGE}s, past the ${MAX_INFLIGHT_SECONDS}s ceiling, so it is stuck rather than merely slow, and these routes are still stale: ${BEHIND}"
  fi

  decide deploy-in-flight "a deploy started ${INFLIGHT_AGE}s ago is still running, so these routes are expected to be behind for now: ${BEHIND}"
fi

decide alert-behind "no deploy is running and these routes are serving an older commit: ${BEHIND}"
