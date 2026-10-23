import { describe, expect, it } from 'vitest'
import { HTTP_SERVICE_OWNED_DOMAINS, httpCheckPathOf, httpHostOf, hostWithin } from './http-host'

/**
 * The host an HTTP connection declares (#2337): the one host connectionFetch
 * lets it reach, read from what a person would paste (a bare host or a whole
 * address), and never a host another catalogue service owns, an address by
 * number, or one with a port or a login in it.
 */
describe('httpHostOf', () => {
  it('reads the host from a bare host or from a whole https address, in lower case', () => {
    expect(httpHostOf('api.regal.io')).toEqual({ ok: true, host: 'api.regal.io' })
    expect(httpHostOf('  API.Regal.io  ')).toEqual({ ok: true, host: 'api.regal.io' })
    expect(httpHostOf('https://api.regal.io/v1/events?x=1')).toEqual({ ok: true, host: 'api.regal.io' })
    expect(httpHostOf('api.lender.example/v2/leads')).toEqual({ ok: true, host: 'api.lender.example' })
    expect(httpHostOf('https://api.regal.io:443/')).toEqual({ ok: true, host: 'api.regal.io' })
    expect(httpHostOf('api.regal.io.')).toEqual({ ok: true, host: 'api.regal.io' })
  })

  it('refuses what is not a host name with at least two labels', () => {
    for (const value of ['', '   ', 'localhost', 'regal', 'https://', 'a b.com', 'api..regal.io', '-x.regal.io', 42, null, undefined, { host: 'api.regal.io' }]) {
      expect(httpHostOf(value), JSON.stringify(value)).toMatchObject({ ok: false, problem: 'not_a_host' })
    }
  })

  it('refuses an address that is not https, carries a port other than 443, or carries a login', () => {
    expect(httpHostOf('http://api.regal.io')).toMatchObject({ ok: false, problem: 'not_https' })
    expect(httpHostOf('ftp://api.regal.io')).toMatchObject({ ok: false, problem: 'not_https' })
    expect(httpHostOf('api.regal.io:8443')).toMatchObject({ ok: false, problem: 'port_not_443' })
    expect(httpHostOf('https://api.regal.io:8443/x')).toMatchObject({ ok: false, problem: 'port_not_443' })
    expect(httpHostOf('https://user:pass@api.regal.io')).toMatchObject({ ok: false, problem: 'credentials' })
  })

  it('refuses an address by number, which no host rule can judge, in any spelling the URL parser accepts', () => {
    for (const value of ['10.0.0.1', 'https://127.0.0.1/', '0x7f.1', '2130706433', '[::1]', 'https://[2001:db8::1]/x']) {
      expect(httpHostOf(value), value).toMatchObject({ ok: false, problem: 'ip_address' })
    }
  })

  it('refuses a host another catalogue service owns, naming that service, so its own checks cannot be gone around', () => {
    const cases: Array<[string, string]> = [
      ['api.openai.com', 'OpenAI'],
      ['api.anthropic.com', 'Anthropic'],
      ['slack.com', 'Slack'],
      ['hooks.slack.com', 'Slack'],
      ['trypennie.my.salesforce.com', 'Salesforce'],
      ['trypennie.lightning.force.com', 'Salesforce'],
      ['example.my.salesforce-sites.com', 'Salesforce'],
      ['xy12345.us-east-1.snowflakecomputing.com', 'Snowflake'],
      ['sheets.googleapis.com', 'Google'],
      ['oauth2.googleapis.com', 'Google'],
      ['xvrmivmpfykwwtriqwpg.supabase.co', 'Supabase'],
      ['abc.functions.supabase.co', 'Supabase'],
      ['api.supabase.com', 'Supabase'],
    ]
    for (const [host, service] of cases) {
      expect(httpHostOf(`https://${host}/x`), host).toEqual({ ok: false, problem: 'service_owned', service, host })
    }
  })

  it('does not take a lookalike for a service owned host', () => {
    expect(httpHostOf('notslack.com')).toEqual({ ok: true, host: 'notslack.com' })
    expect(httpHostOf('slack.com.evil.example')).toEqual({ ok: true, host: 'slack.com.evil.example' })
    expect(httpHostOf('mysupabase.co')).toEqual({ ok: true, host: 'mysupabase.co' })
  })

  it('names every domain once, each a lower case host name', () => {
    const domains = HTTP_SERVICE_OWNED_DOMAINS.map((d) => d.domain)
    expect(new Set(domains).size).toBe(domains.length)
    for (const d of domains) expect(d).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
  })
})

describe('hostWithin', () => {
  it('is the domain itself or a host under it, never a lookalike', () => {
    expect(hostWithin('api.x.com', 'x.com')).toBe(true)
    expect(hostWithin('x.com', 'x.com')).toBe(true)
    expect(hostWithin('apix.com', 'x.com')).toBe(false)
    expect(hostWithin('x.com.y', 'x.com')).toBe(false)
  })
})

describe('httpCheckPathOf', () => {
  it('takes a path, or a whole address on the declared host, and keeps its query', () => {
    expect(httpCheckPathOf('/v1/me', 'api.regal.io')).toEqual({ ok: true, path: '/v1/me' })
    expect(httpCheckPathOf('  /v1/contacts?limit=1 ', 'api.regal.io')).toEqual({ ok: true, path: '/v1/contacts?limit=1' })
    expect(httpCheckPathOf('https://api.regal.io/v1/me?x=1', 'api.regal.io')).toEqual({ ok: true, path: '/v1/me?x=1' })
    expect(httpCheckPathOf('https://API.regal.io', 'api.regal.io')).toEqual({ ok: true, path: '/' })
  })

  it('refuses a path that is not one, or an address on another host', () => {
    for (const value of ['', 'v1/me', '//evil.example/x', '/a b', '/x\r\nHost: y', '/x#frag', 'https://other.example/v1/me', 'http://api.regal.io/v1/me', 7, null, `/${'a'.repeat(2048)}`]) {
      expect(httpCheckPathOf(value, 'api.regal.io'), JSON.stringify(value)).toEqual({ ok: false })
    }
  })
})
