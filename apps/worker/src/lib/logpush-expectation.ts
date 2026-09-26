/**
 * What Logpush is supposed to look like on the Pennie Cloudflare account (#1010).
 *
 * This is a committed expectation, not a description. Anything live that does
 * not match it is reported, because the account is SHARED with other Pennie
 * projects (#1011): someone configuring an unrelated service can change where
 * this worker's logs go without touching this repository or knowing Bidspoke
 * exists. That is not hypothetical. It is how the Better Stack destination
 * arrived and went unnoticed for months (#1007).
 *
 * No credential is committed here. The destination is compared by HOST only,
 * which is the part that says where data goes.
 */
export interface ExpectedLogpushJob {
  readonly id: number
  readonly name: string
  /** Host portion of destination_conf. Credentials and paths deliberately excluded. */
  readonly destinationHost: string
  readonly dataset: string
  readonly enabled: boolean
  /** Exactly the fields this job may export. Order is not significant. */
  readonly fieldNames: readonly string[]
}

/**
 * As of 2026-09-26: no jobs.
 *
 * Cloudflare switched Logpush off for the whole Pennie account on or just
 * before 2026-09-26, and the API now refuses the job list with `1004 logpush is
 * not enabled for this account`. Dan accepted that the same day rather than
 * re-enabling it: nothing in Bidspoke reads the Better Stack feed, execution
 * history lives in Supabase and the Snowflake archive, and Cloudflare's own log
 * viewer covers recent debugging.
 *
 * Until then there was one job, `logpush-better-stack-logs` (1740821) to
 * Better Stack, narrowed on 2026-09-09 to seven metadata fields after it had
 * been exporting applicant SSNs and request headers to that vendor (#1007,
 * #1214). The R2 job was deleted the same day (#1008).
 *
 * The check reads the not-enabled refusal as zero jobs, so this stays quiet,
 * and any job that appears is reported as unexpected. Re-adding one is a
 * decision about where this worker's logs go, and if it needs a PII bearing
 * field, about sending consumer data to a third party, which belongs in an ADR.
 */
export const EXPECTED_LOGPUSH_JOBS: readonly ExpectedLogpushJob[] = []

/**
 * How long a job may go without a successful push before it is reported.
 *
 * The live job pushes continuously at `frequency: high`, so a day of silence is
 * not a slow patch, it is a job that has stopped.
 */
export const DELIVERY_STALE_MS = 24 * 60 * 60 * 1000
