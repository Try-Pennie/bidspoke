/**
 * The host an HTTP connection declares (#2337, phase 7 of #1689): the one host
 * connectionFetch lets that connection reach. One rule, read by the three
 * places that judge it, so they cannot disagree: the ops HTTP entry's declared
 * hosts (apps/worker src/ops/connections/http-service.ts), the HTTP actions
 * (runtime/http/call.ts), and the bidding Worker's save, which then compares
 * the host against the hosts bidding sends to (lib/connection-money-targets.ts).
 *
 * WHAT IS TAKEN. What a person would paste: a bare host (api.regal.io) or a
 * whole https address, whose host is read out of it (the Controls rule in
 * .impeccable.md). Lower case, one trailing dot dropped.
 *
 * WHAT IS REFUSED, each by name:
 *  - not_a_host: not a host name of at least two labels;
 *  - not_https, port_not_443, credentials: connectionFetch sends only https on
 *    443 with no login in the address, so a declaration it could never reach is
 *    refused when it is made;
 *  - ip_address: an address by number, in any spelling the URL parser
 *    normalises to one (0x7f.1, 2130706433). A host rule judges names, and a
 *    number would let a host every other rule refuses be reached by its address;
 *  - service_owned: a host under a domain another catalogue service reaches
 *    with its own checks (HTTP_SERVICE_OWNED_DOMAINS). An HTTP connection to
 *    Salesforce would go around the ops Salesforce pool and money's identity
 *    check; one to Supabase around the project ref check; one to Snowflake
 *    around the declared user. So those hosts are reached through their own
 *    service or not at all. The worker test http-service.test.ts holds every
 *    registered ops service's hosts to this list, so a new service whose hosts
 *    are missing from it fails there.
 */

/** A domain another service owns, and the service's name as a sentence says it. */
export interface ServiceOwnedDomain {
  readonly domain: string
  readonly service: string
}

export const HTTP_SERVICE_OWNED_DOMAINS: readonly ServiceOwnedDomain[] = [
  { domain: 'anthropic.com', service: 'Anthropic' },
  { domain: 'openai.com', service: 'OpenAI' },
  { domain: 'slack.com', service: 'Slack' },
  { domain: 'salesforce.com', service: 'Salesforce' },
  { domain: 'force.com', service: 'Salesforce' },
  { domain: 'salesforce-sites.com', service: 'Salesforce' },
  { domain: 'my.site.com', service: 'Salesforce' },
  { domain: 'snowflakecomputing.com', service: 'Snowflake' },
  { domain: 'googleapis.com', service: 'Google' },
  { domain: 'supabase.co', service: 'Supabase' },
  { domain: 'supabase.in', service: 'Supabase' },
  { domain: 'supabase.com', service: 'Supabase' },
]

export type HttpHostProblem = 'not_a_host' | 'not_https' | 'port_not_443' | 'credentials' | 'ip_address' | 'service_owned'

export type HttpHost =
  | { readonly ok: true; readonly host: string }
  | { readonly ok: false; readonly problem: Exclude<HttpHostProblem, 'service_owned'> }
  | { readonly ok: false; readonly problem: 'service_owned'; readonly service: string; readonly host: string }

/** The catalogue key of the HTTP service, whose connections declare the host this rule reads. */
export const HTTP_SERVICE_KEY = 'http'

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** The host itself, or a host under it: never a lookalike (notslack.com, slack.com.evil.example). */
export function hostWithin(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/** The https URL a declared value names, or a problem. */
function urlOf(value: unknown): URL | Exclude<HttpHostProblem, 'service_owned' | 'ip_address'> {
  if (typeof value !== 'string') return 'not_a_host'
  const trimmed = value.trim()
  if (trimmed === '' || /\s/.test(trimmed)) return 'not_a_host'
  const hasScheme = SCHEME.test(trimmed)
  if (hasScheme && !/^https:\/\//i.test(trimmed)) return 'not_https'
  let url: URL
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    return 'not_a_host'
  }
  if (url.username !== '' || url.password !== '') return 'credentials'
  if (url.port !== '' && url.port !== '443') return 'port_not_443'
  return url
}

/** The host an HTTP connection's `host` field declares, or why it cannot be one. */
export function httpHostOf(value: unknown): HttpHost {
  const url = urlOf(value)
  if (typeof url === 'string') return { ok: false, problem: url }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  // The URL parser writes every numeric spelling (0x7f.1, 2130706433) as dotted IPv4, and IPv6 in brackets.
  if (host.startsWith('[') || IPV4.test(host)) return { ok: false, problem: 'ip_address' }
  const labels = host.split('.')
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return { ok: false, problem: 'not_a_host' }
  const owned = HTTP_SERVICE_OWNED_DOMAINS.find((d) => hostWithin(host, d.domain))
  if (owned) return { ok: false, problem: 'service_owned', service: owned.service, host }
  return { ok: true, host }
}

/** The longest check path taken. */
export const HTTP_CHECK_PATH_MAX = 2048

/**
 * The path verify and the connection check GET on the declared host: a path
 * starting with one slash (its query kept), or a whole https address on that
 * host, whose path is read out of it. Never a fragment, white space or a
 * control character, and never `//`, which a URL reads as another host.
 */
export function httpCheckPathOf(value: unknown, host: string): { readonly ok: true; readonly path: string } | { readonly ok: false } {
  if (typeof value !== 'string') return { ok: false }
  const trimmed = value.trim()
  let path: string
  if (/^https:\/\//i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return { ok: false }
    }
    if (url.hostname.toLowerCase() !== host || url.port !== '' || url.username !== '' || url.password !== '' || url.hash !== '') return { ok: false }
    path = `${url.pathname}${url.search}`
  } else {
    path = trimmed
  }
  // eslint-disable-next-line no-control-regex
  if (!path.startsWith('/') || path.startsWith('//') || /[\s#\u0000-\u001f\u007f]/.test(path) || path.length > HTTP_CHECK_PATH_MAX) return { ok: false }
  return { ok: true, path }
}
