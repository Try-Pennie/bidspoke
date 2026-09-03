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

// ── Thrown Response objects (#708) ───────────────────────────────────────────
//
// The integration/webhook executor signals a non-2xx by throwing the `Response`
// itself, so the engine can classify the HTTP error. A `Response` has no
// `.message`, and its status/body live on prototype getters rather than own
// properties, so JSON.stringify sees neither: the rendered message was the
// attached `resolvedInput` and `logs` and nothing about the failure.
//
// On 2026-07-28 23:19:58 to 23:20:20 UTC, 13 Main Flow executions failed when the
// send_salesforce_inquiry webhook step got a non-2xx from its Pipedream endpoint.
// The alert was a wall of resolved input with no reason, and the status is now
// unrecoverable, so the incident could not be attributed with certainty.
//
// LESSONS L11: distinct causes get distinct messages. Every webhook step in every
// workflow shared one indistinguishable message.
describe('formatErr on a thrown Response (#708)', () => {
  const withBody = (res: Response, bodyText: string) => {
    ;(res as Response & { bodyText?: string }).bodyText = bodyText
    return res
  }

  it('renders the status code', () => {
    expect(formatErr(new Response('', { status: 502 }))).toContain('502')
  })

  it('renders the status code and the response body together', () => {
    const err = withBody(new Response('nope', { status: 400 }), '{"error":"missing SSN"}')
    const out = formatErr(err)
    expect(out).toContain('400')
    expect(out).toContain('missing SSN')
  })

  it('does not bury the failure under the attached resolved input', () => {
    // The 2026-07-28 alert was almost entirely this payload.
    const err = withBody(new Response('', { status: 500 }), 'upstream exploded')
    ;(err as Response & { resolvedInput?: unknown }).resolvedInput = {
      body: { ssn: '000-00-0000', first_name: 'A'.repeat(200) },
    }
    ;(err as Response & { logs?: unknown }).logs = [{ level: 'warn', message: 'x'.repeat(200) }]
    const out = formatErr(err)
    expect(out).toContain('500')
    expect(out).toContain('upstream exploded')
    expect(out).not.toContain('000-00-0000')
    expect(out).not.toContain('resolvedInput')
  })

  it('still reads when the body is empty', () => {
    const out = formatErr(new Response('', { status: 504 }))
    expect(out).toContain('504')
    expect(out).not.toContain('undefined')
  })

  it('summarizes an HTML error page rather than pasting the document', () => {
    // Salesforce Edge returns a full HTML page on some 400s; the existing
    // summarizer must still apply once the body is actually rendered.
    const html = '<!DOCTYPE html><html><head><title>Bad Request</title></head><body>' + 'x'.repeat(4000) + '</body></html>'
    const out = formatErr(withBody(new Response(html, { status: 400 }), html))
    expect(out).toContain('400')
    expect(out.length).toBeLessThan(1000)
  })

  it('survives alert truncation with the status still readable', () => {
    const err = withBody(new Response('', { status: 503 }), 'y'.repeat(5000))
    expect(truncateErrorForAlert(formatErr(err))).toContain('503')
  })
})

// #1111: normalizeDbError now names the HTTP status for an empty-bodied failure,
// but formatErr is the shared renderer for every error object in the worker, and
// an object whose message is blank still reached it as the literal
// `{"message":""}` -- an alert body that names nothing while looking like data.
// Anything that arrives here without a message must SAY it has no message.
describe('formatErr — object with a blank message', () => {
  it('does not render an empty message as a JSON object', () => {
    expect(formatErr({ message: '' })).not.toBe('{"message":""}')
  })

  it('says the error carried no message', () => {
    expect(formatErr({ message: '   ' }).toLowerCase()).toContain('no message')
  })

  // A code is the only searchable token such an error has; it must survive.
  it('keeps a code when the message is blank', () => {
    expect(formatErr({ message: '', code: 'PGRST002' })).toContain('PGRST002')
  })
})
