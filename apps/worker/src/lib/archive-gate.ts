/**
 * Measuring each archived day, so the deletion gate has numbers to read
 * (#872, Phase A4).
 *
 * The reading half is `archive/gate.ts` and is pure. This is the half that goes
 * and gets the numbers: an independent Postgres count, an independent Snowflake
 * count, and a decompressed sample of real bundles.
 *
 * INDEPENDENT is the word that matters. None of these come from what the
 * archiver reported about its own work: a check whose expected and actual come
 * from one lookup can only prove that lookup is self-consistent (L70). The
 * archiver's own ledger, `execution_archive_ids`, is used for exactly one thing,
 * the orphan anti-join, where the question genuinely is "which steps did the
 * archiver never claim".
 *
 * SHADOW STILL. Nothing here deletes anything, and nothing reads these
 * measurements to authorise a deletion until A5 (#873).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { notifyExportFailure, type AlertRemedy, type TitledRemedy } from './export-alerts'
import { executeStatement } from './snowflake'
import { archiveConfig, ARCHIVE_DATABASE, ARCHIVE_SCHEMA, ARCHIVE_TABLE } from './archive-snowflake'
import { ARCHIVE_STREAM, SUBREQUEST_BUDGET } from './execution-archive'
import { decodeBundle } from '../archive/bundle'
import { candidateDays, RETENTION_DAYS } from '../archive/candidate-days'
import { daysHeldInPostgres, daysBeneathTheGate, daysBetween } from '../archive/days-held'
import { LOOKBACK_DAYS } from './archive-backlog-run'
import { refusalsFor, type DayMeasurement, type DayRefusal } from '../archive/gate'
import { withJobRun } from './job-run-record'
import type { Env } from '../index'

/**
 * What the gate's end of pass report says, as three separate alerts (#1720).
 *
 * One alert used to carry every finding under "found days at risk". On
 * 2026-10-02 that headline sat above a day that was fully backed up and merely
 * not cleaned up, with three fixes for three other situations, and read as data
 * about to be lost. A backed up day the cleanup missed and a day with no backup
 * due for deletion ask for different things on different clocks (L11, L112), so
 * each is its own alert with its own title, and neither title can misdescribe the
 * other's lines. The wording is Dan's (2026-10-02).
 */
/**
 * A day the gate cannot verify is HELD BACK, not deleted (#835). The nightly
 * cleanup (`truncate_verified_execution_partitions`) takes only days verified in
 * the last 36 hours and logs every other expired day as `refused_unverified`, so
 * the deadline this alert used to quote ("due to be deleted at 11:30 PM ET, and
 * after that it cannot be recovered") was never real. What is true is that the
 * database holds the only copy until the day is backed up.
 */
export const ARCHIVE_GATE_AT_RISK_REMEDY: TitledRemedy = {
  title: 'Run history is held back from deletion until it is backed up',
  context: 'Nothing is lost while it is held, but until then the database holds the only copy.',
  fixHint:
    'Re-archive each day named with POST /api/admin/re-archive, or fix the read a line names and re-run ' +
    'the pass with POST /api/admin/archive-gate.',
}

/**
 * Days beneath the gate a full pass measures again, oldest first (#2085, Dan
 * 2026-10-14). The cleanup takes only a day measured in the last 36 hours, and
 * the gate otherwise measures a day only until one night past its purge, so a
 * backed up day that missed twice could never be taken. Capped so a long
 * backlog cannot push the pass past its time budget; the rest follow on later
 * nights.
 */
export const BENEATH_REMEASURE_PER_PASS = 3

/**
 * A backed up day the cleanup has not taken (#1720). The cleanup takes only a
 * day measured in the last 36 hours, and the gate measures a day only until one
 * night past its own purge, so by the third missed night nothing scheduled can
 * take it, whatever stopped the first two (#835). The lines carry what the
 * cleanup itself recorded about the day rather than assuming a lock was lost.
 */
export const ARCHIVE_GATE_NOT_CLEANED_UP_REMEDY: TitledRemedy = {
  title: 'Old run history has not been cleaned up',
  fixHint:
    `Each nightly gate pass re-measures up to ${BENEATH_REMEASURE_PER_PASS} of these, oldest first, and that ` +
    "night's cleanup can then take any still fully backed up. If a day stays on this list, the cleanup's " +
    'record above says why. It is fully backed up, so this costs disk space, not data.',
}

/** What the nightly cleanup last recorded about a day, from `purge_run_log`. */
export interface PurgeRecord {
  outcome: string
  reason: string | null
}

export const ARCHIVE_GATE_COST_REMEDY: TitledRemedy = {
  title: 'The daily backup check is outgrowing its time slot',
  fixHint: 'Move the deletion gate to its own scheduled run before it slows the other 13:00 UTC jobs.',
}

/** The alert keys for the two findings that are not the at risk one, so each pages and clears on its own. */
export const ARCHIVE_GATE_CLEANUP_JOB = 'execution-archive-gate-cleanup'
export const ARCHIVE_GATE_COST_JOB = 'execution-archive-gate-cost'

/**
 * Nightly purges a backed up day may survive before anybody is told (Dan,
 * 2026-10-02). One or two misses are a lock lost to a busy minute and the next
 * night takes the day; a third says the cleanup is not fixing itself.
 */
export const CLEANUP_SILENT_NIGHTS = 2


/** The minute of the nightly purge, `30 3 * * *` UTC. */
const PURGE_MINUTE_OF_DAY_UTC = 3 * 60 + 30
const DAY_MS = 24 * 60 * 60 * 1000

function utcMidnight(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`)
}

/** The purge that first should take a day: 03:30 UTC on the morning after its last day inside retention. */
export function nominalPurgeFor(day: string): Date {
  return new Date(utcMidnight(day) + (RETENTION_DAYS + 1) * DAY_MS + PURGE_MINUTE_OF_DAY_UTC * 60 * 1000)
}

/** Nightly purges that have run since a day was first due; 0 before it was. */
export function purgesMissed(day: string, now: Date): number {
  const due = nominalPurgeFor(day).getTime()
  if (now.getTime() < due) return 0
  return Math.floor((now.getTime() - due) / DAY_MS) + 1
}

const ET = 'America/New_York'

/** "Sep 23". A day here is a UTC calendar day, so it is spoken as that day. */
export function spokenDay(day: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(
    new Date(utcMidnight(day)),
  )
}

/** "11:30 PM ET" for an instant, daylight saving included. */
export function etClock(instant: Date): string {
  return `${new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' }).format(instant)} ET`
}

/**
 * Why a held back day is held, which decides what fixes it (#835).
 *
 * - `refused`: measured, and short in a way re-archiving fills.
 * - `surplus`: measured, and the archive holds MORE than the database, which
 *   re-archiving cannot clear.
 * - `unmeasured`: the measurement itself failed.
 * - `beneath-short`: older than the gate measures, and its last reading was short.
 * - `beneath-unknown`: older than the gate measures, and its record could not be read.
 */
export type HeldKind = 'refused' | 'surplus' | 'unmeasured' | 'beneath-short' | 'beneath-unknown'

export interface HeldDay {
  day: string
  kind: HeldKind
  /** The refusal messages or the error, for the line. */
  detail: string | null
}

/** One line per held day, saying only what was measured about it. */
export function heldLine({ day, kind, detail }: HeldDay): string {
  const spoken = spokenDay(day)
  switch (kind) {
    case 'refused':
    case 'surplus':
      return `${spoken} cannot be verified as backed up in Snowflake: ${detail}.`
    case 'unmeasured':
      return `${spoken} could not be measured, so it is not confirmed as backed up in Snowflake: ${detail}.`
    case 'beneath-short':
      return (
        `${spoken} is older than the days the gate measures, and its last measurement showed it not fully ` +
        'backed up in Snowflake.'
      )
    case 'beneath-unknown':
      return (
        `${spoken} is older than the days the gate measures, and whether it is backed up in Snowflake could ` +
        `not be read${detail === null ? '' : `: ${detail}`}.`
      )
  }
}

/** The fix line, chosen from why each day is held rather than one remedy for all (#835). */
export function heldRemedy(held: HeldDay[]): TitledRemedy {
  if (held.length === 0) return ARCHIVE_GATE_AT_RISK_REMEDY
  const daysOf = (kinds: HeldKind[]) => held.filter((h) => kinds.includes(h.kind)).map((h) => h.day)
  const list = (days: string[]) => days.join(', ')
  const reArchive = daysOf(['refused', 'beneath-short'])
  const remeasure = daysOf(['unmeasured', 'beneath-unknown'])
  const surplus = daysOf(['surplus'])
  const parts: string[] = []
  if (reArchive.length === 1) {
    parts.push(`Re-archive ${reArchive[0]} with POST /api/admin/re-archive and that day.`)
  } else if (reArchive.length > 1) {
    parts.push(`Re-archive ${list(reArchive)} with POST /api/admin/re-archive, one day per call, earliest first.`)
  }
  if (remeasure.length > 0) {
    parts.push(
      `For ${list(remeasure)}, fix the read named above, then re-run the pass with POST /api/admin/archive-gate.`,
    )
  }
  if (surplus.length > 0) {
    parts.push(
      `For ${list(surplus)}, re-archiving will not help: the archive holds executions the database does not, ` +
        'so find which ones are filed under that day.',
    )
  }
  return { ...ARCHIVE_GATE_AT_RISK_REMEDY, fixHint: parts.join(' ') }
}

/**
 * What the gate knows about a day older than anything it considers.
 *
 * `backedUp` is true only when the day's last measurement showed the archive
 * holding every execution Postgres counted, with every hour recorded, no
 * incomplete row and a passing probe. Anything less, including no record at all,
 * is false: an absent or unreadable record is not evidence of a backup (L215).
 */
export interface BeneathStatus {
  backedUp: boolean
}

/**
 * The gate could not read what it needs, so it aborted having verified nothing.
 * A separate condition from the report above: an empty report and a pass that
 * never happened must not read the same (L98).
 */
export const ARCHIVE_GATE_UNREADABLE_REMEDY: AlertRemedy = {
  // Not "the purge still runs on its own schedule", which read as data about to
  // go: the cleanup takes only days measured in the last 36 hours, so a skipped
  // pass KEEPS the days it would have verified (#835).
  consequence:
    'The deletion gate could not read what it needs and abandoned its pass, so no day was measured. The ' +
    'nightly cleanup deletes only days measured in the last 36 hours, so the days this pass would have ' +
    'verified are kept until a pass succeeds:',
  fixHint:
    'The line below names the read that failed. Fix that read against Supabase, then re-run the pass ' +
    'with POST /api/admin/archive-gate so the next cleanup has measurements to act on.',
  headlineVerb: 'could not run',
  itemNoun: { one: 'reason', many: 'reasons' },
}

export const ARCHIVE_GATE_JOB = 'execution-archive-gate'

const QUALIFIED_TABLE = `${ARCHIVE_DATABASE}.${ARCHIVE_SCHEMA}.${ARCHIVE_TABLE}`

/**
 * Bundles decompressed per day.
 *
 * Sized from a detection floor rather than picked round. To catch a defect
 * affecting a fraction p of a day with 95% confidence needs ln(0.05)/ln(1-p)
 * samples; at p = 5% that is 58.4, so 60.
 *
 * What this CANNOT do is worth stating, because a probe is easy to over-trust:
 * 60 of roughly 105,000 will not notice a defect affecting 1% of a day. The
 * thing that protects against small systematic loss is the step count, and it
 * can carry that weight because `encodeBundle` derives `step_count` by
 * decompressing and re-parsing the wire it just produced, so it measures what is
 * actually in the bundle rather than what the archiver intended to put there
 * (L63). The probe covers what a count cannot: a bundle that does not parse, or
 * one whose contents belong to a different execution.
 */
export const PROBE_SAMPLE_SIZE = 60

/**
 * How close to deletion a day must be before a refusal is alerted rather than
 * only recorded.
 *
 * Every refusal is written to `execution_archive_days` regardless. But a day one
 * day old that refuses for `incomplete-rows` needs a re-archive; nothing has a
 * three day floor, so recently archived days routinely carry non-terminal rows
 * that resolve on their own. Alerting on those daily would train everyone to
 * ignore the alert, and would be loudest for the days with the most slack.
 *
 * Urgency here is what the reader must do and how soon (L112). At 3 days of
 * runway there is still time to re-archive an hour, resolve a refusal or push
 * the retention out, and the alert says which.
 */
export const ALERT_WHEN_DAYS_LEFT = 3

/**
 * Outbound calls one gate pass may issue before it says so (#1127).
 *
 * The gate shares the `0 13 * * *` invocation with the other daily jobs, and the
 * platform's subrequest ceiling is per invocation, so the gate spending all of it
 * starves whatever runs beside it. `SUBREQUEST_BUDGET` (900) is what the archive
 * holds itself to for a whole invocation; a third of it is the gate's share of a
 * shared one.
 *
 * It WARNS rather than stopping. Truncating the pass at a ceiling would leave the
 * days it did not reach unmeasured while the run still read as complete, which is
 * the failure #1129 and #1137 exist to remove. A pass that costs too much is a
 * scheduling decision for a person (split it onto its own cron, the way the
 * sightings export and purge already are), not something to take silently.
 */
export const GATE_SUBREQUEST_SHARE = Math.floor(SUBREQUEST_BUDGET / 3)

/**
 * What to say about a pass that costs too much, or nothing at all.
 *
 * Pure and exported so the threshold can be driven from a literal and watched to
 * fire. Reached through the real run it cannot be: the pass's cost is set by
 * RETENTION_DAYS and a fixed lookback, so no fixture can push it over the line,
 * and a test written against the run would pass whichever side it landed on (L1).
 */
export function costWarnings(cost: GateRunCost, daysMeasured: number): string[] {
  if (cost.subrequests <= GATE_SUBREQUEST_SHARE) return []
  // Named as a scheduling problem, because that is the remedy: nothing about the
  // archive is broken, the pass has simply outgrown a shared invocation.
  return [
    `the gate pass issued ${cost.subrequests} outbound calls, past its ${GATE_SUBREQUEST_SHARE} share of the ` +
      `shared 13:00 invocation (${cost.subrequestsPerDay ?? 0} per day across ${daysMeasured} days), so it ` +
      `should move to its own cron before it starves whatever runs beside it`,
  ]
}

export interface GateDayResult {
  archiveDay: string
  measurement: DayMeasurement | null
  refusals: DayRefusal[]
  /** Days until this day's partition is dropped, so the alert can be about urgency. */
  daysLeft: number
  /** Set when the day could not be measured at all, which is not the same as refusing. */
  error: string | null
}

/**
 * What one pass cost, measured rather than estimated (#1127).
 *
 * The gate runs inside the shared `0 13 * * *` invocation, and a per invocation
 * subrequest ceiling is shared by everything in it. The window is derived from
 * RETENTION_DAYS, which has changed three times in a fortnight (7, 14, 21, and
 * back to 7), so the cost moves with a constant somebody else edits.
 *
 * Recorded on every run rather than measured once into a comment, because a
 * number with a date on it reads as MORE trustworthy the older it gets, and this
 * one expires the next time retention moves (L316). The answer to "is there
 * headroom" is a query against job_runs, not a sentence anybody has to maintain.
 */
export interface GateRunCost {
  durationMs: number
  /** Every outbound call this pass issued, which is what the ceiling counts. */
  subrequests: number
  snowflakeStatements: number
  postgresCalls: number
  /** Cost per day measured, so a change in the window is separable from a change in the work (L323). */
  msPerDay: number | null
  subrequestsPerDay: number | null
}

export interface GateRunSummary {
  cost: GateRunCost
  /**
   * Days Postgres holds that are OLDER than anything this pass considered.
   *
   * The gate decides which days are safe to delete, so a day outside its view is
   * one it can never vouch for while the purge takes it on schedule. Empty is
   * the healthy answer and the ordinary one.
   */
  daysBeneathTheGate: string[]
  /** Days this pass ATTEMPTED. Equals daysAvailable unless the caller restricted it. */
  daysConsidered: number
  /** Days it could have attempted, so a chunk is visibly a chunk and not a short full pass. */
  daysAvailable: number
  /** The job_runs row this pass opened, so a caller whose client dies can look up the ending. */
  runId: string | null
  /** Candidates the purge has already emptied and stamped, so they were not measured. */
  daysStamped: number
  daysMeasured: number
  daysDeletable: number
  results: GateDayResult[]
  failed: boolean
  detail: string
}

export interface GateDeps {
  /** Returns the statement's rows. Injected so a test drives the real logic against real shapes. */
  querySnowflake?: (statement: string, bindings?: unknown[]) => Promise<unknown[][]>
  now?: () => Date
  /**
   * Narrow the pass to a slice of the candidate days (#1129).
   *
   * A full pass takes about six minutes and the admin route did all of it inside
   * the request, so any client that gave up first killed the run partway with no
   * response and no record of how far it got. A caller can now drive it in
   * chunks that fit inside its own timeout.
   *
   * The scheduled 13:00 run passes nothing and is unaffected: it has no client.
   */
  restrictDays?: { from?: string; to?: string; limit?: number }
  /**
   * Which days Postgres still holds, asked rather than computed (#1025).
   *
   * Injected so a test drives the real comparison without a second database
   * double. The default is the same reader the backlog walk uses, which is the
   * point: one method for this question rather than two that happen to coincide.
   */
  daysHeld?: (range: { from: string; to: string }) => Promise<string[]>
  /** Whether each day beneath the gate is backed up (#1720). Injected for the same reason as `daysHeld`. */
  beneathStatus?: (days: string[]) => Promise<Map<string, BeneathStatus>>
  /** What the nightly cleanup last recorded about each day (#835). Injected for the same reason. */
  lastPurge?: (days: string[]) => Promise<Map<string, PurgeRecord>>
  /** How many days beneath the gate a full pass re-measures (#2085). Defaults to BENEATH_REMEASURE_PER_PASS. */
  remeasureBeneath?: number
}

/**
 * The newest `purge_run_log` row for each day, so the not cleaned up alert says
 * what the cleanup recorded rather than guessing a cause (#835).
 *
 * THROWS on a failed read, so the caller says the record could not be read
 * rather than that the cleanup recorded nothing (L215).
 */
export async function readLastPurge(supabase: SupabaseClient, days: string[]): Promise<Map<string, PurgeRecord>> {
  const last = new Map<string, PurgeRecord>()
  // One read per day, newest row only. A single read across all days with a
  // shared limit let one busy day crowd another out, which then read as "no
  // cleanup has recorded anything" (lessons review, #835). The days beneath the
  // gate are a handful, so this is a handful of reads.
  for (const day of days) {
    // paginate-ok: one row, the newest for this day
    const { data, error } = await supabase
      .from('purge_run_log')
      .select('archive_day, outcome, reason, recorded_at')
      .eq('archive_day', day)
      .order('recorded_at', { ascending: false })
      .limit(1)
    if (error) throw new Error(`reading the cleanup record for ${day} failed: ${formatErr(error)}`)
    const row = ((data ?? []) as Array<Record<string, unknown>>)[0]
    if (row !== undefined && typeof row.outcome === 'string') {
      last.set(day, { outcome: row.outcome, reason: typeof row.reason === 'string' ? row.reason : null })
    }
  }
  return last
}

/**
 * Whether each day beneath the gate was backed up at its last measurement.
 *
 * THROWS on a failed read, so the caller treats every day as unconfirmed rather
 * than as safe (L215).
 */
export async function readBeneathStatus(
  supabase: SupabaseClient,
  days: string[],
): Promise<Map<string, BeneathStatus>> {
  const { data, error } = await supabase
    .from('execution_archive_days')
    .select(
      'archive_day, pg_execution_count, erased_execution_count, sf_execution_count, hours_recorded, incomplete_count, probe_ok',
    )
    .in('archive_day', days)
  if (error) throw new Error(`reading the archive record for ${days.join(', ')} failed: ${formatErr(error)}`)
  const status = new Map<string, BeneathStatus>(days.map((d) => [d, { backedUp: false }]))
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const pg = Number(row.pg_execution_count)
    const erased = Number(row.erased_execution_count ?? 0)
    const sf = Number(row.sf_execution_count)
    const backedUp =
      row.pg_execution_count !== null &&
      row.sf_execution_count !== null &&
      Number.isFinite(pg) &&
      Number.isFinite(sf) &&
      sf >= pg - erased &&
      Number(row.hours_recorded) === 24 &&
      Number(row.incomplete_count) === 0 &&
      row.probe_ok === true
    status.set(String(row.archive_day), { backedUp })
  }
  return status
}

/**
 * The slice of `candidates` a caller asked for.
 *
 * REFUSES rather than falling back. A range naming no candidate day is a caller
 * asking for something this pass cannot do, and quietly measuring every day
 * instead would make a six minute run about everything look exactly like the one
 * day run that was asked for (L320).
 */
export function restrictCandidates(
  candidates: string[],
  restrict: { from?: string; to?: string; limit?: number } | undefined,
): string[] {
  if (restrict === undefined) return candidates
  let chosen = candidates
  if (restrict.from !== undefined) chosen = chosen.filter((d) => d >= (restrict.from as string))
  if (restrict.to !== undefined) chosen = chosen.filter((d) => d <= (restrict.to as string))
  // Oldest first, so a limit keeps the days CLOSEST to deletion rather than the
  // ones with days of slack left. `candidateDays` already orders them that way.
  if (restrict.limit !== undefined) chosen = chosen.slice(0, restrict.limit)
  if (chosen.length === 0 && candidates.length > 0) {
    throw new Error(
      `the requested range matched no candidate day: the gate is considering ${candidates[0]} to ` +
        `${candidates[candidates.length - 1]}`,
    )
  }
  return chosen
}

function toNumber(cell: unknown, what: string): number {
  const value = typeof cell === 'string' || typeof cell === 'number' ? Number(cell) : NaN
  if (!Number.isFinite(value)) throw new Error(`${what} came back as ${JSON.stringify(cell)}, which is not a number`)
  return value
}

/**
 * The Snowflake side of a day.
 *
 * Grouped by execution_id BEFORE summing, which is not decoration. The send path
 * is a plain INSERT and the design deliberately tolerates duplicates, because a
 * re-run after a crash re-sends an hour and `COUNT(DISTINCT execution_id)` is
 * unaffected. A bare `SUM(step_count)` is NOT unaffected: it would double count
 * every re-sent execution and report a step surplus on exactly the days a
 * recovery had touched. `MAX(step_count)` per execution also picks the good copy
 * when a truncated one sits beside it.
 */
/** A statement and the values it binds, never a statement with values in it. */
export interface ArchiveQuery {
  statement: string
  bindings: unknown[]
}

export function countsStatement(day: string): ArchiveQuery {
  // INCOMPLETENESS COMES FROM THE LATEST ROW, not from MAX across the copies.
  //
  // This is the one place the duplicate-tolerant design bites (#1023). Taking
  // MAX for `step_count` is right: it picks the good copy when a truncated one
  // sits beside it. Taking MAX for `archived_incomplete` picks the WORST copy,
  // which meant a day could never be cleared: re-archiving it wrote a new,
  // complete row, the old incomplete one stayed, MAX stayed 1, and the day
  // refused for ever. That made the remedy the refusal names ineffective, on
  // the one refusal nothing else resolves (#871).
  //
  // `bundlesStatement` below already reads the newest row per execution, so
  // before this the probe and the count disagreed about which copy was real.
  // They now read the same one.
  return {
    statement:
    'SELECT COUNT(*), COALESCE(SUM(step_count), 0), COALESCE(SUM(incomplete), 0) FROM (' +
    '  SELECT execution_id, MAX(step_count) AS step_count,' +
    '         MAX(CASE WHEN rn = 1 AND archived_incomplete THEN 1 ELSE 0 END) AS incomplete' +
    '  FROM (' +
    '    SELECT execution_id, step_count, archived_incomplete,' +
    '           ROW_NUMBER() OVER (PARTITION BY execution_id ORDER BY archived_at_utc DESC) AS rn' +
    `    FROM ${QUALIFIED_TABLE} WHERE archive_day = ?::DATE)` +
    '  GROUP BY execution_id)',
    bindings: [day],
  }
}

/**
 * The sampled bundles for one day, bound rather than interpolated (#1006).
 *
 * An EMPTY id list becomes `WHERE FALSE` rather than an empty `IN ()`, which is
 * a syntax error, and rather than dropping the clause, which would ask for the
 * whole day (L320). The caller only reaches here with a sample, so this is the
 * shape that stops a future caller getting a different answer than it asked for.
 */
export function bundlesStatement(day: string, executionIds: string[]): ArchiveQuery {
  if (executionIds.length === 0) {
    return { statement: `SELECT execution_id, trace_id, bundle_gz_b64 FROM ${QUALIFIED_TABLE} WHERE FALSE`, bindings: [] }
  }
  // One placeholder per id, derived from the list, so the two can never differ.
  const list = executionIds.map(() => '?').join(',')
  return {
    statement:
      'SELECT execution_id, trace_id, bundle_gz_b64 FROM (' +
      '  SELECT execution_id, trace_id, bundle_gz_b64,' +
      '         ROW_NUMBER() OVER (PARTITION BY execution_id ORDER BY archived_at_utc DESC) AS rn' +
      `  FROM ${QUALIFIED_TABLE}` +
      `  WHERE archive_day = ?::DATE AND execution_id IN (${list})` +
      ') WHERE rn = 1',
    bindings: [day, ...executionIds],
  }
}

interface ProbeRow {
  execution_id: string
  trace_id: string | null
  step_count: number
}

/**
 * Decompress a sample and check each bundle against what Postgres says.
 *
 * A bundle that is missing from Snowflake entirely is a probe FAILURE, not a
 * skipped sample: it is the strongest evidence the day can produce that the
 * archive is short, and quietly sampling fewer would turn it into a pass.
 */
async function runProbe(
  day: string,
  sample: ProbeRow[],
  query: (q: ArchiveQuery) => Promise<unknown[][]>,
): Promise<{ sampled: number; ok: boolean; reason: string | null }> {
  if (sample.length === 0) return { sampled: 0, ok: true, reason: null }

  const rows = await query(bundlesStatement(day, sample.map((r) => r.execution_id)))
  const byId = new Map<string, { traceId: string | null; wire: string }>()
  for (const row of rows) {
    const id = row[0]
    if (typeof id !== 'string') continue
    byId.set(id, { traceId: typeof row[1] === 'string' ? row[1] : null, wire: String(row[2]) })
  }

  // MISSING IS COUNTED ACROSS THE WHOLE SAMPLE before anything else (#1128).
  //
  // Returning on the first absent id made every alert read "no bundle at all
  // for <one id>" whether 1 of 60 or 59 of 60 were gone. Those are different
  // situations asking for different work: a handful missing is a data problem,
  // nearly all missing is a day that was never sent. Sixteen consecutive days
  // of alerts carried the same sentence and none of them said which it was
  // (L11).
  //
  // The content checks below stay first-fail, because each of those describes
  // one bundle's own corruption rather than a quantity, and decoding the whole
  // sample to count them would cost the run's budget for no better answer.
  const missing = sample.filter((expected) => !byId.has(expected.execution_id))
  if (missing.length > 0) {
    const one = missing.length === 1
    return {
      sampled: sample.length,
      ok: false,
      reason: one
        ? `no bundle at all for ${missing[0].execution_id}, of the ${sample.length} sampled`
        : `${missing.length} of the ${sample.length} sampled executions have no bundle at all, ` +
          `starting with ${missing[0].execution_id}`,
    }
  }

  for (const expected of sample) {
    const found = byId.get(expected.execution_id)
    if (found === undefined) continue
    let bundle
    try {
      bundle = await decodeBundle(found.wire)
    } catch (err) {
      return {
        sampled: sample.length,
        ok: false,
        reason: `the bundle for ${expected.execution_id} does not decompress and parse: ${formatErr(err)}`,
      }
    }
    const execution = bundle.execution as Record<string, unknown> | null
    if (execution === null || execution.id !== expected.execution_id) {
      return {
        sampled: sample.length,
        ok: false,
        reason:
          `the bundle stored for ${expected.execution_id} contains execution ` +
          `${JSON.stringify(execution?.id)}, so the rows do not belong to the executions they are filed under`,
      }
    }
    if (bundle.steps.length !== expected.step_count) {
      return {
        sampled: sample.length,
        ok: false,
        reason:
          `bundle for ${expected.execution_id} reports ${bundle.steps.length} steps, ` +
          `Postgres has ${expected.step_count}`,
      }
    }
    // A scalar the gate never compares in bulk, checked here so a column written
    // from the wrong row is caught rather than only a wrong count.
    if (expected.trace_id !== null && found.traceId !== expected.trace_id) {
      return {
        sampled: sample.length,
        ok: false,
        reason:
          `the archived trace_id for ${expected.execution_id} is ${JSON.stringify(found.traceId)}, ` +
          `Postgres has ${JSON.stringify(expected.trace_id)}`,
      }
    }
  }

  return { sampled: sample.length, ok: true, reason: null }
}

async function measureDay(
  countPostgres: () => void,
  supabase: SupabaseClient,
  day: string,
  query: (q: ArchiveQuery) => Promise<unknown[][]>,
  now: Date,
): Promise<DayMeasurement> {
  countPostgres()
  const pg = await supabase.rpc('archive_day_measurements', { p_day: day })
  if (pg.error) throw new Error(`the Postgres measurement failed: ${formatErr(pg.error)}`)
  const pgRow = (pg.data as Array<Record<string, unknown>> | null)?.[0]
  if (pgRow === undefined) {
    // Not read as zeros. An RPC that answered with no row measured nothing, and
    // zeros would sail through the gate as a genuinely empty day (L215).
    throw new Error('the Postgres measurement returned no row, which is not the same as a day of no executions')
  }

  const sfRows = await query(countsStatement(day))
  const sf = sfRows[0]
  if (sf === undefined) {
    throw new Error('the Snowflake count returned no row, which is not the same as a count of zero')
  }

  countPostgres()
  const probeSample = await supabase.rpc('archive_day_probe_sample', {
    p_day: day,
    p_sample_size: PROBE_SAMPLE_SIZE,
  })
  if (probeSample.error) throw new Error(`the probe sample failed: ${formatErr(probeSample.error)}`)
  const sample = ((probeSample.data as ProbeRow[] | null) ?? []).map((r) => ({
    execution_id: String(r.execution_id),
    trace_id: r.trace_id === null || r.trace_id === undefined ? null : String(r.trace_id),
    step_count: Number(r.step_count),
  }))

  const probe = await runProbe(day, sample, query)

  return {
    archiveDay: day,
    pgExecutionCount: toNumber(pgRow.pg_execution_count, 'the Postgres execution count'),
    pgStepCount: toNumber(pgRow.pg_step_count, 'the Postgres step count'),
    orphanExecutionCount: toNumber(pgRow.orphan_execution_count, 'the orphan execution count'),
    orphanStepCountSeen: toNumber(pgRow.orphan_step_count_seen, 'the sampled orphan step count'),
    orphanSampleSize: toNumber(pgRow.orphan_sample_size, 'the orphan sample size'),
    hoursRecorded: toNumber(pgRow.hours_recorded, 'the count of archived hours'),
    hoursExecutionCount: toNumber(pgRow.hours_execution_count, "the hours' execution count"),
    erasedExecutionCount: toNumber(pgRow.erased_execution_count, 'the erased execution count'),
    sfExecutionCount: toNumber(sf[0], 'the Snowflake execution count'),
    sfStepCount: toNumber(sf[1], 'the Snowflake step count'),
    incompleteCount: toNumber(sf[2], 'the Snowflake incomplete count'),
    probeSampled: probe.sampled,
    probeOk: probe.ok,
    probeFailureReason: probe.reason,
    measuredAt: now.toISOString(),
    firstMeasuredAt: null,
  }
}

function daysLeftFor(day: string, now: Date): number {
  const dayMs = Date.parse(`${day}T00:00:00.000Z`)
  const todayMs = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`)
  const ageDays = Math.round((todayMs - dayMs) / (24 * 60 * 60 * 1000))
  return RETENTION_DAYS - ageDays
}

/**
 * Runs one gate pass, recording that it ran (#1137).
 *
 * The record is opened BEFORE any measurement and closed in a `finally`, which
 * is the whole mechanism rather than tidiness: a pass killed partway leaves a
 * row with no ending, and that absence does not expire the way the KV heartbeat
 * does. Until this, the gate was the one archive job writing nothing to
 * `job_runs` (measured on production 2026-09-03: 422 rows, one job name), so a
 * pass cut short by a disconnecting caller (#1129) was indistinguishable from a
 * clean one, and days carrying readings six days apart all read as measured.
 *
 * The ending carries days measured out of days attempted, so a partial pass
 * reads as partial rather than as a smaller clean one, and it has its own
 * outcome for the same reason (L11).
 */
export async function runArchiveGate(
  env: Env,
  supabase: SupabaseClient,
  deps: GateDeps = {},
): Promise<GateRunSummary> {
  // The wrapper owns opening the record, the `finally`, and the killed-versus-
  // threw distinction that rests on it. This pass only says what its own
  // outcome means (#1251).
  return withJobRun(
    supabase,
    ARCHIVE_GATE_JOB,
    async (handle) => ({ ...(await gatePass(env, supabase, deps)), runId: handle.id }),
    (summary) => ({
      // Three outcomes, because they ask for three different things: nothing,
      // a look at the days that failed, and a look at why the pass could not
      // start at all.
      outcome: summary.results.length === 0 && summary.failed ? 'failed' : summary.failed ? 'partial' : 'ok',
      detail: summary.detail,
      summary: {
        daysConsidered: summary.daysConsidered,
        daysStamped: summary.daysStamped,
        daysMeasured: summary.daysMeasured,
        daysDeletable: summary.daysDeletable,
        daysErrored: summary.results.filter((r) => r.error !== null).length,
        daysRefused: summary.results.filter((r) => r.error === null && r.refusals.length > 0).length,
        daysBeneathTheGate: summary.daysBeneathTheGate,
        cost: summary.cost,
      },
    }),
  )
}

async function gatePass(
  env: Env,
  supabase: SupabaseClient,
  deps: GateDeps = {},
): Promise<GateRunSummary> {
  const now = (deps.now ?? (() => new Date()))()
  const startedMs = Date.now()
  // Counted where each call is ISSUED, never derived afterwards from the day
  // count. A budget that counts only some of its consumers reports headroom
  // while the limit is breached, which this codebase has already been bitten by
  // (#965).
  const used = { snowflake: 0, postgres: 0 }
  const rawQuery =
    deps.querySnowflake ??
    (async (statement: string, bindings?: unknown[]) => {
      const response = await executeStatement(archiveConfig(env, 'reader'), statement, bindings)
      return response.data ?? []
    })
  const query = async ({ statement, bindings }: ArchiveQuery): Promise<unknown[][]> => {
    used.snowflake += 1
    return rawQuery(statement, bindings)
  }
  const costNow = (daysMeasured: number): GateRunCost => {
    const subrequests = used.snowflake + used.postgres
    return {
      durationMs: Date.now() - startedMs,
      subrequests,
      snowflakeStatements: used.snowflake,
      postgresCalls: used.postgres,
      msPerDay: daysMeasured > 0 ? Math.round((Date.now() - startedMs) / daysMeasured) : null,
      subrequestsPerDay: daysMeasured > 0 ? Math.round(subrequests / daysMeasured) : null,
    }
  }

  used.postgres += 1
  const progress = await supabase
    .from('execution_archive_progress')
    .select('watermark_hour')
    .eq('stream', ARCHIVE_STREAM)
    .maybeSingle()
  if (progress.error) {
    const detail = `the archive watermark could not be read: ${formatErr(progress.error)}`
    await notifyExportFailure(supabase, ARCHIVE_GATE_JOB, [detail], env.IDEMPOTENCY, ARCHIVE_GATE_UNREADABLE_REMEDY)
    return {
      cost: costNow(0),
      daysConsidered: 0, daysAvailable: 0, runId: null, daysStamped: 0, daysBeneathTheGate: [],
      daysMeasured: 0, daysDeletable: 0, results: [], failed: true, detail,
    }
  }
  const stored = (progress.data as { watermark_hour?: unknown } | null)?.watermark_hour
  const watermarkHour = typeof stored === 'string' ? stored : null

  const available = candidateDays({ watermarkHour, now })
  const candidates = restrictCandidates(available, deps.restrictDays)

  // Ask the data as well as the arithmetic. The two answers to "which days
  // exist" were derived by different methods and agreed only while somebody kept
  // them agreeing: on 2026-08-23 the retention constant said 7 while the purge
  // jobs said 9, and the two lists began on different days (#1025). Compared
  // against the FULL candidate list, never the restricted chunk, or every chunk
  // would report the days outside it as missing.
  let beneath: string[] = []
  if (available.length > 0) {
    const oldestConsidered = available[0]
    const from = new Date(Date.parse(`${oldestConsidered}T00:00:00.000Z`) - LOOKBACK_DAYS * 86400000)
      .toISOString()
      .slice(0, 10)
    const readHeld = deps.daysHeld ?? ((range: { from: string; to: string }) => daysHeldInPostgres(supabase, range))
    // A failed read here must not fail the pass: this is a comparison ABOUT the
    // gate, and a watchdog that shares the abort behaviour of the work it watches
    // takes the work down with it (L71).
    try {
      const held = await readHeld({ from, to: oldestConsidered })
      // One existence query per day in the window, issued by the shared reader.
      used.postgres += daysBetween(from, oldestConsidered).length
      beneath = daysBeneathTheGate(held, available)
    } catch (err) {
      console.error(`[archive-gate] could not check for days beneath the gate: ${formatErr(err)}`)
    }
  }

  // A day the purge has already emptied is stamped `executions_truncated_at` in
  // the same transaction as the TRUNCATE (#1196). Measuring it again would read
  // zero executions against the archive's full count and refuse as a surplus,
  // about a deletion that has already happened. So stamped candidates are
  // skipped, and the stamp itself is what keeps them verified for the step rule
  // and the reaper. A failed read here is a failed run, not an empty set: an
  // empty set would measure every stamped day and alert on each (L98).
  used.postgres += 1
  const stampedRead = await supabase
    .from('execution_archive_days')
    .select('archive_day')
    .in('archive_day', candidates)
    .not('executions_truncated_at', 'is', null)
  if (stampedRead.error) {
    const detail = `the stamped days could not be read: ${formatErr(stampedRead.error)}`
    await notifyExportFailure(supabase, ARCHIVE_GATE_JOB, [detail], env.IDEMPOTENCY, ARCHIVE_GATE_UNREADABLE_REMEDY)
    return {
      cost: costNow(0),
      daysConsidered: candidates.length, daysAvailable: available.length, runId: null, daysStamped: 0,
      daysBeneathTheGate: beneath, daysMeasured: 0, daysDeletable: 0, results: [], failed: true, detail,
    }
  }
  const stamped = new Set(
    ((stampedRead.data as Array<{ archive_day: unknown }> | null) ?? []).map((r) => String(r.archive_day)),
  )
  const days = candidates.filter((d) => !stamped.has(d))
  // Days beneath the gate measured again (#2085), oldest first and AFTER the
  // candidates, so they never delay a day closer to deletion. A restricted run
  // sees only its chunk and leaves them to the full nightly pass.
  const restricted = deps.restrictDays !== undefined
  const remeasured = restricted
    ? []
    : [...beneath].sort().slice(0, deps.remeasureBeneath ?? BENEATH_REMEASURE_PER_PASS)
  const remeasuredSet = new Set(remeasured)
  const results: GateDayResult[] = []

  for (const day of [...days, ...remeasured]) {
    const daysLeft = daysLeftFor(day, now)
    try {
      const measurement = await measureDay(() => { used.postgres += 1 }, supabase, day, query, now)
      used.postgres += 1
      const record = await supabase.rpc('record_archive_day_measurement', {
        p_day: day,
        p_pg_execution_count: measurement.pgExecutionCount,
        p_pg_step_count: measurement.pgStepCount,
        p_orphan_execution_count: measurement.orphanExecutionCount,
        p_orphan_step_count_seen: measurement.orphanStepCountSeen,
        p_orphan_sample_size: measurement.orphanSampleSize,
        p_hours_recorded: measurement.hoursRecorded,
        p_hours_execution_count: measurement.hoursExecutionCount,
        p_sf_execution_count: measurement.sfExecutionCount,
        p_sf_step_count: measurement.sfStepCount,
        p_erased_execution_count: measurement.erasedExecutionCount,
        p_incomplete_count: measurement.incompleteCount,
        p_probe_sampled: measurement.probeSampled,
        p_probe_ok: measurement.probeOk,
        p_probe_failure_reason: measurement.probeFailureReason,
      })
      if (record.error) throw new Error(`recording the measurement failed: ${formatErr(record.error)}`)

      results.push({
        archiveDay: day,
        measurement,
        refusals: refusalsFor(measurement, { archiveDay: day, now }),
        daysLeft,
        error: null,
      })
    } catch (err) {
      // One day failing must not stop the others, and above all must not stop
      // the days CLOSER to deletion from being measured. A day that could not be
      // measured keeps whatever row it had, which ages into a stale refusal on
      // its own rather than being overwritten with a fabricated one.
      results.push({ archiveDay: day, measurement: null, refusals: [], daysLeft, error: formatErr(err) })
    }
  }

  const measured = results.filter((r) => r.error === null)
  const deletableDays = measured.filter((r) => r.refusals.length === 0)

  // Recorded for every day, alerted only for the days close enough to deletion
  // that somebody has to act. A refusal that CLEARS ITSELF can wait for that
  // runway rule, because saying so with a fortnight left is noise.
  //
  // TWO REFUSALS CLEAR THEMSELVES NEVER, and both are reported at once instead.
  //
  // `never-archived`: the hourly walk does not go back for a day it has passed,
  // so the day stays uncovered until somebody re-archives it, and it is
  // recoverable only until its partition is purged (#1016).
  //
  // `incomplete-rows`: this list used to exclude it, on the reasoning that the
  // amend pass had a three day floor and would catch up. There is no amend
  // pass. #932 closed that question on two measurements over 1.4 million
  // executions, and nothing else revisits an archived hour, so an incomplete
  // row stays incomplete until the day is re-archived (#871). Waiting for the
  // last three days to mention either one spends the runway that makes it
  // fixable, which is the whole point of reporting it at all.
  const CLEARS_ITSELF_NEVER = ['never-archived', 'incomplete-rows']
  const alwaysReport = (r: GateDayResult): boolean =>
    r.refusals.some((x) => CLEARS_ITSELF_NEVER.includes(x.code))
  const urgent = results.filter(
    (r) =>
      // A re-measured day beneath the gate is past its purge, so anything it
      // refused is reported, and its own reading replaces the stored status.
      remeasuredSet.has(r.archiveDay)
        ? r.refusals.length > 0 || r.error !== null
        : (r.daysLeft <= ALERT_WHEN_DAYS_LEFT && (r.refusals.length > 0 || r.error !== null)) || alwaysReport(r),
  )
  // A day whose last reading cannot vouch for it either way, as opposed to one
  // whose reading shows the archive short. The first is "not confirmed", the
  // second "not fully backed up": a message may claim only what was measured (L11).
  const UNCONFIRMED = ['never-measured', 'stale-measurement']
  const atRisk: HeldDay[] = urgent.map((r): HeldDay => {
    if (r.error !== null) return { day: r.archiveDay, kind: 'unmeasured', detail: r.error }
    const detail = r.refusals.map((x) => x.message).join('; ')
    if (r.refusals.every((x) => UNCONFIRMED.includes(x.code))) return { day: r.archiveDay, kind: 'unmeasured', detail }
    // Re-archiving adds rows, so it cannot clear a day whose only fault is a
    // surplus; every other refusal is filled by re-archiving the day.
    const surplusOnly = r.refusals.every((x) => x.code === 'executions-surplus')
    return { day: r.archiveDay, kind: surplusOnly ? 'surplus' : 'refused', detail }
  })

  // Days older than anything the gate considers (#1025). The purge should have
  // taken them; whether that matters depends on whether they were backed up.
  const notCleanedUp: string[] = []
  // A day measured again this pass is judged on that reading; only the rest read
  // their stored status (#2085).
  const unmeasuredBeneath = beneath.filter((d) => !remeasuredSet.has(d))
  for (const day of remeasured) {
    const r = results.find((x) => x.archiveDay === day)
    // Verified tonight, so tonight's cleanup can take it; reported as not
    // cleaned up only once it has outlived the silent nights, as before.
    if (r !== undefined && r.error === null && r.refusals.length === 0 && purgesMissed(day, now) > CLEANUP_SILENT_NIGHTS) {
      notCleanedUp.push(day)
    }
  }
  if (unmeasuredBeneath.length > 0) {
    let status: Map<string, BeneathStatus> | null = null
    // Carried into the line, so the fix's "the read named above" names one (#835).
    let statusError: string | null = null
    try {
      used.postgres += 1
      status = await (deps.beneathStatus ?? ((d: string[]) => readBeneathStatus(supabase, d)))(unmeasuredBeneath)
    } catch (err) {
      statusError = formatErr(err)
      console.error(`[archive-gate] could not read whether the days beneath the gate are backed up: ${statusError}`)
    }
    for (const day of unmeasuredBeneath) {
      const known = status?.get(day)
      if (known === undefined) atRisk.push({ day, kind: 'beneath-unknown', detail: statusError })
      else if (!known.backedUp) atRisk.push({ day, kind: 'beneath-short', detail: null })
      // Backed up, so nothing is lost, and silent for the first nights: a lock
      // lost to a busy minute is taken the next night (Dan, 2026-10-02).
      else if (purgesMissed(day, now) > CLEANUP_SILENT_NIGHTS) notCleanedUp.push(day)
    }
  }
  atRisk.sort((a, b) => a.day.localeCompare(b.day))

  const atRiskLines = atRisk.map(heldLine)

  // What the cleanup recorded about each day, read only when there is one to
  // explain. A failed read is said as such, never as "nothing recorded" (L215).
  let purgeRecords: Map<string, PurgeRecord> | null = null
  if (notCleanedUp.length > 0) {
    try {
      used.postgres += notCleanedUp.length
      purgeRecords = await (deps.lastPurge ?? ((d: string[]) => readLastPurge(supabase, d)))(notCleanedUp)
    } catch (err) {
      console.error(`[archive-gate] could not read the cleanup record: ${formatErr(err)}`)
    }
  }
  const cleanupLines = notCleanedUp.map((day) => {
    const record = purgeRecords?.get(day)
    const said =
      purgeRecords === null
        ? "the cleanup's record of it could not be read"
        : record === undefined
          ? 'no cleanup has recorded anything about it'
          : `the last cleanup recorded ${record.outcome}${record.reason === null ? '' : ` (${record.reason})`} for it`
    return (
      `${spokenDay(day)} is still in the database. It is fully backed up in Snowflake, so nothing is lost. ` +
      `It has outlived ${purgesMissed(day, now)} nightly cleanups, and ${said}.`
    )
  })

  const cost = costNow(measured.length)
  const costLines = costWarnings(cost, measured.length)
  // Three alerts, each paging and clearing on its own, so a title can never sit
  // above a line it misdescribes. An empty list clears its alert (#1720).
  //
  // A RESTRICTED run only sees its chunk, so days OUTSIDE it may still be at risk,
  // not cleaned up, or costly. It must never CLEAR a condition the full nightly
  // pass owns: it adds only, paging when its chunk has something and staying
  // silent (skipping the empty-list clear) when it does not (#1783). The full
  // pass stays the authority that clears. The `postsOrAdds` guards are written
  // inline rather than through a helper so each notifyExportFailure keeps its
  // literal job name, which the export-alert clear-coverage guard reads (#1967).
  const postsOrAdds = (lines: string[]): boolean => !restricted || lines.length > 0
  if (postsOrAdds(atRiskLines)) {
    await notifyExportFailure(supabase, ARCHIVE_GATE_JOB, atRiskLines, env.IDEMPOTENCY, heldRemedy(atRisk))
  }
  if (postsOrAdds(cleanupLines)) {
    await notifyExportFailure(
      supabase,
      ARCHIVE_GATE_CLEANUP_JOB,
      cleanupLines,
      env.IDEMPOTENCY,
      ARCHIVE_GATE_NOT_CLEANED_UP_REMEDY,
    )
  }
  if (postsOrAdds(costLines)) {
    await notifyExportFailure(supabase, ARCHIVE_GATE_COST_JOB, costLines, env.IDEMPOTENCY, ARCHIVE_GATE_COST_REMEDY)
  }

  const detail =
    `measured ${measured.length} of ${candidates.length} candidate days ` +
    `(${stamped.size} already emptied and skipped), ${deletableDays.length} verified, ${atRisk.length} held back, ` +
    `${notCleanedUp.length} not cleaned up`
  console.log(`[archive-gate] ${detail}`)
  // Printed as well as recorded, so a run being watched live shows its cost
  // without a query, and recorded as well as printed, because stdout reaches its
  // reader only while the work runs where somebody is looking (L325).
  console.log(
    `[archive-gate] cost: ${cost.durationMs} ms, ${cost.subrequests} subrequests ` +
      `(snowflake ${cost.snowflakeStatements}, postgres ${cost.postgresCalls}), ` +
      `${cost.msPerDay ?? 0} ms and ${cost.subrequestsPerDay ?? 0} calls per day measured`,
  )
  for (const r of results) {
    if (r.error !== null) console.error(`[archive-gate] ${r.archiveDay}: ${r.error}`)
    else if (r.refusals.length > 0) {
      console.log(`[archive-gate] ${r.archiveDay} refused: ${r.refusals.map((x) => x.code).join(', ')}`)
    }
  }

  return {
    cost,
    daysConsidered: candidates.length,
    daysAvailable: available.length,
    runId: null,
    daysBeneathTheGate: beneath,
    daysStamped: stamped.size,
    daysMeasured: measured.length,
    daysDeletable: deletableDays.length,
    results,
    failed: results.some((r) => r.error !== null),
    detail,
  }
}
