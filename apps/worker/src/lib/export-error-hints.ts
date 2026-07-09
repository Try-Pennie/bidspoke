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
  | 'snowflake_auth'
  | 'snowflake_permission'
  | 'snowflake_schema'
  | 'supabase_permission'
  | 'platform_limit'
  | 'unknown'

export const GENERIC_FIX_HINT =
  'Check Snowflake availability and the export credentials. If it stays down, watch Supabase disk: the un-purged rows accumulate until a run succeeds.'

const FIX_HINTS: Record<Exclude<ExportErrorClass, 'unknown'>, string> = {
  db_congestion:
    'Database congestion, not Snowflake. There is no action to take: the rows retry on the next run and usually clear on their own. If it persists across runs, look for a pg_cron job colliding with the export window.',
  transient_snowflake:
    'A transient Snowflake connection failure. There is no action to take: these are retried automatically, and any rows left behind export on the next run. If it repeats across several runs, check the Snowflake status page.',
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
}

// Order matters. Two collisions make a naive code match wrong:
//   1. A statement timeout can mention Snowflake in passing (it happens while
//      merging), so it must be matched before any Snowflake status check.
//   2. 42501 is "permission denied" in Postgres, but Snowflake pairs 42501 with
//      003001 on a missing grant. Match Snowflake's own 003001 first, and only
//      then fall through to the Postgres phrasing.
const RULES: Array<{ cls: Exclude<ExportErrorClass, 'unknown'>; test: RegExp }> = [
  { cls: 'db_congestion', test: /\b57014\b|statement timeout/i },
  { cls: 'platform_limit', test: /too many subrequests|subrequest limit/i },
  {
    cls: 'transient_snowflake',
    test: /Snowflake (?:429|502|503|504)\b|upstream connect error|connection termination|network connection lost/i,
  },
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
