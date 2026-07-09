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
import { classifyExportError, buildFixHint, GENERIC_FIX_HINT } from '../export-error-hints'

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
})
