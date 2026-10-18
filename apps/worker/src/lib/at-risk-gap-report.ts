/**
 * The daily report of the at-risk watch's gap (#2055, from phase D of #2015).
 *
 * The engine's ledger (engine/at-risk-gap.ts) leaves one KV fact per post-answer
 * Salesforce write it saw at a cut-off or starting too late, under
 * `at-risk-gap:<UTC day>:`. Once a day this reads the previous UTC day's facts
 * and records ONE job_runs row (`at-risk-gap-report`), zero days included, so a
 * day with no row means the report did not run rather than that nothing happened
 * (L98). The row's summary has every count and names up to MAX_GAPS_NAMED gaps
 * by run and step, which is what a repair needs: the step's request is in no
 * store, so it is rebuilt from the run's upstream step outputs (#2015, the
 * 2026-10-18 comment).
 *
 * A GAP is a write nothing will ever read back, counted three ways:
 *  - unrecorded: out at the cut-off past its 2 s mark with no record (the record's
 *    KV write failed, or the watch never started);
 *  - missed: inside its first 2 s at the cut-off, or started too late, and still
 *    with no record once its mark passed;
 *  - cancelled: inside its first 2 s at the cut-off, or started too late, with no
 *    second look at all, because the request's work was cancelled first. This is
 *    the isolate dying inside a write's first 2 s that the #2015 plan named.
 * Outcome `gap-found` when any is counted, even on a day not read whole (the
 * detail then says `unreadable` or `truncated`); otherwise `unreadable` when a list
 * failed, `truncated` when the day had more keys than MAX_KEYS_READ, and `none`
 * only for a day read whole with no gap.
 *
 * WHY THIS DOES NOT PAGE. Every run counted here already paged, under
 * continuation_unfinished: that page stays quiet only when the read-back owns
 * the record of every step still out at the cut-off and nothing that sends lies
 * ahead (engine/unfinished-work.ts, #2024), and a write with no record, or one
 * still to come, fails both. A second page for the same run is two alerts for
 * one cause (L11). The exceptions are a muted signal and a run whose failure
 * reads as a classified outage, which that page skips. What this count decides is
 * the question #2055 asks: whether post-answer updates should be recorded before
 * the call rather than at 2 s. The plan's bar is "near zero"; one gap is one
 * write nobody reads back, so a gap-found row is the trigger to reopen that.
 *
 * MEASURED BEFORE THIS SHIPPED, from Workers Logs in 24 hour windows (longer
 * windows miss lines), each zero checked against a line known to be there:
 *  - 2026-10-14 00:00 to 2026-10-18 14:00 UTC: no `[at-risk-writes] could not
 *    record` and no `could not start the watch` line, so no record failed and no
 *    watch failed to start since the watch shipped (#2053, 2026-10-14 01:43 UTC);
 *  - 2026-10-16 00:00 to 2026-10-18 14:00 UTC: no run cut off with only held
 *    writes out (the `read-back holds all the work` line #2024 added), and one cut
 *    off run (2026-10-18 10:43 UTC) whose step out was a relay post, which has no
 *    watch.
 * What could NOT be measured from logs: a write cut off inside its first 2 s, or
 * cancelled there, leaves no line at all before this change. That is the number
 * this report starts producing. #2024 counted 61 unfinished runs in the 8 days to
 * 2026-10-15, 49 of them on writes the read-back holds, so on a calm week the
 * population this watches is a handful of runs a day, and on a Salesforce
 * slowdown (2026-10-13) it is the bulk of them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { AT_RISK_GAP_PREFIX, parseAtRiskGapKey, utcDayOf, type AtRiskGapKind } from '../engine/at-risk-gap'
import { formatErr } from './format-error'
import { recordFinishedJobRun, type JobRunEnding } from './job-run-record'

export const AT_RISK_GAP_REPORT_JOB = 'at-risk-gap-report'
/** Gaps named in the row by run and step; the rest are counted. */
export const MAX_GAPS_NAMED = 20
/** Keys read for one day at most. A slowdown day writes a few hundred. */
export const MAX_KEYS_READ = 10_000
const LIST_PAGE = 1_000
const DAY_MS = 24 * 60 * 60 * 1000

export interface AtRiskGapReportKv {
  list(opts: { prefix: string; limit: number; cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete?: boolean; cursor?: string }>
}

export interface NamedGap {
  execution_id: string
  step_namespace: string
  how: 'unrecorded' | 'missed' | 'cancelled'
}

export interface AtRiskGapReport {
  day: string
  cut_off_runs: number
  held: number
  unrecorded: number
  exposed: number
  late_start: number
  caught_up: number
  missed: number
  /** Exposed or late starts with no second look: the request's work was cancelled first. */
  unreported: number
  /** unrecorded + missed + unreported: writes nothing will read back. */
  gaps: number
  named: NamedGap[]
  keys_listed: number
  /** More keys than MAX_KEYS_READ: the counts are a floor. */
  truncated: boolean
  unreadable: boolean
}

export interface AtRiskGapReportDeps {
  kv: AtRiskGapReportKv
  now?: () => number
  recordRun: (startedAtMs: number, ending: JobRunEnding) => Promise<void>
  /** Keys read at most; MAX_KEYS_READ unless a test sets it. */
  maxKeys?: number
}

/** Reads the previous UTC day's facts and records one row. Never throws. */
export async function runAtRiskGapReport(deps: AtRiskGapReportDeps): Promise<AtRiskGapReport> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const day = utcDayOf(startedAt - DAY_MS)
  const report: AtRiskGapReport = {
    day, cut_off_runs: 0, held: 0, unrecorded: 0, exposed: 0, late_start: 0, caught_up: 0, missed: 0,
    unreported: 0, gaps: 0, named: [], keys_listed: 0, truncated: false, unreadable: false,
  }

  const facts = new Map<string, Set<AtRiskGapKind>>()
  try {
    const prefix = `${AT_RISK_GAP_PREFIX}${day}:`
    let cursor: string | undefined
    for (;;) {
      const page = await deps.kv.list({ prefix, limit: LIST_PAGE, ...(cursor ? { cursor } : {}) })
      for (const { name } of page.keys) {
        report.keys_listed++
        const fact = parseAtRiskGapKey(name)
        if (!fact || fact.day !== day) continue
        const pair = `${fact.execution_id}:${fact.step_namespace}`
        const kinds = facts.get(pair) ?? new Set<AtRiskGapKind>()
        kinds.add(fact.kind)
        facts.set(pair, kinds)
      }
      if (page.list_complete !== false || !page.cursor) break
      if (report.keys_listed >= (deps.maxKeys ?? MAX_KEYS_READ)) {
        report.truncated = true
        break
      }
      cursor = page.cursor
    }
  } catch (e) {
    console.error(`[${AT_RISK_GAP_REPORT_JOB}] could not list the gap facts of ${day}, so the day is unmeasured:`, formatErr(e))
    report.unreadable = true
  }

  for (const [pair, kinds] of [...facts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const kind of kinds) if (kind !== 'cut_off') report[kind]++
    if (kinds.has('cut_off')) report.cut_off_runs++
    const at = pair.indexOf(':')
    const named = (how: NamedGap['how']) => {
      report.gaps++
      if (report.named.length < MAX_GAPS_NAMED) report.named.push({ execution_id: pair.slice(0, at), step_namespace: pair.slice(at + 1), how })
    }
    if (kinds.has('unrecorded')) named('unrecorded')
    if (kinds.has('missed')) named('missed')
    if ((kinds.has('exposed') || kinds.has('late_start')) && !kinds.has('caught_up') && !kinds.has('missed')) {
      report.unreported++
      named('cancelled')
    }
  }

  // A gap read is a gap, whatever else went wrong, so it wins; `none` only for a
  // day read whole. A day cut short is a floor, never a clean zero (lessons
  // review of #2436).
  const outcome = report.gaps > 0 ? 'gap-found' : report.unreadable ? 'unreadable' : report.truncated ? 'truncated' : 'none'
  if (report.gaps > 0) {
    console.error(`[${AT_RISK_GAP_REPORT_JOB}] ${report.gaps} post-answer Salesforce writes on ${day} were never recorded for the read-back: ${report.named.map((g) => `${g.execution_id} ${g.step_namespace} (${g.how})`).join(', ')}`)
  }
  await deps.recordRun(startedAt, {
    outcome,
    detail: `day=${day} cut_off_runs=${report.cut_off_runs} held=${report.held} gaps=${report.gaps} unrecorded=${report.unrecorded} missed=${report.missed} cancelled=${report.unreported} exposed=${report.exposed} late_start=${report.late_start}${report.truncated ? ' truncated' : ''}${report.unreadable ? ' unreadable' : ''}`,
    summary: { ...report },
  })
  return report
}

export function runAtRiskGapReportForEnv(supabase: SupabaseClient, env: Env): Promise<AtRiskGapReport> {
  return runAtRiskGapReport({
    kv: env.IDEMPOTENCY,
    recordRun: (startedAtMs, ending) => recordFinishedJobRun(supabase, AT_RISK_GAP_REPORT_JOB, startedAtMs, ending),
  })
}
