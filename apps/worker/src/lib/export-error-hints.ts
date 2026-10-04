/**
 * Classify export-failure errors so the Slack alert can say what actually broke (#542).
 *
 * The old alert ended every failure with "check Snowflake availability and the
 * export credentials", whatever the cause. During the 2026-07-01..07-03 incident
 * the real cause was Postgres statement timeouts, and that canned advice pointed
 * diagnosis at Snowflake for days. On 2026-07-09 it did the same for a transient
 * 503 that had already self-healed on the next run.
 *
 * Errors arrive here as the pre-formatted strings in `summary.errors[]`, e.g.
 * "bids export: Snowflake 503: connection termination" or
 * "sightings purge: permission denied for table lead_sightings (42501)".
 */

export type ExportErrorClass =
  | 'db_congestion'
  | 'transient_snowflake'
  | 'transient_connectivity'
  | 'missing_credential'
  | 'snowflake_auth'
  | 'snowflake_permission'
  | 'snowflake_schema'
  | 'supabase_permission'
  | 'platform_limit'
  | 'archive_run_killed'
  | 'export_behind'
  | 'call_deadline'
  | 'unknown'

export const GENERIC_FIX_HINT =
  'Check Snowflake availability and the export credentials. If it stays down, watch Supabase disk: the un-purged rows accumulate until a run succeeds.'

const FIX_HINTS: Record<Exclude<ExportErrorClass, 'unknown'>, string> = {
  missing_credential:
    'A Worker secret is not set, so the job could not authenticate. Nothing is wrong with Snowflake. Set it with `wrangler secret put <NAME> --name bidspoke-worker` and the next scheduled run picks it up.',
  db_congestion:
    'Database congestion, not Snowflake. There is no action to take: the rows retry on the next run and usually clear on their own. If it persists across runs, look for a pg_cron job colliding with the export window.',
  transient_snowflake:
    'A transient Snowflake connection failure. There is no action to take: these are retried automatically, and any rows left behind export on the next run. If it repeats across several runs, check the Snowflake status page.',
  transient_connectivity:
    'A brief connection timeout at the network edge (a Cloudflare error page, most often on the way to Supabase). There is no action to take: the rows are picked up automatically on the next run. If it repeats across consecutive runs, check the Supabase status page.',
  snowflake_auth:
    'Check the Snowflake credentials. The key pair JWT for the service user has most likely expired or been rotated.',
  snowflake_permission:
    'The Snowflake role is missing a grant on the target schema or table. Grant it in Snowflake, then re-run the export.',
  snowflake_schema:
    'Snowflake schema drift: a column the export writes is missing, renamed, or rejecting its value. Compare the Supabase and Snowflake column lists (see issue #428).',
  supabase_permission:
    'Supabase denied the export role. Check the RLS policy and the table grants for the service role.',
  platform_limit:
    "The Worker hit Cloudflare's per invocation subrequest ceiling while draining a backlog. There is no action to take: the run stopped cleanly and the next run continues from where it left off.",
  export_behind:
    'The export stopped at its own limit with rows still waiting, so it did not catch up this run. One such run straight after a failed run is normal catch-up, and is held back rather than paged. Two in a row means one run can no longer drain what arrives between runs: read the last runs in job_runs (job sightings-export) for rows per run against the measured rate in WALL_TIME_BUDGET_MS, and raise the export rate or the frequency rather than waiting.',
  call_deadline:
    'A Durable Object (a buyer ledger or counter) took longer than its deadline to answer, so this run could not measure it. There is no action to take for a single miss: the next minute asks again, and one slow answer is held back rather than paged. Two in a row means the object is refusing: check the worker logs for that object and run the drill at POST /api/admin/buyer-objects/drill.',
  archive_run_killed:
    'The previous archive invocation was terminated by the platform before it could release its lock; its job_runs row has no ending. Nothing is lost: the run that posted this took over and is archiving the hours it left, so the archive is at most one hour later than usual. No action for a single occurrence. If it repeats several times a day, read the Cloudflare cron events for bidspoke-worker (Workers and Pages, bidspoke-worker, Settings, Trigger Events) and the invocation statuses under Metrics, which name the termination.',
}

/**
 * The sentence between "reported N errors" and the error list, for the classes
 * where the renderer's default would be false (#1180).
 *
 * The renderer chooses its default by job NAME alone: a purge gets "the rows are
 * already exported", everything else gets "the rows were not exported and
 * analytics are missing them". The killed-run takeover is neither. It exports
 * nothing itself, and the run posting it is the one archiving what its
 * predecessor left, so on 2026-09-05 the alert claimed missing analytics for an
 * event that had none. Classes not listed here keep the renderer's default.
 */
const CONSEQUENCES: Partial<Record<Exclude<ExportErrorClass, 'unknown'>, string>> = {
  archive_run_killed:
    'The run posting this took over the lock and is archiving the hours its predecessor left, so nothing is missing from Snowflake beyond one hour of delay:',
}

// Order matters. Two collisions make a naive code match wrong:
//   1. A statement timeout can mention Snowflake in passing (it happens while
//      merging), so it must be matched before any Snowflake status check.
//   2. 42501 is "permission denied" in Postgres, but Snowflake pairs 42501 with
//      003001 on a missing grant. Match Snowflake's own 003001 first, and only
//      then fall through to the Postgres phrasing.
const RULES: Array<{ cls: Exclude<ExportErrorClass, 'unknown'>; test: RegExp }> = [
  // FIRST, because it is the least ambiguous cause there is and it must not be
  // read as anything else. The 2026-08-23 archive identity alert was six lines
  // saying a named secret was unset, and it still ended with "check Snowflake
  // availability", which is the exact failure this file was written to stop.
  //
  // The name is required to look like an env var (upper case, an underscore or
  // more, next to the words) so an ordinary sentence containing "is not set"
  // cannot claim a secret is missing.
  { cls: 'missing_credential', test: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+ is not set\b/ },
  // The archive's own takeover wording, from decideLock in archive/run-lock.ts:
  // both the deadline form and the cron retry form end "killed rather than still
  // working", and the unreadable stamp form says "left behind by a killed run".
  // Matched on those phrases rather than on the word "killed" alone, so a
  // Snowflake or Postgres message that happens to say a statement was killed
  // does not claim this class.
  { cls: 'archive_run_killed', test: /killed rather than still working|left behind by a killed run/ },
  // Before db_congestion and platform_limit, because the export's own stop
  // wording names the limit it stopped at, and that stop is not the limit's
  // fault: the run stopped cleanly and is behind (#749).
  { cls: 'export_behind', test: /stopped at .+ with rows still waiting to export/ },
  { cls: 'db_congestion', test: /\b57014\b|statement timeout/i },
  { cls: 'platform_limit', test: /too many subrequests|subrequest limit/i },
  // The wording of DeadlineError in packages/buyer-profile/src/deadline.ts, the
  // deadline every Durable Object call carries. On 2026-10-04 one 5 second miss
  // on the Tripoint ledger paged buyer-sale-drain on its first occurrence, and
  // the next minute read the ledger cleanly with nothing left to copy. Matched
  // on the "ms" form only, so the archive reader's own seconds wording keeps
  // its existing treatment.
  { cls: 'call_deadline', test: /did not answer within \d+ ms\b/ },
  {
    cls: 'transient_snowflake',
    // "idle timeout expired" is Snowflake's own 30s server-side timeout, served
    // as a 500 (2026-08-11). It is a stall, not a failed statement, so it is
    // transient even though its status is not in the retryable set above.
    test: /Snowflake (?:429|502|503|504)\b|upstream connect error|connection termination|network connection lost|idle timeout expired/i,
  },
  // Cloudflare serves its error pages as a bare "error code: NNN" body (the
  // 2026-07-24 purge failure was "error code: 522", a connection timeout between
  // Cloudflare's edge and the Supabase origin). Snowflake statuses are matched
  // above, so anything left in this shape is edge connectivity, not a service.
  { cls: 'transient_connectivity', test: /\berror code: 5\d\d\b/i },
  { cls: 'snowflake_auth', test: /Snowflake (?:401|403)\b|\b390144\b|JWT token is invalid/i },
  { cls: 'snowflake_permission', test: /\b003001\b|SQL access control error|insufficient privileges/i },
  { cls: 'snowflake_schema', test: /\b100072\b|non-nullable column|invalid identifier/i },
  { cls: 'supabase_permission', test: /permission denied for (?:table|relation|schema)|\b42501\b/i },
]

export function classifyExportError(message: string): ExportErrorClass {
  for (const { cls, test } of RULES) {
    if (test.test(message)) return cls
  }
  return 'unknown'
}

// Classes a retry can genuinely fix. Everything else (auth, permissions, schema
// drift) needs a human, and 'unknown' deliberately counts as NOT transient so an
// error we cannot explain always fails loud instead of being held back.
const TRANSIENT_CLASSES: ReadonlySet<ExportErrorClass> = new Set([
  'db_congestion',
  'transient_snowflake',
  'transient_connectivity',
  'platform_limit',
  // Held once and paged on the second consecutive run, which is the runaway:
  // one catch-up run that does not finish is normal after a failure (#749).
  'export_behind',
  // A slow answer from a Durable Object. The next run asks again, and an object
  // that stays down still pages on the second consecutive run.
  'call_deadline',
])

export function isTransientExportError(message: string): boolean {
  return TRANSIENT_CLASSES.has(classifyExportError(message))
}

/**
 * Build the alert's "How to fix" body: one line per distinct error class, in the
 * order the classes are defined above. An unrecognised error always contributes
 * the generic line, so a cause we cannot explain is never silently dropped.
 */
export function buildFixHint(errors: string[]): string {
  if (errors.length === 0) return GENERIC_FIX_HINT

  const seen = new Set(errors.map(classifyExportError))
  const lines = RULES.filter((r) => seen.has(r.cls)).map((r) => FIX_HINTS[r.cls])
  if (seen.has('unknown')) lines.push(GENERIC_FIX_HINT)

  return lines.length > 0 ? lines.join('\n') : GENERIC_FIX_HINT
}

/**
 * The consequence sentence for a batch of errors, or undefined to keep the
 * renderer's default.
 *
 * Only when EVERY error is one class and that class has its own sentence. A
 * mixed batch gets the default rather than letting one class speak for errors
 * of another kind, because the sentence introduces the whole list.
 */
export function buildConsequence(errors: string[]): string | undefined {
  if (errors.length === 0) return undefined
  const classes = new Set(errors.map(classifyExportError))
  if (classes.size !== 1) return undefined
  const [only] = classes
  if (only === 'unknown') return undefined
  return CONSEQUENCES[only]
}
