/**
 * L741 (#1740): a scrub that finds personal data by its shape cannot see a
 * percent-encoded copy of it, and a URL's query string percent-encodes the @
 * and the brackets of an email or a phone. So a URL bound for a log, an alert
 * or an outside service keeps its host and path and loses its query string and
 * fragment, rather than trusting a pattern scrub to recognise what is inside.
 */
import { describe, expect, it } from 'vitest'
import { stripUrlQuery, stripUrlQueriesInText } from '../url-redact'

describe('stripUrlQuery', () => {
  it('keeps the scheme, host and path and drops the query string and fragment', () => {
    expect(stripUrlQuery('https://partner.example/leads/create?email=jo%40example.com&phone=%28201%29555#top')).toBe('https://partner.example/leads/create')
  })

  it('leaves an address with no query or fragment unchanged', () => {
    expect(stripUrlQuery('https://partner.example/leads/create')).toBe('https://partner.example/leads/create')
  })
})

describe('stripUrlQueriesInText', () => {
  it('strips every address inside a sentence, as a fetch error names it', () => {
    const text = 'TypeError: Fetch API cannot load: https://api.example/a?ssn=123456789. Retried https://api.example/b#frag?x=1 too.'
    expect(stripUrlQueriesInText(text)).toBe('TypeError: Fetch API cannot load: https://api.example/a. Retried https://api.example/b too.')
  })

  it('removes a percent-encoded email and phone, the values a shape scrub cannot see', () => {
    const out = stripUrlQueriesInText('GET http://host.example/x?e=jo%40gmail.com&p=%28201%29%20555-0100 failed')
    expect(out).not.toMatch(/%40|gmail|%28201%29|555-0100/)
    expect(out).toBe('GET http://host.example/x failed')
  })

  it('ends an address at a JSON string boundary, so a serialised log line keeps its structure and the text after it', () => {
    const line = JSON.stringify({ error_message: 'load https://h.example/p?email=a%40b.com\nnext line', step: 'x' })
    const out = stripUrlQueriesInText(line)
    expect(JSON.parse(out)).toEqual({ error_message: 'load https://h.example/p\nnext line', step: 'x' })
  })

  it('drops an unencoded query whole, brackets included, so nothing after a bracket is left behind', () => {
    expect(stripUrlQueriesInText('GET https://p.example/x?phone=(201)555-0100&tags=[a] failed')).toBe('GET https://p.example/x failed')
  })

  it('still ends an address at a closing bracket in its path, as prose writes it', () => {
    expect(stripUrlQueriesInText('(see https://app.example/executions/1)')).toBe('(see https://app.example/executions/1)')
  })

  it('leaves a question mark that is not part of an address alone', () => {
    expect(stripUrlQueriesInText('Why did step x fail? See https://app.example/executions/1')).toBe('Why did step x fail? See https://app.example/executions/1')
  })

  it('leaves text with no address unchanged', () => {
    expect(stripUrlQueriesInText('Connection refused')).toBe('Connection refused')
  })
})
