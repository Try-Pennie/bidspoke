#!/usr/bin/env bash
#
# Deploy Drift's memory between runs: post a standing condition once, then remind
# on the worker's backoff schedule (#1761).
#
# Drift ran hourly with no state, so a strand that stood overnight on 2026-10-05
# posted three Slack messages every hour, each reading as a fresh discovery. This
# keeps one small JSON record per run, uploaded as an artifact at the end of each
# run and read back by the next, and backs off on the same 6h, 12h, then daily
# schedule as apps/worker/src/lib/alert-backoff.ts, from the same JSON file, with
# the same reminder sentence (both held equal by drift-alert-state.test.ts).
#
# The record lives on GitHub's side, never in the worker: drift exists partly to
# report a dead or unreachable worker, so it cannot need that worker to decide
# whether to speak (L71). A record that cannot be read fails toward speaking
# (L42), and the message then says so, so a repeat is explained (L11).
#
# Subcommands. All of them exit 0: a failure here must never be what ends the
# drift job before the next target is checked (#1373).
#
#   read      Fetch the newest earlier record. Prints `state`, `none` (GitHub
#             confirmed there is none) or `unavailable` (it could not find out),
#             three words because folding the last two together is the #899 bug.
#             env: GH_BIN, GITHUB_REPOSITORY, GITHUB_RUN_ID, DRIFT_SCHEDULE_SRC
#   alert <target> <kind> <facts> <text>
#             Decide, post to Slack when due, record only after Slack accepted it.
#             Prints post-first, post-reminder, held, post-failed or no-webhook.
#             env: SLACK_WEBHOOK_URL, DRIFT_NOW (epoch seconds, the clock seam,
#             L524), CURL_BIN
#   clear <target>
#             The target was measured healthy, so its next occurrence starts the
#             schedule again (alert-backoff's clearCondition).
#   finish    Write next.json for the upload, and print what this run's failures
#             were: clean, reported (every failed alert step posted or held a
#             FINDING about its target) or unreported. The schedule watch reads
#             that through the marker step, so a run that only found and reported
#             a strand is not reported a second time, while a drift check that is
#             itself broken still is (#1761 part 4).
#             env: WORKER, WORKER_PROBE, PAGES, TAIL (the alert steps' outcomes)
#   interval <n> | describe <since_iso> <alerts> <now_epoch>
#             intervalSecondsFor and describeRepeat, exposed for the parity test.
#
# Every subcommand shares DRIFT_STATE_DIR (default: a fresh temporary directory,
# which reads as an unreadable record and therefore speaks).
#
# A target with no call this run (in flight, propagating, skipped, or a step that
# never ran) carries its record forward unchanged: only a real healthy reading
# clears, and only a confirmed post advances the schedule.

set -uo pipefail

CMD="${1-}"
shift || true
DIR="${DRIFT_STATE_DIR:-$(mktemp -d)}"
SCHEDULE="${DRIFT_SCHEDULE:-$DIR/schedule.json}"
ARTIFACT_NAME="${DRIFT_STATE_ARTIFACT:-deploy-drift-alert-state}"
GH_BIN="${GH_BIN:-gh}"
CURL_BIN="${CURL_BIN:-curl}"
TARGETS="worker site tail"

mkdir -p "$DIR/next" "$DIR/run"

log() { printf 'drift-alert-state: %s\n' "$*" >&2; }

# The schedule's steps as a JSON array, or empty when it cannot be read. Shaped
# exactly as alert-backoff.ts reads it, and nothing else is accepted.
steps_json() {
  jq -ce '.stepsSeconds | select(type == "array" and length > 0 and all(.[]; type == "number" and . > 0))' \
    "$SCHEDULE" 2>/dev/null || true
}

# jq definitions mirroring alert-backoff.ts. Math.round(x) is floor(x + 0.5) for
# every x, which is how `round` is written here.
JQ_DEFS='
  def round: (. + 0.5) | floor;
  def interval($n): ($steps | length - 1) as $last
    | if ($n | type) != "number" or ($n | isinfinite) or ($n | isnan) then $steps[0]
      else $steps[([([($n | floor), 0] | max), $last] | min)] end;
  def describe($since; $alerts; $now):
    (try ($since | fromdateiso8601) catch null) as $s
    | (if $s == null then "This condition has been standing"
       else "This condition has been standing for ~\((($now - $s) / 3600) | round)h" end) as $age
    | "\($age) and nothing about it has changed: this is reminder \($alerts + 1). The next one is in ~\((interval($alerts) / 3600) | round)h unless it clears first, and it stops as soon as it does.";
'

# What a target's alert says about: the target itself (a finding), or the drift
# check being unable to measure it. An unknown kind is the second, so anything new
# keeps the schedule watch speaking until it is classified here on purpose.
classify() {
  case "$1:$2" in
    worker:alert | worker:alert-unreachable | worker:alert-unstamped) echo finding ;;
    site:alert-behind | site:alert-stuck-deploy | site:alert-unstamped | site:alert-unknown-commit | site:alert-unreachable) echo finding ;;
    tail:alert | tail:alert-unstamped | tail:alert-unreachable | tail:alert-unknown-commit) echo finding ;;
    *) echo check-broken ;;
  esac
}

prior_status() {
  local s
  s=$(tr -d '[:space:]' 2>/dev/null <"$DIR/prior-status") || s=""
  case "$s" in
    state | none) echo "$s" ;;
    *) echo unavailable ;;
  esac
}

cmd_read() {
  answer() {
    printf '%s\n' "$1" >"$DIR/prior-status"
    printf '%s\n' "$1"
    log "read: $1 ($2)"
    exit 0
  }
  if [ -n "${DRIFT_SCHEDULE_SRC:-}" ] && ! cp "$DRIFT_SCHEDULE_SRC" "$DIR/schedule.json" 2>/dev/null; then
    log "read: the backoff schedule at ${DRIFT_SCHEDULE_SRC} could not be copied, so every alert will post"
  fi
  local err list id zip why
  err=$(mktemp)
  # Judged by the exit code, with stderr kept to say why (L184, #899).
  if ! list=$("$GH_BIN" api "repos/${GITHUB_REPOSITORY:-}/actions/artifacts?name=${ARTIFACT_NAME}&per_page=30" 2>"$err"); then
    why=$(tr '\n' ' ' <"$err" | cut -c1-300)
    answer unavailable "listing the earlier records failed: ${why:-no error text}"
  fi
  # Filtered here, never by a second server side filter (L1014): not expired, from
  # a run on main, and not this run's own upload (a re-run attempt could see it).
  if ! id=$(jq -er --arg run "${GITHUB_RUN_ID:-}" '
      if (.artifacts | type) != "array" then error("no artifacts list") else
        [.artifacts[]
          | select(.expired == false and .workflow_run.head_branch == "main"
                   and ((.workflow_run.id | tostring) != $run))]
        | sort_by(.created_at) | (last.id // "") | tostring end' <<<"$list" 2>>"$err"); then
    answer unavailable "GitHub's list of earlier records was not the shape it sends"
  fi
  if [ -z "$id" ]; then
    answer none "GitHub has no earlier record from a run on main"
  fi
  zip=$(mktemp)
  if ! "$GH_BIN" api "repos/${GITHUB_REPOSITORY:-}/actions/artifacts/${id}/zip" >"$zip" 2>>"$err"; then
    why=$(tr '\n' ' ' <"$err" | cut -c1-300)
    answer unavailable "downloading record ${id} failed: ${why:-no error text}"
  fi
  if ! unzip -p "$zip" next.json >"$DIR/prior.json" 2>>"$err"; then
    answer unavailable "record ${id} could not be unpacked"
  fi
  if ! jq -e '.version == 1 and (.targets | type) == "object"' "$DIR/prior.json" >/dev/null 2>&1; then
    answer unavailable "record ${id} is not a version 1 record"
  fi
  answer state "record ${id}"
}

cmd_alert() {
  local target="${1-}" kind="${2-}" facts="${3-}" text="${4-}"
  local key="${target}|${kind}|${facts}"
  local class now now_iso status steps entry note decision body
  class=$(classify "$target" "$kind")
  now="${DRIFT_NOW:-$(date -u +%s)}"
  now_iso=$(jq -nr --argjson n "$now" '$n | todate')
  status=$(prior_status)
  steps=$(steps_json)

  entry=""
  if [ "$status" = "state" ]; then
    # A malformed entry is no entry, as readCondition treats one (alert-backoff.ts).
    entry=$(jq -ce --arg t "$target" '.targets[$t]
      | select(type == "object" and (.key | type) == "string" and (.since | type) == "string"
               and (.alerts | type) == "number" and .alerts >= 1 and (.last_alert | type) == "string")' \
      "$DIR/prior.json" 2>/dev/null) || entry=""
  fi

  note=""
  if [ "$status" = "unavailable" ]; then
    note="The record of earlier Deploy Drift alerts could not be read, so this may repeat an alert that was already sent."
  elif [ -z "$steps" ]; then
    note="The reminder schedule could not be read, so this posts on every run and may repeat an alert that was already sent."
  fi

  if [ -n "$note" ]; then
    decision=post-first
  else
    decision=$(jq -nr --argjson steps "$steps" --argjson entry "${entry:-null}" --arg key "$key" --argjson now "$now" "$JQ_DEFS"'
      if $entry == null or $entry.key != $key then "post-first"
      else (try ($entry.last_alert | fromdateiso8601) catch null) as $last
        | if $last == null then "post-reminder"
          elif ($now - $last) >= interval($entry.alerts - 1) then "post-reminder"
          else "held" end
      end')
  fi

  if [ "$decision" = "held" ]; then
    printf '%s\n' "$class" >"$DIR/run/$target"
    log "alert: $target held ($key), the next reminder is not due yet"
    echo held
    return
  fi

  body="$text"
  if [ "$decision" = "post-reminder" ]; then
    body="${body}"$'\n\n'"$(jq -nr --argjson steps "$steps" --argjson entry "$entry" --argjson now "$now" "$JQ_DEFS"'describe($entry.since; $entry.alerts; $now)')"
  fi
  if [ -n "$note" ]; then
    body="${body}"$'\n\n'"${note}"
  fi

  if [ -z "${SLACK_WEBHOOK_URL:-}" ]; then
    printf 'unreported\n' >"$DIR/run/$target"
    log "alert: $target NOT posted ($key): SLACK_WEBHOOK_URL is empty"
    echo no-webhook
    return
  fi

  if ! "$CURL_BIN" -fsS -X POST "$SLACK_WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      --data "$(jq -nc --arg text "$body" '{text: $text}')"; then
    # Nothing recorded: a post Slack refused must not buy hours of silence.
    printf 'unreported\n' >"$DIR/run/$target"
    echo "::warning::Deploy Drift could not post the $target alert to Slack; the next run will try again." >&2
    echo post-failed
    return
  fi

  jq -n --argjson entry "${entry:-null}" --arg key "$key" --arg now "$now_iso" --arg class "$class" \
    --arg decision "$decision" '{
      key: $key,
      since: (if $decision == "post-reminder" then $entry.since else $now end),
      alerts: (if $decision == "post-reminder" then $entry.alerts + 1 else 1 end),
      last_alert: $now,
      class: $class
    }' >"$DIR/next/$target.json"
  rm -f "$DIR/next/$target.cleared"
  printf '%s\n' "$class" >"$DIR/run/$target"
  log "alert: $target $decision ($key)"
  echo "$decision"
}

cmd_clear() {
  local target="${1-}"
  rm -f "$DIR/next/$target.json"
  : >"$DIR/next/$target.cleared"
  log "clear: $target measured healthy, its record is dropped"
}

cmd_finish() {
  local targets t failed report outcome
  targets='{}'
  if [ "$(prior_status)" = "state" ]; then
    targets=$(jq -c '.targets // {}' "$DIR/prior.json" 2>/dev/null) || targets='{}'
  fi
  for t in $TARGETS; do
    if [ -f "$DIR/next/$t.json" ]; then
      targets=$(jq -c --arg t "$t" --slurpfile e "$DIR/next/$t.json" '.[$t] = $e[0]' <<<"$targets")
    elif [ -f "$DIR/next/$t.cleared" ]; then
      targets=$(jq -c --arg t "$t" 'del(.[$t])' <<<"$targets")
    fi
  done
  jq -n --argjson targets "$targets" '{version: 1, targets: $targets}' >"$DIR/next.json"

  failed=""
  if [ "${WORKER:-}" = "failure" ] || [ "${WORKER_PROBE:-}" = "failure" ]; then failed="$failed worker"; fi
  if [ "${PAGES:-}" = "failure" ]; then failed="$failed site"; fi
  if [ "${TAIL:-}" = "failure" ]; then failed="$failed tail"; fi

  outcome=clean
  if [ -n "$failed" ]; then
    outcome=reported
    for t in $failed; do
      report=$(tr -d '[:space:]' 2>/dev/null <"$DIR/run/$t") || report=""
      if [ "$report" != "finding" ]; then
        outcome=unreported
        log "finish: $t failed and was ${report:-not reported at all}"
      fi
    done
  fi
  log "finish: failed targets:${failed:- none}, outcome $outcome"
  echo "$outcome"
}

case "$CMD" in
  read) cmd_read ;;
  alert) cmd_alert "$@" ;;
  clear) cmd_clear "$@" ;;
  finish) cmd_finish ;;
  interval)
    steps=$(steps_json)
    [ -n "$steps" ] || { log "interval: the schedule at $SCHEDULE could not be read"; exit 1; }
    jq -n --argjson steps "$steps" --argjson n "${1-0}" "$JQ_DEFS"'interval($n)' ;;
  describe)
    steps=$(steps_json)
    [ -n "$steps" ] || { log "describe: the schedule at $SCHEDULE could not be read"; exit 1; }
    jq -nr --argjson steps "$steps" --arg since "${1-}" --argjson alerts "${2-0}" --argjson now "${3-0}" \
      "$JQ_DEFS"'describe($since; $alerts; $now)' ;;
  *)
    log "unknown subcommand '${CMD}'"
    exit 0 ;;
esac
