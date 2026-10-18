# How many seconds a Deploy run has spent RUNNING, as distinct from how long ago
# it was created (#2409). Input: the object GitHub returns for
# GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs.
#
# The answer is the length of the UNION of the intervals in which at least one
# of the run's jobs held a runner: a completed job from started_at to
# completed_at, a job still in progress from started_at to now. Time in which
# every job of the run was waiting (for a runner, or for a job it needs) counts
# for nothing, because waiting is not being stuck.
#
# Why this and not the run's own timestamps: of the 120 newest Deploy runs read
# on 2026-10-18, every first attempt reported startedAt equal to createdAt (the
# one exception was a re-run, whose startedAt is its second attempt's), so the
# run level fields cannot tell queued from running. The waiting is inside the
# run, between jobs. Deploy for 50841f3 (run 39136855091) was created 14:37:47
# and finished 15:06:21, 1714s, and its jobs held a runner for 779s of that: Deploy Ops Outbound waited 609s for a runner, Deploy Worker
# Tail 577s, while Deploy for 49c3f3c and pull request CI shared the same
# runners.
#
# A QUEUED job carries a started_at too, equal to its created_at, while it has
# no runner at all (read live from run 39141958054 at 15:53 UTC on 2026-10-18).
# So a job counts only once its status says it is running or finished, never on
# started_at alone, or every queued job would count as running from the moment
# it was created and the waiting this exists to exclude would come back in.
#
# A job's completed_at, when it has one, ends its interval even if its status
# still reads in_progress. GitHub returned exactly that for "Detect changed
# paths" in run 39080707265 (in_progress, conclusion success, completed_at
# 23:53:15) long after the run had finished, and ending that interval at now
# instead measured a 10 minute run as 16 hours of running.
#
# A skipped job reports completed_at a second BEFORE started_at, so only an
# interval with a positive length is kept.
#
# This one file is read by the drift check's in-flight query
# (deploy-inflight-age.sh) and by the measurement the ceiling is set from
# (measure-deploy-durations.sh), so the number judged is the number measured
# (L107).

# The callers read one page of 100 jobs (a Deploy run has 15). If GitHub says
# the run has more jobs than the page holds, the rest would be dropped and the
# running time undercounted, which is the direction that excuses a stuck deploy.
# So that answers the word `incomplete`, which every caller refuses as a number:
# the in-flight query reports running=unknown, the measurement stops.

def secs: fromdateiso8601;

if (.total_count // 0) > (.jobs | length) then "incomplete" else

[ .jobs[]
  | select(.started_at != null)
  | select(.status == "in_progress" or .status == "completed")
  | select(.conclusion != "skipped")
  | if .completed_at != null then [(.started_at | secs), (.completed_at | secs)]
    elif .status == "in_progress" then [(.started_at | secs), now]
    else empty end
  | select(.[1] > .[0]) ]
| sort_by(.[0])
| reduce .[] as $i ({total: 0, start: null, end: null};
    if .end == null then {total, start: $i[0], end: $i[1]}
    elif $i[0] > .end then {total: (.total + .end - .start), start: $i[0], end: $i[1]}
    else .end = ([.end, $i[1]] | max) end)
| (.total + (if .end == null then 0 else .end - .start end)) | floor

end
