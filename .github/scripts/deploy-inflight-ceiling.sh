# shellcheck shell=bash
# shellcheck disable=SC2034  # every value set here is read by the scripts that source it
#
# When an in-flight Deploy counts as STUCK rather than merely slow (#790, #2409).
# Sourced by deploy-drift-decision.sh and pages-drift-decision.sh, so the
# ceilings and the code that applies them exist once (L370). Before #2409 each
# script carried its own `MAX_INFLIGHT_SECONDS=900`, kept equal by a comment.
#
# THE ANSWER IT JUDGES comes from deploy-inflight-age.sh, in one of four shapes:
#
#   (empty)                         no Deploy is queued or running on main
#   unavailable                     the query could not be answered
#   age=<s>,running=<s>             the oldest in-flight run was created <age>
#                                   seconds ago, and the in-flight run that has
#                                   held runners longest has held them <running>
#   age=<s>,running=unknown         the run list answered but a run's jobs could
#                                   not be read
#
# The first two are the callers' to handle, because each maps them to its own
# word. This file judges the last two. A bare number is also accepted, as an age
# with the running time unknown, which is exactly what the answer meant before
# #2409.
#
# WHY TWO NUMBERS. The 15:01:03 UTC Deploy Drift run on 2026-10-18 paged a stuck
# deploy at 1483s against a 900s ceiling while Deploy for 50841f3 (run
# 39136855091) was healthy and nearly done: created 14:37:47, finished green
# 15:06:21. Its jobs had held a runner for 753s of those 1483s, and for 779s of
# its whole 1714s. The rest was spent with jobs created and waiting for a
# runner, which Deploy for 49c3f3c and pull request CI were using (Deploy Ops
# Outbound waited 609s, Deploy Worker Tail 577s). Waiting for a runner is not being stuck, so the main ceiling is on
# RUNNING time, measured by deploy-running-seconds.jq.
#
# But a run whose jobs never get a runner at all would hold its running time
# still for ever, and "a deploy is running" would become a permanent excuse for
# silence (L98), on exactly the day the runners are the fault. So the age since
# it was created keeps a ceiling of its own, set well above the longest healthy
# deploy ever measured, which pages that case too.
#
# THE MEASUREMENT, 2026-10-18 16:02 UTC, by
# `bash .github/scripts/measure-deploy-durations.sh 120`: of the newest 120 Deploy
# runs, the 115 that completed successfully on main at their first attempt (all
# push runs, created 2026-10-15 14:39 to 2026-10-18 15:27 UTC), in seconds:
#
#                            min   p50   p90   p95   p99   max
#   running (union of jobs)  266   561   716   841   973  1073
#   age, created to done     274   618  1614  2028  3148  3448
#
# 26 of the 115 took longer than the old 900s ceiling from creation to finish,
# so it would have paged on almost a quarter of healthy deploys caught late in
# their run. Only 2 of them RAN longer than 900s. 2026-10-16 was the busy day:
# 3448s (b288fac) and 3148s (816400c) were merges minutes apart sharing
# runners. Running time never passed 1073s (5add6fc).
#
# THE CEILINGS, each about one and a half times the longest healthy reading:
#
#   MAX_INFLIGHT_RUNNING_SECONDS 1800  against a measured max of 1073s
#   MAX_INFLIGHT_AGE_SECONDS     5400  against a measured max of 3448s
#
# Re-measure with the command above when the deploy pipeline changes shape (a
# job added to the critical path, a runner change, a merge cadence change), and
# move these if the new longest healthy reading comes within a third of either
# (L316). Every Deploy job carries its own timeout-minutes, so a job that hangs
# while running is ended by GitHub within 15 minutes; what this ceiling exists
# to catch is the run that keeps going, or keeps waiting, past every healthy one.

MAX_INFLIGHT_RUNNING_SECONDS=1800
MAX_INFLIGHT_AGE_SECONDS=5400

# judge_inflight <answer>
#
# Sets INFLIGHT_JUDGEMENT to `in-flight`, `stuck` or `malformed`, and
# INFLIGHT_WHY to a sentence for the caller's reason line. Never called with an
# empty answer or `unavailable`.
#
# Anything this cannot read is `malformed`, which every caller maps to its loud
# side, so an unparsed value never compares false against a ceiling and buys
# silence (L50).
judge_inflight() {
  local answer="$1" age running
  case "$answer" in
    '' | *[!0-9]*)
      if [[ "$answer" =~ ^age=([0-9]+),running=([0-9]+|unknown)$ ]]; then
        age="${BASH_REMATCH[1]}"
        running="${BASH_REMATCH[2]}"
      else
        INFLIGHT_JUDGEMENT=malformed
        INFLIGHT_WHY="in-flight deploy answer '${answer}' is neither age=<seconds>,running=<seconds|unknown> nor a whole number of seconds"
        return 0
      fi ;;
    *)
      age="$answer"
      running=unknown ;;
  esac

  # The backstop first: past it nothing excuses the run, however little of its
  # life it has spent running.
  if [ "$age" -gt "$MAX_INFLIGHT_AGE_SECONDS" ]; then
    INFLIGHT_JUDGEMENT=stuck
    INFLIGHT_WHY="a deploy was created ${age}s ago and is still not finished, past the ${MAX_INFLIGHT_AGE_SECONDS}s ceiling on a deploy's whole life, so it is stuck (most likely waiting for a runner that never came) rather than merely slow"
    return 0
  fi

  if [ "$running" = unknown ]; then
    # The run's age is an upper bound on its running time, so judging the age
    # against the running ceiling can only err toward paging.
    if [ "$age" -gt "$MAX_INFLIGHT_RUNNING_SECONDS" ]; then
      INFLIGHT_JUDGEMENT=stuck
      INFLIGHT_WHY="a deploy has been in flight ${age}s and how long it has actually been running could not be read (see the deploy-inflight line), so its age stands in for it, which is past the ${MAX_INFLIGHT_RUNNING_SECONDS}s running ceiling"
      return 0
    fi
    INFLIGHT_JUDGEMENT=in-flight
    INFLIGHT_WHY="a deploy created ${age}s ago is still running, which is under the ${MAX_INFLIGHT_RUNNING_SECONDS}s running ceiling even counting all of it as running"
    return 0
  fi

  if [ "$running" -gt "$MAX_INFLIGHT_RUNNING_SECONDS" ]; then
    INFLIGHT_JUDGEMENT=stuck
    INFLIGHT_WHY="a deploy has been running for ${running}s (created ${age}s ago), past the ${MAX_INFLIGHT_RUNNING_SECONDS}s running ceiling, so it is stuck rather than merely slow"
    return 0
  fi

  INFLIGHT_JUDGEMENT=in-flight
  INFLIGHT_WHY="a deploy created ${age}s ago has been running for ${running}s of that, under the ${MAX_INFLIGHT_RUNNING_SECONDS}s running ceiling, and the rest of its life was spent waiting rather than running"
}
