/**
 * The Salesforce client_credentials minter (#2335, PR 4 of phase 5; Dan's
 * decision 5: a separate ops connected app and integration user in each org).
 *
 * It builds its own token request: there is no shared Salesforce token helper,
 * and the money path's getSalesforceToken and its KV cache are not used and not
 * touched (Hard Rule 1). What it shares with the money path is the judgement of
 * an answer: the session rule (lib/salesforce-api.ts isSalesforceSessionRejected,
 * a 401) and the edge page rule (containsHtmlDocument, in token-endpoint.ts).
 *
 * The login is `{ client_id, client_secret }` of the ops connected app; the
 * target is `{ instance_url, client_id }`. The token is asked of the declared
 * instance's /services/oauth2/token, never a host the login names, and only of
 * an https *.salesforce.com host, so the client secret cannot be sent anywhere
 * else. A login whose client id is not the declared one is refused before
 * anything is asked (verify compares them too, in PR 8).
 *
 * A client_credentials answer carries no expires_in, and a session ends by the
 * org's timeout or a revocation, so the memo's clock is only a ceiling
 * (SALESFORCE_TOKEN_LIFE_MS, the money path's 3500 s): INVALID_SESSION_ID is
 * what really ends a token, and connectionFetch answers it by one renewal that
 * evicts only the rejected token (memo-authorize.ts) and one retry.
 */
import { isSalesforceSessionRejected, salesforceInstanceUrl } from '../../../lib/salesforce-api'
import { TokenMemo } from '../../../lib/token-memo'
import { LoginMintError } from '../refusals'
import type { Authorization, AuthorizeInput, MinterRules } from '../service-rules'
import { authorizeThroughMemo } from './memo-authorize'
import { loginFields, loginString, targetFields, targetString } from './login-fields'
import { readAccessToken, requestToken, type TokenEndpointDeps } from './token-endpoint'

/** The money path's TOKEN_TTL_S (engine/nodes/salesforce.ts), the same ceiling for the same kind of token. */
export const SALESFORCE_TOKEN_LIFE_MS = 3_500_000
export const SALESFORCE_REUSE_MARGIN_MS = 60_000

/** The declared instance as an https Salesforce URL, or target_invalid. */
function instanceOf(target: unknown): URL {
  const raw = targetString(targetFields(target), 'instance_url')
  let url: URL
  try {
    url = new URL(salesforceInstanceUrl(raw))
  } catch {
    throw new LoginMintError('not_allowed', 'target_invalid')
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')
    || !(host === 'salesforce.com' || host.endsWith('.salesforce.com'))) {
    throw new LoginMintError('not_allowed', 'target_invalid')
  }
  return url
}

export function salesforceClientCredentialsAuth(deps: TokenEndpointDeps): MinterRules {
  const memo = new TokenMemo<Authorization>({ now: () => deps.now(), reuseMarginMs: SALESFORCE_REUSE_MARGIN_MS })
  return {
    expired: (response) => isSalesforceSessionRejected(response.status),
    salesforce: {
      instanceHost: (target) => instanceOf(target).hostname.toLowerCase(),
    },
    authorize: async (input: AuthorizeInput): Promise<Authorization> => {
      const instance = instanceOf(input.target)
      const declaredClientId = targetString(targetFields(input.target), 'client_id')
      const login = loginFields(input.login)
      const clientId = loginString(login, 'client_id')
      const clientSecret = loginString(login, 'client_secret')
      if (clientId !== declaredClientId) throw new LoginMintError('refused', 'client_id_mismatch')
      const key = { connectionId: input.connectionId, generation: input.generation, sub: '', scope: '' }
      return authorizeThroughMemo(memo, key, input, async (nowMs) => {
        const json = await requestToken(deps, `${instance.origin}/services/oauth2/token`, new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }))
        const token = readAccessToken(json)
        return { value: { headers: { authorization: `Bearer ${token}` }, secrets: [token] }, expiresAtMs: nowMs + SALESFORCE_TOKEN_LIFE_MS }
      }, { asksTokenEndpoint: true, now: () => deps.now() })
    },
  }
}
