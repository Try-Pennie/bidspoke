/**
 * The ops HTTP service as OpsConnections uses it (#2337, phase 7 of #1689):
 * any web API that takes a key, on one declared host. Registered in services.ts.
 *
 * The login is `{ api_key }`: the declared header's whole value ("Bearer abc"
 * for a bearer token, the key alone for a key header). The target is
 * `{ host, header, check_path }` (the catalogue's HTTP connection). Every
 * request goes to the one host the target declares, read by the catalogue's
 * host rule (httpHostOf, schema/http-host.ts), which refuses an address by
 * number and every host another catalogue service owns (Salesforce, Supabase,
 * Snowflake, Google, Slack, OpenAI, Anthropic), so an HTTP connection can never
 * go around those services' own checks. The key is put in the declared header
 * by connectionFetch, never by the caller (the static key minter's
 * headerPlacement).
 *
 * THE EXPIRY SIGNAL is the static key minter's: a 401. connectionFetch renews
 * once, which reads the same key again, and a second 401 is needs_reauth.
 *
 * WHAT VERIFY MEASURES. A GET of the declared check path on the declared host,
 * with the key: a request that needs the key and changes nothing, chosen by
 * the person who adds the connection (decided in #2337). A 2xx proves the key
 * works on that host; the identity is the host, which is what the connection
 * acts as on the page. A 3xx or a 4xx other than 401 and 429 is the check
 * refused (verify_http_check_refused): the path or the key is wrong, and the
 * person fixes it. A 5xx, or no answer, is unreadable. The connection check
 * (../connection-check.ts) asks the same GET every 14 or 15 minutes, so the
 * check path must be cheap. Nothing about the answer is kept or quoted.
 *
 * MONEY. Which hosts bidding itself sends to is known only to the bidding
 * Worker, so the save refuses them there (lib/connection-money-targets.ts,
 * moneyHostOf), before this entry ever sees the connection.
 */
import { httpCheckPathOf, httpHostOf } from '@bidspoke/service-catalogue/schema'
import { IdentityMismatch, IdentityUnreadable, type IdentityProbe } from './identity'
import { targetFields, targetString } from './minters/login-fields'
import { headerPlacement, staticKeyAuth } from './minters/static-key'
import { LoginMintError } from './refusals'
import type { OpsServiceEntry } from './ops-connections'
import type { AuthorizeInput } from './service-rules'

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/

/**
 * Headers that frame or route the request rather than carry a key: a key put
 * in one of them would break the request or be dropped by the platform.
 */
const NOT_A_KEY_HEADER: ReadonlySet<string> = new Set([
  'host', 'content-length', 'content-type', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'expect',
])

/** An authorization scheme ahead of the credential: the credential alone is a secret too. */
const SCHEME_AND_CREDENTIAL = /^\s*[A-Za-z][A-Za-z0-9_-]*\s+(\S+)\s*$/

export interface HttpTarget {
  readonly host: string
  readonly header: string
  readonly checkPath: string
}

/**
 * The host, header and check path a target declares. Throws LoginMintError
 * (not_allowed, target_invalid) when one is missing or one the rules refuse:
 * a host the host rule refuses, a header that is not a header name or frames
 * the request, a check path that is not a path on that host.
 */
export function httpTargetOf(target: unknown): HttpTarget {
  const fields = targetFields(target)
  const host = httpHostOf(targetString(fields, 'host'))
  if (!host.ok) throw new LoginMintError('not_allowed', 'target_invalid')
  const header = targetString(fields, 'header').trim()
  if (!HEADER_NAME.test(header) || NOT_A_KEY_HEADER.has(header.toLowerCase())) throw new LoginMintError('not_allowed', 'target_invalid')
  const check = httpCheckPathOf(targetString(fields, 'check_path'), host.host)
  if (!check.ok) throw new LoginMintError('not_allowed', 'target_invalid')
  return { host: host.host, header, checkPath: check.path }
}

export const httpIdentity: IdentityProbe = {
  kind: 'http',
  async measure(fetch, target) {
    const { host, checkPath } = httpTargetOf(target)
    const response = await fetch(`https://${host}${checkPath}`, { method: 'GET' })
    // Its status only: never the API's body, which could quote anything.
    response.body?.cancel().catch(() => undefined)
    if (response.status >= 200 && response.status < 300) return { kind: 'http', host }
    if (response.status >= 300 && response.status < 500) {
      throw new IdentityMismatch(`the check path answered HTTP ${response.status}, so the key is not proven on it`, 'verify_http_check_refused')
    }
    throw new IdentityUnreadable(`the check path answered HTTP ${response.status}`)
  },
}

export function httpServiceEntry(): OpsServiceEntry {
  return {
    rules: {
      service: 'http',
      declaredHosts: (target) => [httpTargetOf(target).host],
      // A 401: the static key minter's signal.
      expired: (response) => response.status === 401,
      // The target is read first, so a connection declaring no usable host or header is refused by rule before its key is read.
      authorize: async (input: AuthorizeInput) => {
        const { header } = httpTargetOf(input.target)
        const auth = await staticKeyAuth(headerPlacement(header)).authorize(input)
        // "Bearer abc" is scrubbed whole by the login's secrets; "abc" alone, which an API may echo, is a secret too.
        const credential = auth.secrets.flatMap((s) => SCHEME_AND_CREDENTIAL.exec(s)?.[1] ?? [])
        return { headers: auth.headers, secrets: [...auth.secrets, ...credential] }
      },
    },
    identity: httpIdentity,
  }
}
