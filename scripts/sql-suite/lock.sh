#!/usr/bin/env bash
# scripts/sql-suite/lock.sh: one SQL suite run at a time per container (#3012).
# Sourced by run.sh, start-db.sh and replay.sh after project.sh, which sets
# CONTAINER and SQL_SUITE_PROJECT.
#
# Each project has ONE container on this Mac (bidspoke-sql-suite on 54329,
# bidspoke-sql-suite-ops on 54330), shared by every worktree and every session.
# Two runs at once replay into, reset and test one database together, and fail
# each other with errors that name a test rather than the other run (2026-10-29:
# run_engine_concurrency, then ops_tick). So a run holds this lock for its whole
# length, and a second run waits for it, up to SQL_SUITE_LOCK_WAIT seconds
# (default 600), then refuses by naming the holder: its pid, when it started,
# and its worktree.
#
# A lock rather than a container per worktree: each container replays every
# migration from empty on first use (about two minutes), keeps a Postgres in
# memory while it lives, needs a port nothing else holds, and outlives its
# worktree because nothing removes a worktree's container when the worktree goes.
# One warm container per project, taken in turn, costs a wait only when two
# pushes really do coincide.
#
# The lock is a directory, because mkdir either creates it or fails, atomically,
# with no flock (macOS has none). Inside it, `holder` records the pid of the run
# and that process's start time. A lock is stale, and is taken over rather than
# waited on, when that pid is not running or is running as a different process
# (a reused pid has another start time), so a run killed with no chance to clean
# up (kill -9, a closed terminal) blocks nobody. A directory with no holder file
# is a run between its mkdir and its write, and is waited on until it is
# SQL_SUITE_LOCK_EMPTY_GRACE seconds old (default 30). Taking over goes through
# a second directory, `<lock>.takeover`, so two waiters that both judged one lock
# stale cannot each remove it, the second removing the lock the first just took.
#
# A script the holder runs (run.sh starting start-db.sh and replay.sh) shares the
# holder's lock through SQL_SUITE_LOCK_HELD, rather than waiting on its own
# parent. Run by hand, start-db.sh and replay.sh take the lock themselves, so a
# `start-db.sh --reset` cannot remove the container under a running suite.
#
# Env: SQL_SUITE_LOCK_DIR (default /tmp/bidspoke-sql-suite-locks, the same for
# every worktree and session on the machine, as the containers are),
# SQL_SUITE_LOCK_WAIT, SQL_SUITE_LOCK_POLL (seconds between looks, default 2),
# SQL_SUITE_LOCK_EMPTY_GRACE.

SUITE_LOCK_ROOT="${SQL_SUITE_LOCK_DIR:-/tmp/bidspoke-sql-suite-locks}"
SUITE_LOCK="$SUITE_LOCK_ROOT/$CONTAINER.lock"
SUITE_LOCK_WAIT="${SQL_SUITE_LOCK_WAIT:-600}"
SUITE_LOCK_POLL="${SQL_SUITE_LOCK_POLL:-2}"
SUITE_LOCK_EMPTY_GRACE="${SQL_SUITE_LOCK_EMPTY_GRACE:-30}"
SUITE_LOCK_HEARTBEAT=30
_SUITE_LOCK_OWNED=0

# The start time of a running process, or nothing when it is not running.
_suite_lock_pid_start() {
  ps -o lstart= -p "$1" 2>/dev/null | sed -E 's/^ +//; s/ +$//'
}

# One field of a holder file (default: the current lock's).
_suite_lock_field() {
  sed -n "s/^$1=//p" "${2:-$SUITE_LOCK/holder}" 2>/dev/null | head -1
}

# Seconds since a path was last modified, or nothing when it cannot be read.
# stat -c is GNU (CI) and fails on macOS, whose stat -f %m is tried second; the
# other order is wrong, since GNU stat -f succeeds with a different meaning.
_suite_lock_age() {
  local mtime
  mtime="$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null)" || return 0
  [ -n "$mtime" ] && echo $(( $(date +%s) - mtime ))
}

# Prints held, gone, or stale:<why> for the lock directory as it stands.
_suite_lock_state() {
  [ -d "$SUITE_LOCK" ] || { echo gone; return; }
  local pid recorded actual age
  pid="$(_suite_lock_field pid)"
  if [ -z "$pid" ]; then
    age="$(_suite_lock_age "$SUITE_LOCK")"
    if [ -z "$age" ]; then echo gone; return; fi
    if [ "$age" -ge "$SUITE_LOCK_EMPTY_GRACE" ]; then
      echo "stale:it records no holder and is ${age}s old"
    else
      echo held
    fi
    return
  fi
  recorded="$(_suite_lock_field pid_start)"
  actual="$(_suite_lock_pid_start "$pid")"
  if [ -z "$actual" ]; then
    echo "stale:its holder, pid $pid, is no longer running"
  elif [ "$actual" != "$recorded" ]; then
    echo "stale:pid $pid is now a different process (started $actual, not $recorded)"
  else
    echo held
  fi
}

# Removes the lock when it is still stale, inside the takeover section. The
# section's own directory is cleared when it is a minute old: only a run killed
# inside these few lines leaves one behind.
_suite_lock_take_over() {
  local guard="$SUITE_LOCK.takeover" age state
  if ! mkdir "$guard" 2>/dev/null; then
    age="$(_suite_lock_age "$guard")"
    if [ -n "$age" ] && [ "$age" -ge 60 ]; then rm -rf "$guard"; else sleep "$SUITE_LOCK_POLL"; fi
    return 0
  fi
  state="$(_suite_lock_state)"
  case "$state" in
    stale:*)
      echo "taking over the SQL suite lock for $CONTAINER: ${state#stale:}" >&2
      rm -rf "$SUITE_LOCK"
      ;;
  esac
  rmdir "$guard" 2>/dev/null
  return 0
}

_suite_lock_describe() {
  local pid started worktree
  pid="$(_suite_lock_field pid)"
  started="$(_suite_lock_field started)"
  worktree="$(_suite_lock_field worktree)"
  if [ -z "$pid" ]; then
    echo "a run that has not yet recorded itself"
  else
    echo "pid $pid, started ${started:-at an unrecorded time}, in ${worktree:-an unrecorded worktree}"
  fi
}

suite_lock_release() {
  [ "$_SUITE_LOCK_OWNED" = 1 ] || return 0
  _SUITE_LOCK_OWNED=0
  # Only our own lock: one taken over from us (it should never be, while we run)
  # belongs to somebody else now.
  if [ "$(_suite_lock_field pid)" = "$$" ]; then rm -rf "$SUITE_LOCK"; fi
  return 0
}

# Takes the lock, or returns 2 having said why. The caller exits on 2.
suite_lock_acquire() {
  if [ -n "${SQL_SUITE_LOCK_HELD:-}" ] \
    && [ "$SQL_SUITE_LOCK_HELD" = "$SUITE_LOCK:$(_suite_lock_field pid)" ] \
    && [ "$(_suite_lock_state)" = held ]; then
    return 0
  fi
  if ! mkdir -p "$SUITE_LOCK_ROOT" 2>/dev/null; then
    echo "SQL SUITE DID NOT RUN ($SQL_SUITE_PROJECT): could not create the lock folder $SUITE_LOCK_ROOT" >&2
    return 2
  fi
  local start=$SECONDS waited next_beat=0 state tmp gone_tries=0
  while :; do
    if mkdir "$SUITE_LOCK" 2>/dev/null; then
      _SUITE_LOCK_OWNED=1
      trap suite_lock_release EXIT
      trap 'suite_lock_release; exit 129' HUP
      trap 'suite_lock_release; exit 130' INT
      trap 'suite_lock_release; exit 143' TERM
      tmp="$SUITE_LOCK/.holder.$$"
      {
        echo "pid=$$"
        echo "pid_start=$(_suite_lock_pid_start $$)"
        echo "started=$(TZ=America/New_York date '+%Y-%m-%d %H:%M:%S') ET"
        echo "worktree=$ROOT"
        echo "project=$SQL_SUITE_PROJECT"
      } > "$tmp" && mv "$tmp" "$SUITE_LOCK/holder"
      export SQL_SUITE_LOCK_HELD="$SUITE_LOCK:$$"
      return 0
    fi
    state="$(_suite_lock_state)"
    case "$state" in
      gone)
        # Released between our mkdir and our look: try again at once. A mkdir
        # that keeps failing with nothing there cannot create it at all.
        gone_tries=$((gone_tries + 1))
        if [ "$gone_tries" -gt 5 ]; then
          echo "SQL SUITE DID NOT RUN ($SQL_SUITE_PROJECT): could not create the lock $SUITE_LOCK" >&2
          return 2
        fi
        continue
        ;;
      stale:*) _suite_lock_take_over; continue ;;
    esac
    gone_tries=0
    waited=$((SECONDS - start))
    if [ "$waited" -ge "$SUITE_LOCK_WAIT" ]; then
      echo "SQL SUITE DID NOT RUN ($SQL_SUITE_PROJECT): container $CONTAINER is in use by another SQL suite run, which did not finish within ${SUITE_LOCK_WAIT}s." >&2
      echo "  holder: $(_suite_lock_describe)" >&2
      echo "  If it is still working, let it finish and run again. If it is stuck, stop it: kill $(_suite_lock_field pid)" >&2
      echo "  If you are sure no SQL suite run is using $CONTAINER, clear the lock: rm -rf $SUITE_LOCK" >&2
      return 2
    fi
    if [ "$waited" -ge "$next_beat" ]; then
      echo "waiting for the SQL suite run using $CONTAINER to finish (${waited}s of ${SUITE_LOCK_WAIT}s): $(_suite_lock_describe)" >&2
      next_beat=$((waited + SUITE_LOCK_HEARTBEAT))
    fi
    sleep "$SUITE_LOCK_POLL"
  done
}
