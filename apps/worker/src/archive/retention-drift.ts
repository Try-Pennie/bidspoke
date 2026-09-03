/**
 * Comparing the execution purge jobs against the retention the repo declares
 * (#1017).
 *
 * How long execution data is kept is stated in three independent places: the
 * `cron.job` command that truncates an expired partition, the one that drops it,
 * and `RETENTION_DAYS` in `archive/candidate-days.ts`. Nothing compared them.
 *
 * They are not three copies of a preference. Each governs a different half of one
 * safety property: the jobs decide when data is destroyed, and the constant
 * decides how urgently the deletion gate reports a day it has not yet vouched
 * for. So a disagreement is silently wrong in whichever direction it goes. Jobs
 * shorter than the constant destroy data before the gate has finished checking
 * it. The constant shorter than the jobs (the state on 2026-09-03, 7 against 21)
 * made the gate tell the team a day was one night from deletion when it had
 * fifteen.
 *
 * Keyed on job NAME, never on `jobid`. Both jobs have already been recreated
 * once: #1013 records them as jobids 20 and 21 and they are 41 and 42 today, so a
 * check keyed on the id would have gone blind at the moment somebody rebuilt the
 * thing it watches (L15).
 *
 * It decides, it does not act.
 */

/** The pg_cron jobs that destroy execution partitions, by name. */
export const TRUNCATE_JOB = 'purge-old-execution-partitions'
export const REAP_JOB = 'reap-empty-execution-partitions'
export const EXECUTION_PURGE_JOBS = [TRUNCATE_JOB, REAP_JOB] as const

export interface ObservedPurgeJob {
  jobname: string
  /** False when the job exists but is switched off, which destroys nothing at all. */
  active: boolean
  /** Days of retention read out of the job's command, or null when it could not be parsed. */
  retentionDays: number | null
  /** The command as stored, so a finding can quote what it actually saw. */
  command: string
}

export interface RetentionDifference {
  code: string
  message: string
}

/**
 * Every way the purge jobs and the declared window can fail to agree.
 *
 * Each cause gets its own code and its own sentence, because a message may only
 * claim what its check measured (L11). In particular an unreadable command has
 * not been measured at all, so it is never also reported as a mismatch: that
 * would be asserting a number this function does not have.
 */
export function retentionDifferences(
  observed: ObservedPurgeJob[],
  declaredDays: number,
): RetentionDifference[] {
  const differences: RetentionDifference[] = []
  const byName = new Map(observed.map((j) => [j.jobname, j]))

  for (const jobname of EXECUTION_PURGE_JOBS) {
    const job = byName.get(jobname)

    // An absent job is reported rather than skipped. No observation is not the
    // same as agreement, and an empty read would otherwise pass as a clean check
    // (L98).
    if (job === undefined) {
      differences.push({
        code: 'job-missing',
        message:
          `the pg_cron job ${jobname} was not found, so nothing could be read about when execution ` +
          `partitions are destroyed`,
      })
      continue
    }

    if (!job.active) {
      differences.push({
        code: 'job-inactive',
        message:
          `the pg_cron job ${jobname} exists but is disabled, so its ${String(job.retentionDays)} day window ` +
          `is not in force and execution retention is unbounded`,
      })
      continue
    }

    if (job.retentionDays === null) {
      differences.push({
        code: 'retention-unreadable',
        message:
          `the retention window could not be read out of ${jobname}'s command (${job.command}), so it ` +
          `cannot be compared against the ${declaredDays} days the code declares`,
      })
      continue
    }

    if (job.retentionDays !== declaredDays) {
      differences.push({
        code: 'retention-disagrees',
        message:
          `${jobname} destroys execution partitions after ${job.retentionDays} days, but the code declares ` +
          `${declaredDays}, so the deletion gate is reporting the wrong deadline`,
      })
    }
  }

  // The pair that can destroy data, compared against each other as well as
  // against the code. Truncating a partition earlier than it is reaped is a
  // different fault from either job differing from the constant, and it is
  // invisible to a check that only ever compares each job to the code.
  const windows = EXECUTION_PURGE_JOBS.map((n) => byName.get(n)).filter(
    (j): j is ObservedPurgeJob => j !== undefined && j.active && j.retentionDays !== null,
  )
  if (windows.length === EXECUTION_PURGE_JOBS.length && windows[0]?.retentionDays !== windows[1]?.retentionDays) {
    differences.push({
      code: 'jobs-disagree',
      message:
        `the two purge jobs disagree with each other: ${windows[0]?.jobname} uses ` +
        `${String(windows[0]?.retentionDays)} days and ${windows[1]?.jobname} uses ` +
        `${String(windows[1]?.retentionDays)}`,
    })
  }

  return differences
}
