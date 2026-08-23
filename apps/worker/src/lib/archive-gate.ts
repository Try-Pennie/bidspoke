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
import { notifyExportFailure } from './export-alerts'
import { executeStatement, escapeSqlLiteral } from './snowflake'
import { archiveConfig, ARCHIVE_DATABASE, ARCHIVE_SCHEMA, ARCHIVE_TABLE } from './archive-snowflake'
import { ARCHIVE_STREAM } from './execution-archive'
import { decodeBundle } from '../archive/bundle'
import { candidateDays, RETENTION_DAYS } from '../archive/candidate-days'
import { refusalsFor, type DayMeasurement, type DayRefusal } from '../archive/gate'
import type { Env } from '../index'

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
 * day old that refuses for `incomplete-rows` is NORMAL: the amend pass has a
 * three day floor, so recently archived days routinely carry non-terminal rows
 * that resolve on their own. Alerting on those daily would train everyone to
 * ignore the alert, and would be loudest for the days with the most slack.
 *
 * Urgency here is what the reader must do and how soon (L112). At 3 days of
 * runway there is still time to re-archive an hour, resolve a refusal or push
 * the retention out, and the alert says which.
 */
export const ALERT_WHEN_DAYS_LEFT = 3

export interface GateDayResult {
  archiveDay: string
  measurement: DayMeasurement | null
  refusals: DayRefusal[]
  /** Days until this day's partition is dropped, so the alert can be about urgency. */
  daysLeft: number
  /** Set when the day could not be measured at all, which is not the same as refusing. */
  error: string | null
}

export interface GateRunSummary {
  daysConsidered: number
  daysMeasured: number
  daysDeletable: number
  results: GateDayResult[]
  failed: boolean
  detail: string
}

export interface GateDeps {
  /** Returns the statement's rows. Injected so a test drives the real logic against real shapes. */
  querySnowflake?: (statement: string) => Promise<unknown[][]>
  now?: () => Date
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
function countsStatement(day: string): string {
  return (
    'SELECT COUNT(*), COALESCE(SUM(step_count), 0), COALESCE(SUM(incomplete), 0) FROM (' +
    '  SELECT execution_id, MAX(step_count) AS step_count,' +
    '         MAX(CASE WHEN archived_incomplete THEN 1 ELSE 0 END) AS incomplete' +
    `  FROM ${QUALIFIED_TABLE} WHERE archive_day = '${escapeSqlLiteral(day)}'::DATE` +
    '  GROUP BY execution_id)'
  )
}

function bundlesStatement(day: string, executionIds: string[]): string {
  const list = executionIds.map((id) => `'${escapeSqlLiteral(id)}'`).join(',')
  return (
    'SELECT execution_id, trace_id, bundle_gz_b64 FROM (' +
    '  SELECT execution_id, trace_id, bundle_gz_b64,' +
    '         ROW_NUMBER() OVER (PARTITION BY execution_id ORDER BY archived_at_utc DESC) AS rn' +
    `  FROM ${QUALIFIED_TABLE}` +
    `  WHERE archive_day = '${escapeSqlLiteral(day)}'::DATE AND execution_id IN (${list})` +
    ') WHERE rn = 1'
  )
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
  query: (statement: string) => Promise<unknown[][]>,
): Promise<{ sampled: number; ok: boolean; reason: string | null }> {
  if (sample.length === 0) return { sampled: 0, ok: true, reason: null }

  const rows = await query(bundlesStatement(day, sample.map((r) => r.execution_id)))
  const byId = new Map<string, { traceId: string | null; wire: string }>()
  for (const row of rows) {
    const id = row[0]
    if (typeof id !== 'string') continue
    byId.set(id, { traceId: typeof row[1] === 'string' ? row[1] : null, wire: String(row[2]) })
  }

  for (const expected of sample) {
    const found = byId.get(expected.execution_id)
    if (found === undefined) {
      return { sampled: sample.length, ok: false, reason: `no bundle at all for ${expected.execution_id}` }
    }
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
  supabase: SupabaseClient,
  day: string,
  query: (statement: string) => Promise<unknown[][]>,
  now: Date,
): Promise<DayMeasurement> {
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

export async function runArchiveGate(
  env: Env,
  supabase: SupabaseClient,
  deps: GateDeps = {},
): Promise<GateRunSummary> {
  const now = (deps.now ?? (() => new Date()))()
  const query =
    deps.querySnowflake ??
    (async (statement: string) => {
      const response = await executeStatement(archiveConfig(env, 'reader'), statement)
      return response.data ?? []
    })

  const progress = await supabase
    .from('execution_archive_progress')
    .select('watermark_hour')
    .eq('stream', ARCHIVE_STREAM)
    .maybeSingle()
  if (progress.error) {
    const detail = `the archive watermark could not be read: ${formatErr(progress.error)}`
    await notifyExportFailure(supabase, ARCHIVE_GATE_JOB, [detail], env.IDEMPOTENCY)
    return { daysConsidered: 0, daysMeasured: 0, daysDeletable: 0, results: [], failed: true, detail }
  }
  const stored = (progress.data as { watermark_hour?: unknown } | null)?.watermark_hour
  const watermarkHour = typeof stored === 'string' ? stored : null

  const days = candidateDays({ watermarkHour, now })
  const results: GateDayResult[] = []

  for (const day of days) {
    const daysLeft = daysLeftFor(day, now)
    try {
      const measurement = await measureDay(supabase, day, query, now)
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
  // that somebody has to act. A day one day old refusing for incomplete-rows is
  // normal: the amend pass has a three day floor.
  const urgent = results.filter(
    (r) => r.daysLeft <= ALERT_WHEN_DAYS_LEFT && (r.refusals.length > 0 || r.error !== null),
  )
  const errors = urgent.map((r) =>
    r.error !== null
      ? `${r.archiveDay} could not be measured (${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} before its partition is dropped): ${r.error}`
      : `${r.archiveDay} is not verified with ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'} left: ${r.refusals.map((x) => x.message).join('; ')}`,
  )
  await notifyExportFailure(supabase, ARCHIVE_GATE_JOB, errors, env.IDEMPOTENCY)

  const detail =
    `measured ${measured.length} of ${days.length} candidate days, ` +
    `${deletableDays.length} verified, ${urgent.length} urgent`
  console.log(`[archive-gate] ${detail}`)
  for (const r of results) {
    if (r.error !== null) console.error(`[archive-gate] ${r.archiveDay}: ${r.error}`)
    else if (r.refusals.length > 0) {
      console.log(`[archive-gate] ${r.archiveDay} refused: ${r.refusals.map((x) => x.code).join(', ')}`)
    }
  }

  return {
    daysConsidered: days.length,
    daysMeasured: measured.length,
    daysDeletable: deletableDays.length,
    results,
    failed: results.some((r) => r.error !== null),
    detail,
  }
}
