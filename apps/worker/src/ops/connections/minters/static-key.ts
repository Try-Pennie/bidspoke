/**
 * The static key minter (#2335, PR 4 of phase 5): Slack's ops bot token
 * (decision 6), OpenAI's and Anthropic's API keys, a Supabase key and a plain
 * HTTP key. Nothing is minted and nothing is memoised: the key is read from the
 * opened login on each request and put where the service reads it. Its expiry
 * signal is a 401, and the one renewal reads the same key again, so a revoked
 * key is refused twice and becomes needs_reauth (connectionFetch).
 *
 * The login is `{ "<field>": "<key>" }`, the field named by the placement.
 */
import type { Authorization, AuthorizeInput, MinterRules } from '../service-rules'
import { loginFields, loginString } from './login-fields'

export interface StaticKeyPlacement {
  /** The login field holding the key. */
  readonly field: string
  /** The headers the key goes in. */
  readonly headers: (key: string) => Readonly<Record<string, string>>
}

export const STATIC_KEY_PLACEMENTS = {
  /** OpenAI, and any API taking `Authorization: Bearer`. */
  bearer: { field: 'api_key', headers: (key) => ({ authorization: `Bearer ${key}` }) },
  /** The ops Slack bot (decision 6). */
  slackBot: { field: 'bot_token', headers: (key) => ({ authorization: `Bearer ${key}` }) },
  anthropic: { field: 'api_key', headers: (key) => ({ 'x-api-key': key }) },
  /** A Supabase project's key: PostgREST reads both. */
  supabase: { field: 'service_key', headers: (key) => ({ apikey: key, authorization: `Bearer ${key}` }) },
} as const satisfies Record<string, StaticKeyPlacement>

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

/** A key sent in one named header (an HTTP connection's declared header). */
export function headerPlacement(header: string, field = 'api_key'): StaticKeyPlacement {
  if (!HEADER_NAME.test(header)) throw new Error('headerPlacement: the header is not a header name')
  const name = header.toLowerCase()
  return { field, headers: (key) => ({ [name]: key }) }
}

export function staticKeyAuth(placement: StaticKeyPlacement): MinterRules {
  return {
    expired: (response) => response.status === 401,
    // A promise whose executor throws rejects, so a malformed login is a rejection like every other minter's.
    authorize: (input: AuthorizeInput): Promise<Authorization> => new Promise((resolve) => {
      const key = loginString(loginFields(input.login), placement.field)
      resolve({ headers: placement.headers(key), secrets: [key] })
    }),
  }
}
