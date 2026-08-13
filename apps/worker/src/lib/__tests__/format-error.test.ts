import { describe, it, expect } from 'vitest'
import { formatErr, truncateErrorForAlert } from '../format-error'
import { SALESFORCE_EDGE_ERROR_MESSAGE } from './fixtures/salesforce-edge-error-page'

describe('formatErr', () => {
  it('uses the message of an Error instance', () => {
    expect(formatErr(new Error('boom'))).toBe('boom')
  })

  it('passes strings through unchanged', () => {
    expect(formatErr('plain string error')).toBe('plain string error')
  })

  it('extracts message and code from a Supabase/PostgREST error object', () => {
    // This is the case that produced the useless "[object Object]" alert: a
    // thrown Supabase error is a plain object, not an Error instance.
    const supabaseErr = {
      message: 'permission denied for table lead_sightings',
      code: '42501',
      details: null,
      hint: null,
    }
    expect(formatErr(supabaseErr)).toBe('permission denied for table lead_sightings (42501)')
  })

  it('uses just the message when a code-less object error is thrown', () => {
    expect(formatErr({ message: 'something failed' })).toBe('something failed')
  })

  it('falls back to JSON for a message-less object instead of [object Object]', () => {
    const result = formatErr({ foo: 'bar', n: 1 })
    expect(result).not.toBe('[object Object]')
    expect(result).toContain('foo')
    expect(result).toContain('bar')
  })

  it('handles null and undefined without throwing', () => {
    expect(formatErr(null)).toBe('null')
    expect(formatErr(undefined)).toBe('undefined')
  })

  it('renders a DbError carrying the zero-row sentinel', () => {
    const dbError = { code: 'BIDSPOKE_NO_ROW_MATCHED', message: 'write matched zero rows' }
    expect(formatErr(dbError)).toBe('write matched zero rows (BIDSPOKE_NO_ROW_MATCHED)')
  })

  // Postgres puts the generic rule in `message` and the offending value in
  // `details`. Dropping details names the constraint but never the cause.
  it('appends details, where a constraint violation names the offending value', () => {
    const fkViolation = {
      message: 'insert or update on table "lead_sightings" violates foreign key constraint',
      details: 'Key (person_id)=(abc-123) is not present in table "persons".',
      hint: null,
      code: '23503',
    }
    expect(formatErr(fkViolation)).toBe(
      'insert or update on table "lead_sightings" violates foreign key constraint: Key (person_id)=(abc-123) is not present in table "persons". (23503)'
    )
  })

  it('falls back to hint when there are no details', () => {
    const err = { message: 'column reference is ambiguous', hint: 'Add an explicit table qualifier.', code: '42702' }
    expect(formatErr(err)).toBe('column reference is ambiguous: Add an explicit table qualifier. (42702)')
  })

  it('prefers details over hint when both are present', () => {
    const err = { message: 'bad thing', details: 'the specific bad thing', hint: 'try harder', code: 'X1' }
    expect(formatErr(err)).toBe('bad thing: the specific bad thing (X1)')
  })

  it('does not repeat details that merely restate the message', () => {
    const err = { message: 'write matched zero rows', details: 'write matched zero rows', code: 'X1' }
    expect(formatErr(err)).toBe('write matched zero rows (X1)')
  })

  it('ignores non-string and empty details', () => {
    expect(formatErr({ message: 'boom', details: { nested: true }, code: 'X1' })).toBe('boom (X1)')
    expect(formatErr({ message: 'boom', details: '   ', code: 'X1' })).toBe('boom (X1)')
  })
})

describe('truncateErrorForAlert', () => {
  it('returns a short message unchanged', () => {
    expect(truncateErrorForAlert('permission denied (42501)')).toBe('permission denied (42501)')
  })

  it('returns a message exactly at the limit unchanged', () => {
    const text = 'x'.repeat(300)
    expect(truncateErrorForAlert(text, 300)).toBe(text)
  })

  // The regression this fixes: #602 folded Postgres `details` into the message,
  // pushing a long constraint violation past 300 chars. Head-only truncation then
  // sliced off the trailing `(23503)` -- the single most searchable token.
  it('keeps the trailing SQLSTATE code on an over-limit constraint error', () => {
    const longDetail = 'Key (person_id)=(' + 'a'.repeat(400) + ') is not present in table "persons".'
    const full = `insert or update on table "lead_sightings" violates foreign key constraint: ${longDetail} (23503)`
    expect(full.length).toBeGreaterThan(300)

    const out = truncateErrorForAlert(full, 300)
    expect(out).toContain('(23503)')
    // reading order preserved: the head still leads with the human-readable rule.
    expect(out.startsWith('insert or update on table "lead_sightings" violates foreign key constraint')).toBe(true)
    // and it actually truncated (a marker is present, and it stayed near budget).
    expect(out).toContain('…')
    expect(out.length).toBeLessThanOrEqual(300)
  })

  it('preserves the tail even when the code is the very last token with no trailing space', () => {
    const full = 'A'.repeat(500) + '(BIDSPOKE_NO_ROW_MATCHED)'
    const out = truncateErrorForAlert(full, 300)
    expect(out).toContain('(BIDSPOKE_NO_ROW_MATCHED)')
    expect(out.endsWith('(BIDSPOKE_NO_ROW_MATCHED)')).toBe(true)
  })
})

// Every persisted error_message and every Slack alert cause renders through
// formatErr, so collapsing an HTML error page here covers all of them at once,
// including a wrapper message that embedded a child's page (#695).
describe('formatErr collapses an upstream HTML error page (#695)', () => {
  it('summarizes an Error whose message is a Salesforce Edge page', () => {
    const out = formatErr(new Error(SALESFORCE_EDGE_ERROR_MESSAGE))
    expect(out).toContain('Salesforce API error (400)')
    expect(out).toContain('An unexpected connection error occurred.')
    expect(out).not.toContain('<style>')
    expect(out.length).toBeLessThan(700)
  })

  it('summarizes the page embedded in a parallel wrapper message', () => {
    const wrapped = new Error(`Parallel failed: child "trades_body" failed: ${SALESFORCE_EDGE_ERROR_MESSAGE}`)
    const out = formatErr(wrapped)
    expect(out.startsWith('Parallel failed: child "trades_body" failed:')).toBe(true)
    expect(out).toContain('70aebd63701c0777f9ba663c488e2044')
    expect(out).not.toContain('viewBox')
  })

  it('summarizes a page arriving on a plain object error', () => {
    const out = formatErr({ message: SALESFORCE_EDGE_ERROR_MESSAGE, code: 'SF_EDGE' })
    expect(out).toContain('An unexpected connection error occurred.')
    expect(out).toContain('(SF_EDGE)')
    expect(out).not.toContain('normalize.css')
  })

  it('leaves ordinary error messages exactly as they were', () => {
    expect(formatErr(new Error('Salesforce bulkhead: at capacity'))).toBe('Salesforce bulkhead: at capacity')
    expect(formatErr(new Error('Expected <number>, got "abc"'))).toBe('Expected <number>, got "abc"')
    expect(formatErr({ message: 'duplicate key', details: 'Key (id)=(1) exists', code: '23505' }))
      .toBe('duplicate key: Key (id)=(1) exists (23505)')
  })
})
