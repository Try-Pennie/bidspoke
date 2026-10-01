import { describe, it, expect } from 'vitest'
import { redactHeaders, redactBody, redactPathAndQuery, parseBody, REDACTED } from '../redact'

describe('redact', () => {
  it('hides credential header values and keeps their presence', () => {
    expect(redactHeaders({ Authorization: 'Bearer x', 'X-Api-Key': 'k', 'Content-Type': 'application/json' }))
      .toEqual({ authorization: REDACTED, 'content-type': 'application/json', 'x-api-key': REDACTED })
  })

  it('drops the header the local runtime adds naming the hosting script, which production code never sets', () => {
    expect(redactHeaders({ 'cf-worker': 'bs-wf-da82a183.example.com', 'content-type': 'application/json' })).toEqual({ 'content-type': 'application/json' })
  })

  it('hides credential body fields at any depth', () => {
    expect(redactBody({ auth: { password: 'p', username: 'u' }, client_secret: 's', debt: 25000 }))
      .toEqual({ auth: { password: REDACTED, username: 'u' }, client_secret: REDACTED, debt: 25000 })
  })

  it('hides credential query parameters', () => {
    expect(redactPathAndQuery(new URL('https://h/p?token=abc&state=TX'))).toBe(`/p?token=${REDACTED}&state=TX`)
  })

  it('parses JSON and form bodies', () => {
    expect(parseBody('{"a":1}', 'application/json')).toEqual({ a: 1 })
    expect(parseBody('a=1&b=2', 'application/x-www-form-urlencoded')).toEqual({ a: '1', b: '2' })
    expect(parseBody('plain', null)).toBe('plain')
  })
})
