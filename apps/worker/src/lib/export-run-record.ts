/**
 * A durable record of every export and purge run (#745).
 *
 * The summary each run returns (rows exported, rows purged, errors) used to be
 * only console logged, so it was gone once the Cloudflare log window rolled.
 * Establishing that the 2026-08-11 16:37 export failure was a one-off took a
 * histogram over `lead_sightings.exported_at` and spotting a missing bucket, and
 * the Slack alert cannot stand in for the record because it is held back and
 * cooled down by design.
 *
 * Each run now opens a `job_runs` row before it starts and closes it with its
 * summary, whichever way it ends (`withJobRun`), so a run the platform kills
 * leaves an open row, which is itself the evidence (#960). The sightings export's
 * job name is the id its cron heartbeat already uses, so one name answers for it
 * everywhere; the Achieve export has no heartbeat and takes its own. The purge is
 * pg_cron's (#541) and records itself as `sightings-buffer-purge`.
 *
 * The last runs of one job, newest first:
 *
 *   select started_at, finished_at, outcome, detail, summary
 *   from job_runs where job = 'sightings-export'
 *   order by started_at desc limit 24;
 *
 * VOLUME: twelve export runs and one Achieve run a day from here, plus the hourly
 * pg_cron purge's 24, about 37 rows a day on top of the archive's. `job_runs` is
 * already listed as a big table and every reader of it is bounded.
 *
 * THIS RAISES NO ALERT. The export and purge alerts already exist, and a second
 * alert on the same cause under a second name teaches people to ignore both
 * (L11). What was missing was the record.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { withJobRun, type JobRunEnding } from './job-run-record'
import { classifyExportError } from './export-error-hints'

/** The job_runs names; the sightings ones match their cron heartbeat ids. */
export const EXPORT_JOBS = {
  sightingsExport: 'sightings-export',
  achieveExport: 'achieve-export',
} as const

export type ExportJob = (typeof EXPORT_JOBS)[keyof typeof EXPORT_JOBS]

/**
 * What a run's own summary means as a run record. A run that reported no error
 * is `ok`, and one that reported any is `failed`, with the errors in `detail`
 * and their classes alongside, so a recurrence can be counted by class without
 * parsing prose. The counts are kept exactly as the run reported them.
 */
export function exportRunEnding(summary: { errors: string[] } & Record<string, unknown>): JobRunEnding {
  const errorClasses = [...new Set(summary.errors.map((e) => classifyExportError(e)))]
  const recorded: Record<string, unknown> = { ...summary, error_classes: errorClasses }
  if (summary.errors.length === 0) return { outcome: 'ok', summary: recorded }
  return { outcome: 'failed', detail: summary.errors.join('; '), summary: recorded }
}

/**
 * Runs one export or purge inside its run record. The record never fails the
 * run: opening and closing it swallow their own errors (job-run-record.ts), and
 * an error from the run itself is rethrown after the row is closed as `threw`.
 */
export function recordExportRun<T extends { errors: string[] }>(
  supabase: SupabaseClient,
  job: ExportJob,
  work: () => Promise<T>,
): Promise<T> {
  return withJobRun(supabase, job, () => work(), (result) => exportRunEnding(result as T & Record<string, unknown>))
}
