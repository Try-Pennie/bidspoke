/**
 * Warn when a query approaches the statement timeout, instead of failing at it (#1043).
 *
 * Postgres cancels a statement at its role's `statement_timeout` with a 57014 and nothing
 * before that. The ceilings are per role, not a single number (measured 2026-10-13 in
 * `pg_db_role_setting`): service_role 30s (the Worker), authenticated and authenticator 8s
 * (the browser), anon 3s. `postgres` runs the SQL editor at 120s and is deliberately NOT
 * watched here: its stats mix the dashboard's and the migration tool's ad-hoc queries with
 * pg_cron, so a 100s SQL-editor query would page constantly; pg_cron's own budgets are
 * watched through `cron.job_run_details` (pg-cron-watch), which is the right source for them.
 *
 * The archive's steps count ran 7.1s warm for weeks, then one run took 30.2s and was
 * cancelled (#1040): nothing between "fine" and "outage". `pg_stat_statements` already
 * records each statement's mean and max execution time per role, with constants normalised to
 * `$1` (so no literal values, no PII, reach the log or the alert). This reads them and reports
 * the slowest paths as a fraction of their ceiling.
 *
 * Two signals, because they catch different failures and are rate-limited differently:
 *  - WARN: MEAN past `WARN_MEAN_SHARE` of the ceiling, the TYPICAL run is systematically slow,
 *    which climbs with volume. This is the weeks-of-notice signal the issue asks for. The mean
 *    is a calls-weighted average that falls as fast runs accumulate, so a fixed query's warn
 *    clears on its own; a single shared 6h cooldown stops a standing warn storming every hour.
 *  - CRITICAL: MAX past `CRITICAL_MAX_SHARE`, the slowest single run recorded is one unlucky
 *    run from a cancellation. `max_exec_time` is cumulative since stats were last reset and
 *    never falls, so a critical is rate-limited PER STATEMENT (`queryTimeoutMaxSeenKey`): it
 *    pages only when the slowest run reaches a NEW high, by a margin, above what was last
 *    paged for that queryid. A resolved one-off spike never re-pages; a worse run on any
 *    statement pages at once, never held behind another statement's or the warn window (L36).
 *
 * Both shares are reasoned, not calibrated. Every statement read is logged
 * (`event=query_timeout_watch`) on every run so the shares can be checked against a full
 * window of real readings (L172).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { anyDelivered, forEachSlackOrg } from './alert-fanout'
import { formatErr } from './format-error'
import { logReadFailure } from './scheduled-read'
import { sendQueryTimeoutAlert } from './slack'

/** More than this share of the role's ceiling on a TYPICAL run is a warning. */
export const WARN_MEAN_SHARE = 0.5
/** The slowest single recorded run past this share of the ceiling is one run from a 57014. */
export const CRITICAL_MAX_SHARE = 0.9

/**
 * The cooldown key for the WARN (mean-based) tier only. Criticals are not cooled down here:
 * they are rate-limited per statement by `queryTimeoutMaxSeenKey` instead, so that a page for
 * one statement never silences a new critical high on another. Set after a delivered warn
 * alert; can also be written by hand with a longer TTL to mute warns.
 */
export const QUERY_TIMEOUT_WARN_COOLDOWN_KEY = 'query-timeout-approach:alerted:warn'
/** One warn nudge per window for a standing systematically-slow query, rather than a storm. */
export const QUERY_TIMEOUT_COOLDOWN_TTL_SECONDS = 6 * 60 * 60

/**
 * The slowest single run this check has already PAGED for a statement, keyed on its queryid.
 * `max_exec_time` is cumulative since stats were last reset and never falls, so a critical
 * that paged once would page again every cooldown for ever, even after the query was fixed,
 * which is the alert that cries wolf (L36, L182). A critical therefore fires only when the
 * slowest run has reached a NEW high above what was last paged, the same way pg-cron-watch
 * keys on the exact failure timestamp so a stale failure never re-pages (L160). The mean
 * (warn) path needs no such memory: a weighted mean falls as fast runs accumulate, so a fixed
 * query's warn clears on its own.
 */
// Keyed on role AND queryid: pg_stat_statements' queryid is a hash of the statement text, not
// of the role, so the same normalised statement run by service_role and by authenticated
// shares a queryid but is two rows judged against two different ceilings. Keying on queryid
// alone would let one role's high overwrite the other's and cross-suppress.
export const queryTimeoutMaxSeenKey = (role: string, queryid: string | number) => `query-timeout:maxseen:${role}:${queryid}`
const MAX_SEEN_TTL_SECONDS = 30 * 24 * 60 * 60
/**
 * A critical re-pages only when its slowest run is at least this much worse than the one last
 * paged, so a statement that creeps up by a few milliseconds each hour is not a page an hour.
 */
const NEW_HIGH_MARGIN_MS = 500

/** One statement's cost, as `query_timeout_watch` reports it. */
export interface SlowStatement {
  /** The role that executed it: its ceiling is the one it is judged against. */
  role: string
  /**
   * pg_stat_statements' stable identity for the normalised statement. Kept as the string
   * PostgREST returns for a bigint: queryid is an int64 that routinely exceeds JS's safe
   * integer range, so coercing it to a number would corrupt the value an operator looks it
   * up by. Only logged and displayed, never compared.
   */
  queryid: string | number
  calls: number
  meanMs: number
  maxMs: number
  /** That role's `statement_timeout`, in ms. The denominator for both shares. */
  timeoutMs: number
  /** A truncated, constant-normalised sample of the statement text, for the alert. */
  querySample?: string
}

export type TimeoutSeverity = 'ok' | 'warn' | 'critical'

export interface StatementVerdict extends SlowStatement {
  /** meanMs / timeoutMs, or 0 when the ceiling is not a positive number. */
  meanPct: number
  maxPct: number
  severity: TimeoutSeverity
}

export function judgeStatement(s: SlowStatement): StatementVerdict {
  // A non-positive or unreadable ceiling cannot judge anything, and must never divide: a
  // statement whose ceiling we could not read is reported as ok with a zero share rather
  // than as an infinite one (L50).
  const measurable = Number.isFinite(s.timeoutMs) && s.timeoutMs > 0
  const meanPct = measurable ? s.meanMs / s.timeoutMs : 0
  const maxPct = measurable ? s.maxMs / s.timeoutMs : 0
  const severity: TimeoutSeverity = !measurable
    ? 'ok'
    : maxPct >= CRITICAL_MAX_SHARE
      ? 'critical'
      : meanPct >= WARN_MEAN_SHARE
        ? 'warn'
        : 'ok'
  return { ...s, meanPct, maxPct, severity }
}

const RANK: Record<TimeoutSeverity, number> = { critical: 2, warn: 1, ok: 0 }

/** Every statement judged, most severe first and, within a severity, closest to its ceiling first. */
export function judgeStatements(rows: SlowStatement[]): StatementVerdict[] {
  return rows
    .map(judgeStatement)
    .sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.maxPct - a.maxPct)
}

export interface QueryTimeoutWatchDeps {
  /** Reads the offenders from the database. A failure THROWS, never returns empty (L98). */
  read: () => Promise<SlowStatement[]>
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> }
  /** Delivers one alert carrying the banded statements; returns whether anything was delivered. */
  send: (offenders: StatementVerdict[], nowMs: number) => Promise<boolean>
  now: () => number
  log: (line: string) => void
}

export interface QueryTimeoutWatchResult {
  verdicts: StatementVerdict[]
  offenders: StatementVerdict[]
  alerted: boolean
}

export async function runQueryTimeoutWatch(deps: QueryTimeoutWatchDeps): Promise<QueryTimeoutWatchResult> {
  const nowMs = deps.now()
  // A read that failed is not a database with no slow queries. Letting it throw keeps an
  // outage of this check from reading as a clean bill of health (L98); the caller logs it.
  const rows = await deps.read()
  const verdicts = judgeStatements(rows)

  // Logged on EVERY run, offenders and healthy alike, so the shares above can be calibrated
  // against a full window of real readings (L172). The query sample is already normalised by
  // pg_stat_statements (constants are `$1`), so no literal value reaches the log.
  for (const v of verdicts) {
    deps.log(
      `[query-timeout-watch] event=query_timeout_watch role=${v.role} queryid=${v.queryid} calls=${v.calls}` +
        ` mean_ms=${Math.round(v.meanMs)} max_ms=${Math.round(v.maxMs)} ceiling_ms=${Math.round(v.timeoutMs)}` +
        ` mean_pct=${(v.meanPct * 100).toFixed(0)} max_pct=${(v.maxPct * 100).toFixed(0)} severity=${v.severity}`,
    )
  }

  const banded = verdicts.filter((v) => v.severity !== 'ok')
  if (banded.length === 0) return { verdicts, offenders: banded, alerted: false }

  // Criticals and warns are rate-limited by DIFFERENT mechanisms, because they carry memory
  // differently, and neither shares a tier cooldown (an earlier design did, and a page for
  // statement A then silenced a new critical high on statement B for six hours).
  //
  // A critical is memoryful per statement: `max_exec_time` is cumulative and never falls, so
  // it fires only when the slowest run is a NEW high, by a margin, above what was last paged
  // for THAT queryid. A one-off spike that was fixed never re-pages; a genuinely worse run on
  // any statement pages at once (L36, L182). A read failure fires, because unknown must land
  // on the alerting side (L168).
  const firingCritical: StatementVerdict[] = []
  for (const v of banded.filter((v) => v.severity === 'critical')) {
    let lastPaged = -Infinity
    try {
      const raw = await deps.kv.get(queryTimeoutMaxSeenKey(v.role, v.queryid))
      if (raw !== null) {
        const parsed = Number(raw)
        if (Number.isFinite(parsed)) lastPaged = parsed
      }
    } catch {
      lastPaged = -Infinity // a read we could not make must not suppress a page
    }
    // Fire on a NEW high by a margin, OR when the current max is BELOW what was last paged:
    // `max_exec_time` only ever grows within a stats epoch, so a lower value means
    // pg_stat_statements was reset or the database restarted, and the stored high is a stale
    // memory from the previous epoch. Treating that as a fresh high re-baselines, so a real
    // near-cliff after a reset is not silenced for the 30 day life of the stored value (L174).
    if (v.maxMs > lastPaged + NEW_HIGH_MARGIN_MS || v.maxMs < lastPaged) firingCritical.push(v)
  }

  // A warn is memoryless (a calls-weighted mean falls on its own as fast runs accumulate, so a
  // fixed query's warn clears), so warns alone WOULD storm every hour. One shared warn
  // cooldown rate-limits them. It never gates criticals, so a new critical high is never held
  // behind a warn window.
  const warns = banded.filter((v) => v.severity === 'warn')
  // A KV error reading the warn cooldown must not throw out of the whole check: that would
  // lose the firing criticals already determined above. A warn is less urgent than a critical
  // near-cliff, so a read we could not make holds the warns back (treated as cooled down) and
  // lets the criticals through; the next run retries the warns (L71: the watchdog does not
  // share the fate of one of its own reads).
  let warnCoolingDown = false
  if (warns.length > 0) {
    try {
      warnCoolingDown = (await deps.kv.get(QUERY_TIMEOUT_WARN_COOLDOWN_KEY)) !== null
    } catch {
      warnCoolingDown = true
    }
  }
  const warnsAllowed = warns.length > 0 && !warnCoolingDown
  const alertable = [...firingCritical, ...(warnsAllowed ? warns : [])]
  if (alertable.length === 0) return { verdicts, offenders: banded, alerted: false }

  const delivered = await deps.send(alertable, nowMs)
  // Recorded only on delivery, so a Slack outage during the first bad run does not buy six
  // hours of silence about something nobody was told (L12). Each put is independent and must
  // not throw out of the check: a KV write error would otherwise skip the puts after it and,
  // worse, leave the warn cooldown unarmed so a storm resumes next run. One failed put at most
  // costs one duplicate alert next run, which is the safe side; it is logged, never raised.
  const safePut = async (key: string, value: string, ttl: number) => {
    try {
      await deps.kv.put(key, value, { expirationTtl: ttl })
    } catch (e) {
      deps.log(`[query-timeout-watch] kv put failed for ${key}: ${formatErr(e)}`)
    }
  }
  if (delivered) {
    for (const v of firingCritical) {
      // Stored UNROUNDED: the next run compares the raw `max_exec_time` against this with
      // `maxMs < lastPaged` (the stats-reset rule), so rounding here would make a fractional
      // max (29122.7 stored as 29123) read as a reset every run and re-page for ever.
      await safePut(queryTimeoutMaxSeenKey(v.role, v.queryid), String(v.maxMs), MAX_SEEN_TTL_SECONDS)
    }
    if (warnsAllowed) await safePut(QUERY_TIMEOUT_WARN_COOLDOWN_KEY, '1', QUERY_TIMEOUT_COOLDOWN_TTL_SECONDS)
  }
  return { verdicts, offenders: banded, alerted: delivered }
}

// The roles watched, each judged against its own ceiling, live in ONE place: the
// query_timeout_watch migration's `watched` array. A second copy here would be a hand list
// that drifts from the real filter (L41, L96).

interface QueryTimeoutRow {
  role: string
  queryid: string
  calls: number
  mean_ms: number
  max_ms: number
  timeout_ms: number
  query_sample: string | null
}

/** The production read: the `query_timeout_watch` RPC, normalised into SlowStatement[]. */
export async function readSlowStatements(supabase: SupabaseClient): Promise<SlowStatement[]> {
  const { data, error } = await supabase.rpc('query_timeout_watch', { p_min_calls: 20 })
  logReadFailure('query-timeout-watch', 'query_timeout_watch', error)
  if (error || !Array.isArray(data)) {
    throw new Error(`could not read query timeouts: ${error ? error.message : 'the response was not a list'}`)
  }
  return (data as QueryTimeoutRow[]).map((r) => ({
    role: r.role,
    // Left as the string PostgREST returns: queryid is an int64 beyond JS's safe range.
    queryid: r.queryid,
    calls: Number(r.calls),
    meanMs: Number(r.mean_ms),
    maxMs: Number(r.max_ms),
    timeoutMs: Number(r.timeout_ms),
    querySample: r.query_sample ?? undefined,
  }))
}

/** Wire the live dependencies and run the check. */
export async function runQueryTimeoutWatchLive(supabase: SupabaseClient, kv: KVNamespace): Promise<QueryTimeoutWatchResult> {
  return runQueryTimeoutWatch({
    read: () => readSlowStatements(supabase),
    kv,
    send: (offenders) =>
      forEachSlackOrg(supabase, 'query-timeout-watch', 'tell-only', (orgId) => sendQueryTimeoutAlert(supabase, orgId, offenders)).then(anyDelivered),
    now: () => Date.now(),
    log: (line) => console.log(line),
  })
}
