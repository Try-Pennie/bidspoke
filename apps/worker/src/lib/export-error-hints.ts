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
  | 'unknown'

/**
 * For an error that names no step and matches no rule. It used to send the
 * reader to Snowflake, but most errors nobody has classified come from Supabase
 * or Salesforce (#835), so it claims no system at all.
 */
export const GENERIC_FIX_HINT =
  'Read the error above: it names the system that refused. If the next run fails the same way, fix that system before anything else.'

/**
 * What each step of the two export jobs touches, keyed by the prefix the job
 * writes in front of each error (`trades backfill: ...` in achieve-export.ts,
 * `sightings export: ...` in sightings-export.ts). An error no rule recognises
 * still came from a known step, and the step is enough to say which systems it
 * could have been (#835).
 */
type StepSystems = 'supabase' | 'supabase_and_snowflake' | 'salesforce'

const STEP_SYSTEMS: Readonly<Record<string, StepSystems>> = {
  'trades backfill': 'supabase',
  'sandbox purge': 'supabase',
  'enrollment view backfill': 'salesforce',
  'evaluations export': 'supabase_and_snowflake',
  'sightings export': 'supabase_and_snowflake',
  'bids export': 'supabase_and_snowflake',
}

function stepSystemsOf(message: string): StepSystems | null {
  const colon = message.indexOf(': ')
  if (colon < 0) return null
  return STEP_SYSTEMS[message.slice(0, colon)] ?? null
}

/** The line for an unrecognised error from a step that is named. */
const UNKNOWN_IN_STEP: Readonly<Record<Exclude<StepSystems, 'salesforce'>, string>> = {
  supabase:
    'This step reads and writes only our Supabase database, so the error came from Supabase. The rows it did not reach wait for the next run. If that run fails the same way, look the error up in the Supabase logs.',
  supabase_and_snowflake:
    'This step reads rows from our Supabase database and writes them to Snowflake, and the error above names which of the two refused. Rows not marked as exported are sent again on the next run.',
}

/**
 * The enrollment view backfill is the one step whose leads are NOT retried: the
 * export that follows it in the same run sends every unfilled lead without the
 * view, and the backfill only reads leads not yet exported (achieve-export.ts),
 * so a transient line promising "the next run" would be false here (#835).
 */
const ENROLLMENT_VIEW_FIX =
  "The enrollment view is read from each lead's Salesforce Submission just before the Achieve export, and a lead exported without it is never filled in later. Read the error above: a Salesforce query failure names the status Salesforce returned, and anything else came from our database. Fix it before the next 09:00 UTC run, or that day's leads go without it too."

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
    // Not the RLS policy: the Worker connects as service_role, which bypasses RLS,
    // so a 42501 here is a missing table or schema grant (#835).
    'Supabase denied the export role. Check the table and schema grants for the service role.',
  platform_limit:
    "The Worker hit Cloudflare's per invocation subrequest ceiling while draining a backlog. There is no action to take: the run stopped cleanly and the next run continues from where it left off.",
  export_behind:
    'The export stopped at its own limit with rows still waiting, so it did not catch up this run. One such run straight after a failed run is normal catch-up, and is held back rather than paged. Two in a row means one run can no longer drain what arrives between runs: read the last runs in job_runs (job sightings-export) for rows per run against the measured rate in WALL_TIME_BUDGET_MS, and raise the export rate or the frequency rather than waiting.',
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
])

export function isTransientExportError(message: string): boolean {
  return TRANSIENT_CLASSES.has(classifyExportError(message))
}

/**
 * Build the alert's "How to fix" body: one line per distinct error class, in the
 * order the classes are defined above. An unrecognised error always contributes
 * a line, so a cause we cannot explain is never silently dropped: the line for
 * its step when the error names one, the generic line when it does not.
 *
 * An error from the enrollment view backfill gets that step's own line, and
 * keeps its class line only when the class line promises no retry, because its
 * leads are never retried (#835).
 */
export function buildFixHint(errors: string[]): string {
  if (errors.length === 0) return GENERIC_FIX_HINT

  const classes = new Set<ExportErrorClass>()
  const unknownSteps = new Set<Exclude<StepSystems, 'salesforce'>>()
  let enrollmentView = false
  let unknownNoStep = false
  for (const message of errors) {
    const cls = classifyExportError(message)
    const step = stepSystemsOf(message)
    if (step === 'salesforce') {
      enrollmentView = true
      if (cls !== 'unknown' && !TRANSIENT_CLASSES.has(cls)) classes.add(cls)
    } else if (cls !== 'unknown') {
      classes.add(cls)
    } else if (step !== null) {
      unknownSteps.add(step)
    } else {
      unknownNoStep = true
    }
  }

  const lines = RULES.filter((r) => classes.has(r.cls)).map((r) => FIX_HINTS[r.cls])
  if (enrollmentView) lines.push(ENROLLMENT_VIEW_FIX)
  for (const step of ['supabase', 'supabase_and_snowflake'] as const) {
    if (unknownSteps.has(step)) lines.push(UNKNOWN_IN_STEP[step])
  }
  if (unknownNoStep) lines.push(GENERIC_FIX_HINT)

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
