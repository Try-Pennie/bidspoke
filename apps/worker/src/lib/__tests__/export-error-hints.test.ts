/**
 * Export-failure alert classification (#542).
 *
 * Every export alert used to end with the same "check Snowflake availability and
 * the export credentials" line regardless of what actually broke. During the
 * 2026-07-01..07-03 incident the real cause was Postgres statement timeouts and
 * that canned advice pointed diagnosis the wrong way for days. On 2026-07-09 it
 * sent someone looking at Snowflake for a transient blip that had already
 * self-healed on the next run.
 *
 * The classifier has to survive two genuine ambiguities:
 *   - 42501 means "permission denied" in Postgres, but Snowflake pairs it with
 *     003001 on a missing grant. Same code, different system, different fix.
 *   - Our own thrown Snowflake errors are formatted "Snowflake <status>: <body>",
 *     so a status match must not fire on a Postgres error that merely contains
 *     a similar-looking number.
 */
import { describe, it, expect } from 'vitest'
import { classifyExportError, buildFixHint, buildConsequence, isTransientExportError, GENERIC_FIX_HINT } from '../export-error-hints'

describe('classifyExportError', () => {
  it('classifies a Postgres statement timeout as database congestion', () => {
    expect(classifyExportError('sightings export: canceling statement due to statement timeout (57014)'))
      .toBe('db_congestion')
    expect(classifyExportError('bids purge: statement timeout')).toBe('db_congestion')
  })

  it.each([
    ['Snowflake 503: upstream connect error or disconnect/reset before headers. reset reason: connection termination'],
    ['bids export: Snowflake 502: bad gateway'],
    ['Snowflake 504: gateway timeout'],
    ['Snowflake 429: too many requests'],
    ['sightings export: Network connection lost.'],
  ])('classifies %s as a transient Snowflake failure', (msg) => {
    expect(classifyExportError(msg)).toBe('transient_snowflake')
  })

  it('classifies a Snowflake idle timeout as transient, not unknown', () => {
    // The verbatim 2026-08-11 16:37 UTC failure. It matched no rule, so it fell
    // to 'unknown', which pages on the FIRST failure and prints the generic
    // "check Snowflake availability and the export credentials" advice. Both
    // were fine: Snowflake stalled 30s on one statement and the next run
    // drained the backlog.
    const msg =
      'sightings export: Snowflake 500: {\n "code" : "ErrorCode{messageCode=370001}",\n "message" : "Idle timeout expired: 30001/30000 ms"\n}'
    expect(classifyExportError(msg)).toBe('transient_snowflake')
    expect(isTransientExportError(msg)).toBe(true)
    expect(buildFixHint([msg])).not.toContain(GENERIC_FIX_HINT)
  })

  it('classifies a Snowflake auth failure as a credential problem', () => {
    expect(classifyExportError('Snowflake 401: JWT token is invalid')).toBe('snowflake_auth')
    expect(classifyExportError('Snowflake 403: forbidden')).toBe('snowflake_auth')
  })

  it('classifies a missing Snowflake grant as a permission problem, not a Postgres one', () => {
    // The real 2026-06-27 Achieve failure: role lacked CREATE TABLE on the schema.
    expect(classifyExportError('achieve export: Snowflake 400: {"code":"003001","message":"SQL access control error"}'))
      .toBe('snowflake_permission')
  })

  it('classifies a Postgres permission denial separately even though it shares code 42501', () => {
    // Same numeric code as Snowflake's grant error, entirely different fix.
    expect(classifyExportError('sightings purge: permission denied for table lead_sightings (42501)'))
      .toBe('supabase_permission')
  })

  it('classifies a Snowflake column rejection as schema drift', () => {
    expect(classifyExportError('Snowflake 422: 100072 (22000): NULL result in a non-nullable column'))
      .toBe('snowflake_schema')
    expect(classifyExportError('Snowflake 422: invalid identifier LEAD_UUID')).toBe('snowflake_schema')
  })

  it('classifies the Cloudflare subrequest ceiling as a platform limit', () => {
    expect(classifyExportError('sightings export: Too many subrequests.')).toBe('platform_limit')
  })

  it('classifies a Cloudflare error page body as transient connectivity', () => {
    // The real 2026-07-24 alert: the purge DELETE got Cloudflare's 522
    // connection-timeout page instead of reaching the Supabase origin. The
    // classifier had no rule for it, so the alert blamed Snowflake credentials.
    expect(classifyExportError('sightings purge: error code: 522')).toBe('transient_connectivity')
    expect(classifyExportError('bids export: error code: 520')).toBe('transient_connectivity')
  })

  it('falls back to unknown for anything it does not recognise', () => {
    expect(classifyExportError('bids export: something nobody has seen before')).toBe('unknown')
  })

  it('prefers the statement-timeout class over a Snowflake status that also appears', () => {
    // A timeout message that happens to mention Snowflake must not read as transient.
    expect(classifyExportError('sightings export: canceling statement due to statement timeout (57014) while merging to Snowflake'))
      .toBe('db_congestion')
  })
})

describe('buildFixHint', () => {
  it('tells you plainly that a transient Snowflake blip needs no action', () => {
    const hint = buildFixHint(['bids export: Snowflake 503: connection termination'])
    expect(hint).toContain('no action')
    expect(hint).toContain('next run')
    // Must NOT send the reader to go check credentials for a network blip.
    expect(hint).not.toContain('credential')
  })

  it('points a statement timeout at the database, not at Snowflake', () => {
    const hint = buildFixHint(['sightings export: canceling statement due to statement timeout (57014)'])
    expect(hint.toLowerCase()).toContain('congestion')
    expect(hint).toContain('pg_cron')
    expect(hint).not.toContain('Snowflake availability')
  })

  it('points an auth failure at the Snowflake credentials', () => {
    const hint = buildFixHint(['Snowflake 401: JWT token is invalid'])
    expect(hint).toContain('credential')
  })

  it('emits one line per distinct class when a run reports several kinds of error', () => {
    const hint = buildFixHint([
      'sightings export: canceling statement due to statement timeout (57014)',
      'bids export: Snowflake 503: connection termination',
      'bids purge: canceling statement due to statement timeout (57014)', // duplicate class
    ])
    const lines = hint.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2) // db_congestion + transient_snowflake, deduped
  })

  it('keeps the generic line when nothing is recognised', () => {
    expect(buildFixHint(['bids export: something nobody has seen before'])).toBe(GENERIC_FIX_HINT)
  })

  it('appends the generic line alongside a known class when an unknown error is also present', () => {
    // Never silently drop an error we cannot explain.
    const hint = buildFixHint([
      'bids export: Snowflake 503: connection termination',
      'sightings purge: something nobody has seen before',
    ])
    expect(hint).toContain('no action')
    expect(hint).toContain(GENERIC_FIX_HINT)
  })

  it('returns the generic line for an empty error list rather than an empty string', () => {
    expect(buildFixHint([])).toBe(GENERIC_FIX_HINT)
  })

  it('says a Cloudflare connectivity blip needs no action and retries on the next run', () => {
    const hint = buildFixHint(['sightings purge: error code: 522'])
    expect(hint.toLowerCase()).toContain('no action')
    expect(hint).toContain('next run')
    expect(hint).not.toContain('credential')
    expect(hint).not.toContain('Snowflake availability')
  })
})

describe('isTransientExportError', () => {
  it.each([
    ['sightings purge: error code: 522'],
    ['bids export: Snowflake 503: connection termination'],
    ['sightings export: canceling statement due to statement timeout (57014)'],
    ['sightings export: Too many subrequests.'],
  ])('treats %s as transient (a retry can fix it)', (msg) => {
    expect(isTransientExportError(msg)).toBe(true)
  })

  it.each([
    ['sightings purge: permission denied for table lead_sightings (42501)'],
    ['Snowflake 401: JWT token is invalid'],
    ['achieve export: Snowflake 400: {"code":"003001","message":"SQL access control error"}'],
    ['Snowflake 422: invalid identifier LEAD_UUID'],
    ['bids export: something nobody has seen before'],
  ])('treats %s as NOT transient (a retry cannot fix it, or we cannot tell)', (msg) => {
    expect(isTransientExportError(msg)).toBe(false)
  })
})

describe('a Worker secret that is not set', () => {
  /** Verbatim from the 2026-08-23 alert, where this fell through to the generic hint. */
  const MESSAGE =
    'the reader identity could not be verified: ARCHIVE_READER_USER is not set, ' +
    'so the archive cannot authenticate to Snowflake'

  it('is classified as a missing credential, not as an unknown failure', () => {
    expect(classifyExportError(MESSAGE)).toBe('missing_credential')
  })

  it('is not treated as transient, because no retry sets a secret', () => {
    expect(isTransientExportError(MESSAGE)).toBe(false)
  })

  it('gets advice naming the secret rather than pointing at Snowflake availability', () => {
    const hint = buildFixHint([MESSAGE])

    expect(hint).toContain('wrangler secret put')
    expect(hint).not.toContain(GENERIC_FIX_HINT)
  })
})

describe('a killed archive invocation (#1180)', () => {
  // The verbatim takeover wording from decideLock, both the deadline form and
  // the cron retry form (#1181). On 2026-09-05 the alert carrying the first of
  // these ended with "Check Snowflake availability and the export credentials",
  // and its header said rows were not exported. Nothing about a killed run
  // involves Snowflake, credentials, or rows this run failed to export.
  const DEADLINE_FORM =
    'the previous run has held the lock for 60 minutes, past its own deadline and the 5 minute grace, ' +
    'so it was killed rather than still working. This run is proceeding; the work its predecessor did not finish is simply unarchived.'
  const RETRY_FORM =
    'this invocation is a retry of the same scheduled event (2026-09-05T00:23:00.000Z), whose earlier attempt ' +
    'took the lock 43 seconds ago; the platform only retries after that attempt has ended, so it was killed rather than ' +
    'still working. This run is proceeding; the work its predecessor did not finish is simply unarchived.'
  const UNREADABLE_FORM =
    'the previous run lock could not be read, so it is presumed left behind by a killed run. This run is proceeding; ' +
    'the work its predecessor did not finish is simply unarchived.'

  it.each([DEADLINE_FORM, RETRY_FORM, UNREADABLE_FORM])('recognises the takeover wording: %s', (msg) => {
    expect(classifyExportError(msg)).toBe('archive_run_killed')
  })

  it('does not read an ordinary export failure as a killed run', () => {
    // Negative control in the same fixture shape: the word "run" alone is not
    // the signature.
    expect(classifyExportError('bids export: Snowflake 503: connection termination on the next run')).not.toBe('archive_run_killed')
  })

  it('says what was measured and that nothing is lost, and sends nobody to Snowflake', () => {
    const hint = buildFixHint([DEADLINE_FORM])
    expect(hint).toContain('took over')
    expect(hint.toLowerCase()).toContain('nothing is lost')
    expect(hint).toContain('Cloudflare')
    expect(hint).not.toContain('Snowflake availability')
    expect(hint).not.toContain('credential')
    expect(hint).not.toContain(GENERIC_FIX_HINT)
  })

  it('pages on the first occurrence rather than being held as transient', () => {
    // A kill is a statement about an invocation that is already over. Holding
    // it for a second consecutive failure would hide every isolated kill, and
    // the clean run that would clear the marker never calls this path at all.
    expect(isTransientExportError(DEADLINE_FORM)).toBe(false)
  })
})

describe('buildConsequence (#1180)', () => {
  const KILLED =
    'the previous run has held the lock for 60 minutes, past its own deadline and the 5 minute grace, ' +
    'so it was killed rather than still working. This run is proceeding; the work its predecessor did not finish is simply unarchived.'

  it('states the consequence of a killed run in its own words', () => {
    const consequence = buildConsequence([KILLED])
    expect(consequence).toBeDefined()
    expect(consequence).not.toContain('not exported')
    expect(consequence?.toLowerCase()).toContain('archiving')
  })

  it('leaves an ordinary export failure to the caller\'s default wording', () => {
    expect(buildConsequence(['bids export: Snowflake 503: connection termination'])).toBeUndefined()
  })

  it('leaves a mixed batch to the default, rather than letting one class speak for all', () => {
    expect(buildConsequence([KILLED, 'bids export: Snowflake 503: connection termination'])).toBeUndefined()
  })
})
