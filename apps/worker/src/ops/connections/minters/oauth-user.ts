/**
 * The person bound minter and exchangeOAuthCode (#2335, PR 5 of phase 5 of
 * #1689; Dan's decision 1 of 2026-10-17: build person bound logins now).
 *
 * A person bound connection is an OAuth user login. Its refresh happens in the
 * connection's ConnectionTokenObject (../../connection-token-object.ts), which
 * makes it single flight and keeps a rotated refresh token in its storage
 * before it answers, then hands it back to the declared home by alarm. This
 * module is the ops side's door to that object:
 *
 *  - oauthUserAuth: the ServiceRules auth (a MinterRules) a person bound service
 *    takes. It checks the per isolate TokenMemo first (keyed connection and
 *    generation), then asks the object, handing it the sealed envelope
 *    connectionFetch opened, ciphertext only, and the provider's token
 *    endpoint. On a renewal after the service's expiry signal, it names the
 *    rejected token to the object by an id, never the token, so the object
 *    drops that one only if it still holds it. The object's failure comes back
 *    as a kind and a reason, thrown as a LoginMintError, so connectionFetch
 *    applies Dan's decision 2 to it as to every other login.
 *  - exchangeOAuthCode: a person's consent. The caller (the OpsConnections
 *    entrypoint, PR 8 of this phase) passes the row's sealed app login as a
 *    candidate with the code, its PKCE verifier and the redirect URI. It is held
 *    to connectionFetch's candidate rules, then handed to the object, which
 *    stores the new login before it answers and answers only its generation.
 *
 * A CANDIDATE IS NOT REFRESHED. Refreshing an uncommitted person bound login
 * for one call and dropping the answer would spend a rotating refresh token
 * (L5), so verify and Reconnect of a person bound connection are its code
 * exchange; a candidate reaching this auth is refused by rule.
 *
 * WHAT CROSSES INTO THE OBJECT: the envelope (ciphertext), the generation, the
 * token endpoint, and for an exchange the code, verifier and redirect URI, by
 * RPC within the ops Worker. WHAT LEAVES: an access token, to connectionFetch
 * only, or a failure of names alone (F120); the refresh token never leaves the
 * object.
 *
 * WHO CALLS IT. Nothing that runs, in the deploy that adds it: no service has
 * person bound rules until the catalogue gives it some (Phase 7), and the
 * entrypoint that calls exchangeOAuthCode is PR 8. WHOSE DATA: one connection
 * of the caller's organization, whose AAD names that organization.
 */
import type { ConnectionTokenObject } from '../../connection-token-object'
import { organizationIdFrom, type OrganizationId } from '../../ops-db'
import { TokenMemo } from '../../../lib/token-memo'
import { checkCandidate, type CandidateConnection, type ConnectionFetchDeps } from '../connection-fetch'
import { ConnectionRefusal, LoginMintError, type ConnectionRefusalCode, type LoginMintKind } from '../refusals'
import type { Authorization, AuthorizeInput, MinterRules } from '../service-rules'
import {
  isTokenUrl, parseAccessTokenAnswer, parseExchangeAnswer, type AccessTokenRequest, type ExchangeRequest, type TokenObjectFailure,
} from '../token-object-contract'
import { authorizeThroughMemo } from './memo-authorize'

/** Reused until this long before the object's stated expiry, as the object itself does. */
export const OAUTH_USER_REUSE_MARGIN_MS = 60_000

/** What a person bound service supplies. */
export interface OAuthUserService {
  /** The provider's token endpoint for this connection (https). Throws LoginMintError not_allowed target_invalid on a target it cannot read. */
  tokenUrl(target: unknown): string
  /** The service's declared expiry signal. */
  expired(response: Response): boolean | Promise<boolean>
}

/** One connection's ConnectionTokenObject, as this module reaches it. */
export interface TokenObjectStub {
  accessToken(request: AccessTokenRequest): Promise<unknown>
  exchange(request: ExchangeRequest): Promise<unknown>
}

export interface TokenObjects {
  get(connectionId: string): TokenObjectStub
}

/** The ops Worker's CONNECTION_TOKENS binding: one object per connection, named by its id. */
export function tokenObjectsOf(namespace: DurableObjectNamespace<ConnectionTokenObject>): TokenObjects {
  return {
    get: (connectionId) => {
      const stub = namespace.get(namespace.idFromName(connectionId))
      return {
        accessToken: (request) => stub.accessToken(request),
        exchange: (request) => stub.exchange(request),
      }
    },
  }
}

export interface OAuthUserDeps {
  tokens: TokenObjects
  /** Epoch ms, for the memo (L524: injected). */
  now(): number
}

function tokenUrlOf(service: OAuthUserService, target: unknown): string {
  const url = service.tokenUrl(target)
  if (!isTokenUrl(url)) throw new LoginMintError('not_allowed', 'target_invalid')
  return url
}

function mintErrorOf(failure: TokenObjectFailure): LoginMintError {
  return new LoginMintError(failure.kind, failure.reason, failure.retryAtMs === null ? null : new Date(failure.retryAtMs))
}

export function oauthUserAuth(deps: OAuthUserDeps, service: OAuthUserService): MinterRules {
  const memo = new TokenMemo<Authorization>({ now: () => deps.now(), reuseMarginMs: OAUTH_USER_REUSE_MARGIN_MS })
  // The object's id for each token this isolate handed out, so a renewal names the rejected one without carrying it.
  const tokenIds = new WeakMap<Authorization, string>()
  return {
    expired: (response) => service.expired(response),
    authorize: async (input: AuthorizeInput): Promise<Authorization> => {
      if (input.candidate) throw new LoginMintError('not_allowed', 'candidate_not_refreshable')
      const tokenUrl = tokenUrlOf(service, input.target)
      const key = { connectionId: input.connectionId, generation: input.generation, sub: '', scope: '' }
      return authorizeThroughMemo(memo, key, input, async () => {
        let raw: unknown
        try {
          raw = await deps.tokens.get(input.connectionId).accessToken({
            organizationId: input.organizationId,
            connectionId: input.connectionId,
            service: input.service,
            generation: input.generation,
            envelope: input.envelope,
            tokenUrl,
            rejectedTokenId: input.renew ? tokenIds.get(input.renew.rejected) ?? null : null,
          })
        } catch {
          throw new LoginMintError('token_object_unavailable', 'token_object_unavailable')
        }
        let answer
        try {
          answer = parseAccessTokenAnswer(raw)
        } catch {
          throw new LoginMintError('token_object_unavailable', 'token_object_unavailable')
        }
        if (!answer.ok) throw mintErrorOf(answer)
        // Only a token the endpoint was asked for ends a refresh streak (decision 2).
        if (answer.minted) input.noteMint()
        const value: Authorization = { headers: { authorization: `Bearer ${answer.token}` }, secrets: [answer.token] }
        tokenIds.set(value, answer.tokenId)
        return { value, expiresAtMs: answer.expiresAtMs }
      }, { asksTokenEndpoint: false, now: () => deps.now() })
    },
  }
}

export interface ExchangeOAuthCodeCall {
  readonly organizationId: OrganizationId
  readonly connectionId: string
  /** The row's sealed app login, generation, target and service, from bidding: ciphertext and public config only. */
  readonly candidate: CandidateConnection
  readonly code: string
  readonly verifier: string
  readonly redirectUri: string
}

export interface ExchangeOAuthCodeDeps {
  tokens: TokenObjects
  readCopy: ConnectionFetchDeps['readCopy']
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Each kind of failed exchange, by name. A candidate's failure records nothing about the connection (F126). */
const EXCHANGE_REFUSALS: Readonly<Record<LoginMintKind, ConnectionRefusalCode>> = {
  refused: 'connection_needs_reauth',
  unavailable: 'connection_auth_unavailable',
  rate_limited: 'connection_auth_unavailable',
  not_allowed: 'connection_not_allowed',
  check_unavailable: 'connection_auth_check_unavailable',
  token_object_unavailable: 'connection_token_object_unavailable',
}

function invalid(detail: string): ConnectionRefusal {
  return new ConnectionRefusal('connection_call_invalid', detail)
}

/**
 * A person's consent exchanged for the connection's first refresh token, kept
 * by its ConnectionTokenObject and handed back to the declared home by alarm.
 * Answers the generation the new login is sealed under, never a token. Throws a
 * ConnectionRefusal by name, built from names alone (F120).
 */
export async function exchangeOAuthCode(deps: ExchangeOAuthCodeDeps, service: OAuthUserService, call: ExchangeOAuthCodeCall): Promise<{ generation: number }> {
  try {
    organizationIdFrom(call.organizationId)
  } catch {
    throw invalid('the organization is not a uuid')
  }
  if (typeof call.connectionId !== 'string' || !UUID.test(call.connectionId)) throw invalid('the connection id is not a uuid')
  if (typeof call.code !== 'string' || call.code === '' || call.code.length > 4096) throw invalid('the authorization code is missing')
  if (typeof call.verifier !== 'string' || call.verifier.length < 43 || call.verifier.length > 128) throw invalid('the PKCE verifier is not 43 to 128 characters')
  if (!isTokenUrl(call.redirectUri)) throw invalid('the redirect URI is not an https URL')

  await checkCandidate(deps.readCopy, call.organizationId, call.connectionId, call.candidate)

  let tokenUrl: string
  try {
    tokenUrl = tokenUrlOf(service, call.candidate.target)
  } catch {
    throw new ConnectionRefusal('connection_target_invalid', `the ${call.candidate.service} connection's target does not name its token endpoint`)
  }

  let raw: unknown
  try {
    raw = await deps.tokens.get(call.connectionId).exchange({
      organizationId: call.organizationId,
      connectionId: call.connectionId,
      service: call.candidate.service,
      generation: call.candidate.generation,
      envelope: call.candidate.envelope,
      tokenUrl,
      code: call.code,
      verifier: call.verifier,
      redirectUri: call.redirectUri,
    })
  } catch {
    throw new ConnectionRefusal('connection_token_object_unavailable', `the ${call.candidate.service} login's token object could not be reached`)
  }
  let answer
  try {
    answer = parseExchangeAnswer(raw)
  } catch {
    throw new ConnectionRefusal('connection_token_object_unavailable', `the ${call.candidate.service} login's token object answered in a shape this code does not read`)
  }
  if (!answer.ok) {
    throw new ConnectionRefusal(
      EXCHANGE_REFUSALS[answer.kind],
      `the ${call.candidate.service} authorization code exchange failed: ${answer.kind}: ${answer.reason}`,
      answer.retryAtMs === null ? null : new Date(answer.retryAtMs),
    )
  }
  return { generation: answer.generation }
}
