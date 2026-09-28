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
 * As of 2026-09-28.
 *
 * One job, `logpush-better-stack-logs` (1740821) to Better Stack. Its field list
 * was narrowed on 2026-09-09 from nine fields to these seven, removing `Event`
 * and `Logs`, which had been exporting applicant SSNs and request headers to an
 * external vendor (#1007, #1214). The R2 job was deleted the same day (#1008).
 *
 * Logpush was switched off for the whole account from 2026-09-26 (#1613), and
 * this job came back when it was switched on again on or just before
 * 2026-09-28. Dan chose that day to keep it rather than delete it.
 *
 * Every field below is metadata about which script ran and when. If a future
 * change needs one of the PII bearing fields, that is a decision about sending
 * consumer data to a third party, and it belongs in an ADR rather than in an
 * edit to this list.
 */
export const EXPECTED_LOGPUSH_JOBS: readonly ExpectedLogpushJob[] = [
  {
    id: 1740821,
    name: 'logpush-better-stack-logs',
    destinationHost: 's2537399.eu-fsn-3.betterstackdata.com',
    dataset: 'workers_trace_events',
    enabled: true,
    fieldNames: [
      'DispatchNamespace',
      'Entrypoint',
      'EventTimestampMs',
      'EventType',
      'ScriptName',
      'ScriptTags',
      'ScriptVersion',
    ],
  },
]

/**
 * How long a job may go without a successful push before it is reported.
 *
 * The live job pushes continuously at `frequency: high`, so a day of silence is
 * not a slow patch, it is a job that has stopped.
 */
export const DELIVERY_STALE_MS = 24 * 60 * 60 * 1000
