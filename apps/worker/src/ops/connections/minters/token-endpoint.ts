/**
 * The one OAuth token request the ops minters make, and the one way its answer
 * is judged (#2335, PR 4 of phase 5; Dan's decision 2). Salesforce's
 * client_credentials and Google's jwt-bearer grant both come through here.
 *
 *   2xx with a JSON object            the token response
 *   429                               rate_limited, at its Retry-After
 *   5xx, or an HTML page at any status unavailable: the request died at an edge
 *                                     before the provider judged it, the same
 *                                     rule the money path's token fetch uses
 *                                     (containsHtmlDocument, #694)
 *   no answer in time, or no answer   unavailable
 *   3xx                               refused: the token endpoint is at another
 *                                     address, which a person must correct
 *   any other 4xx                     refused, by the OAuth error code when it
 *                                     is one of the standard few, else
 *                                     login_refused
 *
 * Every failure is a LoginMintError carrying only a kind and a reason from a
 * closed set (F120): nothing the endpoint said and nothing that was sent rides
 * out on it. A redirect is never followed, so the client secret or the signed
 * assertion cannot be carried to a host nobody declared.
 */
import { containsHtmlDocument } from '../../../lib/html-error-summary'
import { retryAfterAt } from '../connection-fetch'
import { LoginMintError, type MintFailureReason } from '../refusals'

/** Under connectionFetch's 60 s deadline, as the money path's token fetch is (SALESFORCE_TOKEN_TIMEOUT_MS). */
export const TOKEN_ENDPOINT_TIMEOUT_MS = 10_000

/** What a minter is built with: its clock, and its own token timeout. Its fetch comes with each call (AuthorizeInput.fetch, #2337). */
export interface MinterClockDeps {
  /** Epoch ms (L524: injected). */
  now(): number
  /** Defaults to TOKEN_ENDPOINT_TIMEOUT_MS. */
  tokenTimeoutMs?: number
}

export interface TokenEndpointDeps extends MinterClockDeps {
  /**
   * For a minter, AuthorizeInput.fetch: connectionFetch's own, held to the
   * connection's declared hosts. A LoginMintError it throws passes through.
   */
  fetch(input: string, init?: RequestInit): Promise<Response>
}

/** The OAuth error codes named as themselves; any other refusal is login_refused. */
const OAUTH_REFUSALS: Readonly<Record<string, MintFailureReason<'refused'>>> = {
  invalid_grant: 'invalid_grant',
  invalid_client: 'invalid_client',
  // Salesforce's spelling of an unknown client id.
  invalid_client_id: 'invalid_client',
  unauthorized_client: 'unauthorized_client',
  invalid_scope: 'invalid_scope',
  access_denied: 'access_denied',
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** POST a form to a token endpoint. Answers the parsed token response, or throws a LoginMintError by kind. */
export async function requestToken(deps: TokenEndpointDeps, url: string, body: URLSearchParams): Promise<Readonly<Record<string, unknown>>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.tokenTimeoutMs ?? TOKEN_ENDPOINT_TIMEOUT_MS)
  let status: number
  let text: string
  let retryAfter: string | null
  try {
    const res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      redirect: 'manual',
      signal: controller.signal,
    })
    status = res.status
    retryAfter = res.headers.get('retry-after')
    // The timeout covers the body too: a body that never finishes holds the call as long.
    text = await res.text()
  } catch (err) {
    // A refusal the fetch made by rule before sending (connectionFetch's token fetch, #2337) is that refusal, not an unreachable endpoint.
    if (err instanceof LoginMintError) throw err
    throw new LoginMintError('unavailable', controller.signal.aborted ? 'token_endpoint_timeout' : 'token_endpoint_unreachable')
  } finally {
    clearTimeout(timer)
  }

  if (status === 429) {
    const at = retryAfter === null ? null : retryAfterAt(retryAfter, deps.now())
    throw new LoginMintError('rate_limited', 'token_endpoint_rate_limited', at === null ? null : new Date(at))
  }
  if (containsHtmlDocument(text)) throw new LoginMintError('unavailable', 'token_endpoint_edge_page')
  if (status >= 500) throw new LoginMintError('unavailable', 'token_endpoint_5xx')
  if (status >= 300 && status < 400) throw new LoginMintError('refused', 'token_endpoint_redirected')
  const json = parseJson(text)
  if (status >= 400) {
    const code = isObject(json) && typeof json.error === 'string' ? json.error : ''
    // An own key only: a provider's 'constructor' must not reach Object.prototype.
    throw new LoginMintError('refused', Object.hasOwn(OAUTH_REFUSALS, code) ? OAUTH_REFUSALS[code] : 'login_refused')
  }
  if (!isObject(json)) throw new LoginMintError('unavailable', 'token_response_malformed')
  return json
}

/** The access_token of a token response, or unavailable when there is none. */
export function readAccessToken(json: Readonly<Record<string, unknown>>): string {
  const token = json.access_token
  if (typeof token !== 'string' || token === '') throw new LoginMintError('unavailable', 'token_response_malformed')
  return token
}
