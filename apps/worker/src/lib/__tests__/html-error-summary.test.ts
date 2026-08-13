/**
 * Issue #695: when an upstream returns an HTML error page instead of JSON, the
 * whole page (16.7KB in the observed Salesforce Edge case) was stored verbatim
 * in `execution_steps.error_message` and `workflow_executions.error_message`, so
 * the execution detail page rendered a wall of inlined CSS and SVG and the real
 * signal (the message, the request-ID stamp, the pod, the status) was
 * unreadable without querying the database by hand.
 *
 * The summarizer keeps that signal and drops the markup. It must also leave
 * every non-HTML error message exactly as it was: a filter that recognises
 * content by shape has to be tested against what it must PRESERVE, not only
 * against what it must catch.
 */
import { describe, it, expect } from 'vitest'
import { summarizeHtmlErrorBody, containsHtmlDocument } from '../html-error-summary'
import { SALESFORCE_EDGE_ERROR_PAGE, SALESFORCE_EDGE_ERROR_MESSAGE } from './fixtures/salesforce-edge-error-page'

describe('containsHtmlDocument', () => {
  it('recognises the real Salesforce Edge page (no space in <!doctypehtml>)', () => {
    expect(containsHtmlDocument(SALESFORCE_EDGE_ERROR_PAGE)).toBe(true)
    expect(containsHtmlDocument(SALESFORCE_EDGE_ERROR_MESSAGE)).toBe(true)
  })

  it('recognises a page that opens with <html> and no doctype', () => {
    expect(containsHtmlDocument('<html><body>Gateway error</body></html>')).toBe(true)
  })

  it('does not fire on error text that merely contains markup or angle brackets', () => {
    expect(containsHtmlDocument('Expected <number>, got "abc"')).toBe(false)
    expect(containsHtmlDocument('<Error><faultcode>sf:INVALID_SESSION_ID</faultcode></Error>')).toBe(false)
    expect(containsHtmlDocument('{"message":"Session expired","errorCode":"INVALID_SESSION_ID"}')).toBe(false)
    expect(containsHtmlDocument('a < b && c > d')).toBe(false)
    expect(containsHtmlDocument('')).toBe(false)
  })
})

describe('summarizeHtmlErrorBody on the real Salesforce Edge page (#695)', () => {
  const summary = summarizeHtmlErrorBody(SALESFORCE_EDGE_ERROR_MESSAGE)

  it('keeps the prefix the node built around the body', () => {
    expect(summary.startsWith('Salesforce API error (400): ')).toBe(true)
  })

  it('keeps every piece of real diagnostic signal', () => {
    expect(summary).toContain('An unexpected connection error occurred.')
    // The request-ID stamp, split across three spans in the source.
    expect(summary).toContain('70aebd63701c0777f9ba663c488e2044')
    expect(summary).toContain('2026-08-12T00:15:32+00:00')
    expect(summary).toContain('aws-prod1-useast1')
    // Names which system produced the page, which is how we know it is an edge
    // failure rather than an application rejection.
    expect(summary).toContain('Salesforce Edge')
  })

  it('drops the markup, the inlined CSS and the SVG illustration', () => {
    expect(summary).not.toContain('<')
    expect(summary).not.toContain('normalize.css')
    expect(summary).not.toContain('viewBox')
    expect(summary).not.toContain('font-family')
    expect(summary).not.toContain('translate(')
  })

  it('says an HTML page was collapsed, and by how much', () => {
    expect(summary).toContain('HTML error page')
    expect(summary).toContain(String(SALESFORCE_EDGE_ERROR_PAGE.length))
  })

  it('is short enough to read on the execution page', () => {
    expect(summary.length).toBeLessThan(700)
  })

  // The production rows were 16,691 bytes; this fixture is smaller because its
  // SVG middle is elided, so bound the output against a page padded back to the
  // real size. The summary must be bounded by its own budget, not by its input.
  it('stays bounded on a page the full size of the real one', () => {
    const padding = '<svg><path d="M0,0 L1,1"></path></svg>'.repeat(400)
    const fullSize = SALESFORCE_EDGE_ERROR_MESSAGE.replace('</style><div class="slds-illustration', `</style>${padding}<div class="slds-illustration`)
    expect(fullSize.length).toBeGreaterThan(16000)

    const out = summarizeHtmlErrorBody(fullSize)
    expect(out.length).toBeLessThan(700)
    expect(out).toContain('An unexpected connection error occurred.')
    expect(out).toContain('70aebd63701c0777f9ba663c488e2044')
    expect(out).not.toContain('path d')
  })

  it('is idempotent, so re-rendering a stored summary does not re-summarize it', () => {
    expect(summarizeHtmlErrorBody(summary)).toBe(summary)
  })
})

describe('summarizeHtmlErrorBody preserves non-HTML messages verbatim (#695)', () => {
  it.each([
    'Salesforce API error (400): {"message":"Required fields are missing","errorCode":"REQUIRED_FIELD_MISSING"}',
    'Salesforce bulkhead: at capacity after waiting 2000ms',
    'Cannot read properties of undefined (reading \'output\')',
    'insert or update violates foreign key constraint: Key (person_id)=(abc-123) is not present (23503)',
    'Expected <number>, got "abc"',
    '',
  ])('leaves %j unchanged', (message) => {
    expect(summarizeHtmlErrorBody(message)).toBe(message)
  })
})

describe('summarizeHtmlErrorBody on other shapes of HTML error page', () => {
  it('falls back to the page title when there is no heading', () => {
    const page = '<!DOCTYPE html><html><head><title>504 Gateway Timeout</title></head><body></body></html>'
    const summary = summarizeHtmlErrorBody(page)
    expect(summary).toContain('504 Gateway Timeout')
    expect(summary).not.toContain('<')
  })

  it('drops a script block without leaking its source', () => {
    const page = '<html><script>var secret = "do-not-store"; alert(1)</script><h1>Bad gateway</h1></html>'
    const summary = summarizeHtmlErrorBody(page)
    expect(summary).toContain('Bad gateway')
    expect(summary).not.toContain('do-not-store')
  })

  it('decodes the entities a stripped page leaves behind', () => {
    const page = '<html><h1>Request&nbsp;failed &amp; was not retried &lt;here&gt;</h1></html>'
    const summary = summarizeHtmlErrorBody(page)
    expect(summary).toContain('Request failed & was not retried <here>')
  })

  it('caps a page whose visible text is itself enormous, keeping both ends', () => {
    const page = `<html><body><p>${'START '}${'x'.repeat(5000)}${' END'}</p></body></html>`
    const summary = summarizeHtmlErrorBody(page)
    expect(summary.length).toBeLessThan(700)
    expect(summary).toContain('START')
    expect(summary).toContain('END')
  })

  it('still reports the page when it strips down to no visible text at all', () => {
    const page = '<!doctype html><html><style>body{color:red}</style></html>'
    const summary = summarizeHtmlErrorBody(page)
    expect(summary).toContain('HTML error page')
    expect(summary).not.toContain('color:red')
  })
})
