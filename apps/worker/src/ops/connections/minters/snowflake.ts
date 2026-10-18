/**
 * The Snowflake key pair minter (#2335, PR 4 of phase 5). Signs a JWT with the
 * connection's own private key for the account and user its target declares,
 * by the export path's own signer (lib/snowflake.ts signSnowflakeJwt, exported
 * unchanged), so both lanes sign one way. There is no token endpoint: the JWT
 * is the bearer, so nothing here can be refresh_failing.
 *
 * The login is `{ "private_key": "<PEM>" }`; the target is `{ account, user }`,
 * the identity verify measures with CURRENT_USER() (PR 8). The expiry signal is
 * a 401 (Snowflake's 390318 expired and 390144 invalid both answer 401): the
 * one renewal signs afresh, and a second 401 is needs_reauth.
 *
 * Memoised per connection, generation and user, reused until
 * SNOWFLAKE_REUSE_MARGIN_MS before the hour Snowflake allows a JWT.
 */
import { JWT_LIFETIME_SECONDS, importPrivateKey, signSnowflakeJwt } from '../../../lib/snowflake'
import { TokenMemo } from '../../../lib/token-memo'
import { LoginMintError } from '../refusals'
import type { Authorization, AuthorizeInput, MinterRules } from '../service-rules'
import { authorizeThroughMemo } from './memo-authorize'
import { loginFields, loginString, targetFields, targetString } from './login-fields'

/** Far more than a connectionFetch call (60 s) can hold a header for. */
export const SNOWFLAKE_REUSE_MARGIN_MS = 5 * 60_000

/** An account locator with its region, as the export's SNOWFLAKE_ACCOUNT is written. */
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function snowflakeKeyPairAuth(deps: { now(): number }): MinterRules {
  const memo = new TokenMemo<Authorization>({ now: () => deps.now(), reuseMarginMs: SNOWFLAKE_REUSE_MARGIN_MS })
  return {
    expired: (response) => response.status === 401,
    authorize: async (input: AuthorizeInput): Promise<Authorization> => {
      const target = targetFields(input.target)
      const account = targetString(target, 'account')
      const user = targetString(target, 'user')
      if (!ACCOUNT.test(account)) throw new LoginMintError('not_allowed', 'target_invalid')
      const pem = loginString(loginFields(input.login), 'private_key')
      const key = { connectionId: input.connectionId, generation: input.generation, sub: user.toUpperCase(), scope: '' }
      return authorizeThroughMemo(memo, key, input, async (nowMs) => {
        let privateKey: CryptoKey
        try {
          privateKey = await importPrivateKey(pem)
        } catch {
          throw new LoginMintError('refused', 'login_malformed')
        }
        const iat = Math.floor(nowMs / 1000)
        const jwt = await signSnowflakeJwt({ account, user }, privateKey, iat)
        return {
          value: { headers: { authorization: `Bearer ${jwt}`, 'x-snowflake-authorization-token-type': 'KEYPAIR_JWT' }, secrets: [jwt] },
          expiresAtMs: (iat + JWT_LIFETIME_SECONDS) * 1000,
        }
      }, { asksTokenEndpoint: false, now: () => deps.now() })
    },
  }
}
