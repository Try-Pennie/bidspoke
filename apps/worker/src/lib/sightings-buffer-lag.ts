/**
 * Daily watchdog for the sightings buffer falling behind (#463).
 *
 * lead_sightings, lead_sighting_bids and achieve_evaluations are a write buffer:
 * exported to Snowflake, then purged a day later. They fall behind in two ways,
 * and until now nothing measured either:
 *
 *   WAITING  rows the export should have shipped by now and has not;
 *   OVERDUE  rows exported long enough ago that the purge should have removed
 *            them, still in Supabase.
 *
 * On 2026-07-01 the purge had silently been behind for about a month (2.3M
 * lead_sightings rows) and surfaced only when a DELETE hit the statement timeout.
 * The per-run alerts catch a run that FAILS; this catches the buffer drifting
 * while every run reports success, and it keeps working if the purge moves into
 * the database (#541), where the Worker would no longer see it at all.
 *
 * It judges the OUTCOME the export and purge are responsible for, read through
 * `sightings_buffer_lag` (supabase/migrations/20260925230000_sightings_buffer_lag.sql),
 * whose filters are the export's and the purge's own.
 *
 * HEALTHY IS ZERO. Measured 2026-09-25 at 21:00 UTC: no table had a single row
 * waiting past its export window or past its purge window, so any count here is
 * a real departure. The tolerances only absorb the rows a strand drain finalizes
 * late (a sighting that becomes exportable up to 26 hours after it started).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'

type KvLike = Parameters<typeof notifyExportFailure>[3]

export const SIGHTINGS_BUFFER_JOB = 'Lead sightings buffer'
/**
 * A table the check could not read goes to its OWN job, never the lag one.
 * notifyExportFailure holds a first failure silently when every line looks
 * transient (a statement timeout does), so on the lag job a failed read would be
 * held for a whole day, and mixed with a real finding it would change how that
 * finding is judged. Measuring and finding are different facts (L11).
 */
export const SIGHTINGS_BUFFER_UNMEASURED_JOB = 'Lead sightings buffer unmeasured'

export interface BufferRule {
  table: 'lead_sightings' | 'lead_sighting_bids' | 'achieve_evaluations'
  /** A row older than this that has not exported is late. */
  exportWithinHours: number
  /** A row exported longer ago than this should have been purged. */
  purgeWithinHours: number
  /** How many late rows are tolerated before it reports. */
  tolerance: number
}

/**
 * Why each number is what it is.
 *
 * Sightings and bids export every two hours (37 of every even hour), so six
 * hours is two missed runs plus a margin; the in-run case is #749's. The purge
 * waits 24 hours after export and runs every two hours per table, so a row
 * exported 30 hours ago should be gone. 500 rows absorbs strands the drain
 * finalizes late; a stalled export adds thousands an hour.
 *
 * The Achieve export runs once a day at 09:00 UTC, so a row can wait up to a day
 * for it; 30 hours means a run was missed. Its purge follows that export and
 * needs the 24 hour grace, so a row can stay just over two days; 54 hours means
 * a purge was missed. It carries a few hundred rows a day, so any late row counts.
 */
export const BUFFER_RULES: readonly BufferRule[] = [
  { table: 'lead_sightings', exportWithinHours: 6, purgeWithinHours: 30, tolerance: 500 },
  { table: 'lead_sighting_bids', exportWithinHours: 6, purgeWithinHours: 30, tolerance: 500 },
  { table: 'achieve_evaluations', exportWithinHours: 30, purgeWithinHours: 54, tolerance: 0 },
]

/**
 * Each count stops here, so a huge backlog is reported as "at least" rather than
 * timing the read out on exactly the day it matters.
 */
export const BUFFER_LAG_CAP = 10_000

const HOUR_MS = 3600_000

interface LagRow {
  waiting_rows: number
  oldest_waiting: string | null
  overdue_rows: number
  oldest_exported_at: string | null
}

const count = (n: number) => (n >= BUFFER_LAG_CAP ? `at least ${BUFFER_LAG_CAP}` : `${n}`)

/** What one run found, and which tables it could not read. */
export interface BufferMeasurement {
  findings: string[]
  unmeasured: string[]
}

/**
 * One line per finding, and a separate line per table it could not read. An
 * unreadable table is never an empty answer: an empty list is what clears the
 * alert, and a read that failed has measured nothing (L215).
 */
export async function measureSightingsBuffer(supabase: SupabaseClient, nowMs: number): Promise<BufferMeasurement> {
  const findings: string[] = []
  const unmeasured: string[] = []
  for (const rule of BUFFER_RULES) {
    try {
      const { data, error } = await supabase.rpc('sightings_buffer_lag', {
        p_table: rule.table,
        // The partition keys are UTC timestamps without a zone.
        p_waiting_before: new Date(nowMs - rule.exportWithinHours * HOUR_MS).toISOString().replace('Z', ''),
        p_exported_before: new Date(nowMs - rule.purgeWithinHours * HOUR_MS).toISOString(),
        p_cap: BUFFER_LAG_CAP,
      })
      if (error) throw error
      const row = (data as LagRow[] | null)?.[0]
      if (!row) throw new Error('the read returned no row')

      if (row.waiting_rows > rule.tolerance) {
        findings.push(
          `${rule.table}: ${count(row.waiting_rows)} rows have waited more than ${rule.exportWithinHours} hours to export` +
            ` (oldest from ${row.oldest_waiting} UTC)`,
        )
      }
      if (row.overdue_rows > rule.tolerance) {
        findings.push(
          `${rule.table}: ${count(row.overdue_rows)} rows were exported more than ${rule.purgeWithinHours} hours ago and are still in Supabase` +
            ` (oldest exported ${row.oldest_exported_at})`,
        )
      }
    } catch (e) {
      unmeasured.push(`${rule.table}: could not measure the buffer: ${formatErr(e)}`)
    }
  }
  return { findings, unmeasured }
}

const REMEDY: AlertRemedy = {
  consequence:
    'The sightings buffer is behind. Rows waiting to export are missing from Snowflake reporting until they ship; rows past the purge are ' +
    'already in Snowflake and only cost Supabase disk, but a backlog left to grow is what timed the purge out on 2026-07-01:',
  fixHint:
    'Waiting rows: read the last export runs (select started_at, outcome, detail, summary from job_runs where job = \'sightings-export\' ' +
    'order by started_at desc limit 12) and the export alerts; a run that failed or stopped behind says why. Rows past the purge: read the ' +
    'purge runs the same way (job sightings-buffer-purge, the pg_cron purge from #541; before it, sightings-purge and sighting-bids-purge) ' +
    'and cron.job_run_details for purge-exported-sightings. Achieve exports once a day at 09:00 UTC (job achieve-export).',
  headlineVerb: 'fell behind',
  itemNoun: { one: 'finding', many: 'findings' },
}

const UNMEASURED_REMEDY: AlertRemedy = {
  consequence:
    'The daily check could not read these tables, so it cannot say whether their export or purge is behind. It says nothing about the buffer itself:',
  fixHint:
    'Read the error on each line. A statement timeout usually clears by the next day; anything else (a missing function, a permission) means ' +
    'the check stays blind until it is fixed. The measuring function is sightings_buffer_lag.',
  headlineVerb: 'could not be measured',
  itemNoun: { one: 'table', many: 'tables' },
}

/**
 * Measures the buffer and pages on what it found.
 *
 * Findings page on the lag job, which a healthy read clears, but ONLY when every
 * table was read: clearing while one went unmeasured would clear a standing alert
 * nothing re-checked. Unreadable tables page on their own job with no alert
 * store, so the transient grace (which keys on the store) cannot hold them for a
 * day; this runs once a day, so that is at most one page a day while it stays
 * blind, and there is nothing stored to clear.
 */
export async function runSightingsBufferCheck(
  supabase: SupabaseClient,
  kv: KvLike,
  nowMs: number = Date.now(),
): Promise<BufferMeasurement> {
  const measured = await measureSightingsBuffer(supabase, nowMs)
  if (measured.findings.length > 0 || measured.unmeasured.length === 0) {
    await notifyExportFailure(supabase, SIGHTINGS_BUFFER_JOB, measured.findings, kv, REMEDY, nowMs)
  }
  if (measured.unmeasured.length > 0) {
    await notifyExportFailure(supabase, SIGHTINGS_BUFFER_UNMEASURED_JOB, measured.unmeasured, undefined, UNMEASURED_REMEDY, nowMs)
  }
  return measured
}
