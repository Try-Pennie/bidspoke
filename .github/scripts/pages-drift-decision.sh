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
#   pages-drift-decision.sh <inflight_age_seconds|""|unavailable> [--last-success-age=<seconds|""|unavailable>] [<path>=<state> ...]
#
# `unavailable` means the in-flight query could not be answered at all, which is
# a different fact from an idle pipeline and gets its own outcome (#899).
#
# `--last-success-age` is how long ago the newest successful Pages upload
# finished, from deploy-last-success-age.sh, with the same three states (#901).
# It is a named option rather than a second positional age because two ages of
# the same type are transposable at the call site, and a reversed call would
# silently ask a different question (L455). While
# PAGES_PROPAGATION_GRACE_SECONDS is above zero, a route that is behind is
# excused if that age is at most the grace, as `deploy-propagating`.
#
#   state is one of:
#     current      the route served the latest apps/web commit
#     behind       the route served an older commit
#     unstamped    the route answered but carries no usable commit stamp
#     unknown      the route named a commit this repository does not have
#     unreachable  the route could not be fetched at all
#
# Prints exactly one word: `ok`, `deploy-in-flight`, `deploy-propagating`,
# `alert-behind`, `alert-stuck-deploy`, `alert-inflight-unknown`,
# `alert-propagation-unknown`, `alert-unstamped`, `alert-unknown-commit`,
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

# How long after a Pages upload a route may still serve the previous build
# before that counts as stranded (#901). ZERO UNTIL MEASURED: the deploy's
# propagation sampler (pages-propagation-sample.sh) logs per-route flip times on
# every Pages deploy, and the constant is set from several of those readings,
# never from one or from a guess (L656, L172). Zero is the OFF value (L72), so
# forgetting to set it leaves the check exactly as strict as it was. The issue
# that sets it from the samples is #1394. The in-flight ceiling above bounds it:
# a grace longer than a whole deploy is not a propagation window, and on an
# hourly cadence it would hide a stranded site for most of an hour.
PAGES_PROPAGATION_GRACE_SECONDS=${PAGES_PROPAGATION_GRACE_SECONDS:-0}

INFLIGHT_AGE="${1-}"
shift || true

# Distinct from an empty age on purpose (L168): an age nobody supplied must not
# be read as "no deploy to excuse" when a grace is in force.
LAST_SUCCESS_AGE=''
LAST_SUCCESS_SUPPLIED=no

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
    --last-success-age=*)
      LAST_SUCCESS_AGE="${OBSERVATION#--last-success-age=}"
      LAST_SUCCESS_SUPPLIED=yes
      continue ;;
    --*) decide alert-malformed "option '${OBSERVATION}' is not one this script takes" ;;
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

case "$PAGES_PROPAGATION_GRACE_SECONDS" in
  *[!0-9]*) decide alert-malformed "PAGES_PROPAGATION_GRACE_SECONDS '${PAGES_PROPAGATION_GRACE_SECONDS}' is not a whole number of seconds, so the check is misconfigured" ;;
esac
if [ "$PAGES_PROPAGATION_GRACE_SECONDS" -gt "$MAX_INFLIGHT_SECONDS" ]; then
  decide alert-malformed "PAGES_PROPAGATION_GRACE_SECONDS is ${PAGES_PROPAGATION_GRACE_SECONDS}s, above the ${MAX_INFLIGHT_SECONDS}s in-flight ceiling, so it is not a propagation window and the check is misconfigured"
fi

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

# Its own outcome, deliberately neither of its neighbours (#899). This is the
# state that caused the 2026-08-19 false page: the job asked whether a deploy was
# running, the call was refused for want of `actions: read`, the error went to
# /dev/null, and the empty answer arrived here as a definite "no deploy is
# running", which is the loud side. Reported as `deploy-in-flight` instead it
# would let a broken query silence this check forever (L98); reported as
# `alert-behind` it sends the reader to re-run a deploy that was never the
# problem (L11).
if [ "$INFLIGHT_AGE" = "unavailable" ]; then
  decide alert-inflight-unknown "these routes are behind and whether a deploy is running could not be determined, so a healthy mid-deploy state cannot be told from a stranded site (the job needs actions: read to ask): ${BEHIND}"
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

# The propagation grace (#901), consulted only once no deploy is in flight: a
# run still going is the earlier and stronger fact. Inert while the grace is 0,
# and then the age is not even looked at, so a broken query cannot page a check
# that would excuse nothing anyway.
if [ "$PAGES_PROPAGATION_GRACE_SECONDS" -gt 0 ]; then
  if [ "$LAST_SUCCESS_SUPPLIED" = no ]; then
    decide alert-propagation-unknown "these routes are behind, a ${PAGES_PROPAGATION_GRACE_SECONDS}s propagation grace is in force, and the age of the last Pages upload was not supplied, so a site still settling cannot be told from a stranded one: ${BEHIND}"
  fi
  # The #899 shape again: a failed query must be its own outcome, never read as
  # "no recent upload" (which pages) or as "recent upload" (which stays quiet).
  if [ "$LAST_SUCCESS_AGE" = "unavailable" ]; then
    decide alert-propagation-unknown "these routes are behind, a ${PAGES_PROPAGATION_GRACE_SECONDS}s propagation grace is in force, and whether a Pages upload finished recently could not be determined (read the deploy-last-success line), so a site still settling cannot be told from a stranded one: ${BEHIND}"
  fi
  if [ -n "$LAST_SUCCESS_AGE" ]; then
    case "$LAST_SUCCESS_AGE" in
      *[!0-9]*) decide alert-malformed "last Pages upload age '${LAST_SUCCESS_AGE}' is not a whole number of seconds, so it cannot be trusted to excuse these stale routes: ${BEHIND}" ;;
    esac
    if [ "$LAST_SUCCESS_AGE" -le "$PAGES_PROPAGATION_GRACE_SECONDS" ]; then
      decide deploy-propagating "the newest Pages upload finished ${LAST_SUCCESS_AGE}s ago, within the ${PAGES_PROPAGATION_GRACE_SECONDS}s propagation grace, so these routes are expected to be behind for now: ${BEHIND}"
    fi
    decide alert-behind "no deploy is running, the newest Pages upload finished ${LAST_SUCCESS_AGE}s ago, past the ${PAGES_PROPAGATION_GRACE_SECONDS}s propagation grace, and these routes are serving an older commit: ${BEHIND}"
  fi
  decide alert-behind "no deploy is running, no recent Pages upload succeeded that could still be propagating, and these routes are serving an older commit: ${BEHIND}"
fi

decide alert-behind "no deploy is running and these routes are serving an older commit: ${BEHIND}"
