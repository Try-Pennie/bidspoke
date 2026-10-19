/**
 * What crosses into and out of a ConnectionTokenObject (#2335, PR 5 of phase 5
 * of #1689), in one place the object and the person bound minter both import.
 * Each side parses what it receives (L50): an RPC argument or answer is
 * whatever the other side's code put there, possibly an older release's.
 *
 * In: the sealed envelope (ciphertext only, the object opens it itself), its
 * generation, and the provider's token endpoint; for a code exchange, the code,
 * its PKCE verifier and the redirect URI it was issued for. Out: an access
 * token and an id the minter names it by on a renewal, or a failure made only
 * of a kind and a reason from refusals.ts's closed sets (F120). The refresh
 * token never leaves the object.
 */
import { LOGIN_MINT_KINDS, MINT_FAILURE_REASONS, type LoginMintKind, type MintFailureReason } from './refusals'

/** What every call names: the connection, and the login it holds. */
export interface TokenObjectLogin {
  readonly organizationId: string
  readonly connectionId: string
  readonly service: string
  /** The generation the envelope is sealed under (its AAD). */
  readonly generation: number
  /** The seal's envelope: ciphertext only. */
  readonly envelope: unknown
  /** The provider's token endpoint for this connection, from the service's rules. */
  readonly tokenUrl: string
}

export interface AccessTokenRequest extends TokenObjectLogin {
  /** The id of a token the service just rejected, so the object drops it only if it still holds that one. */
  readonly rejectedTokenId: string | null
}

export interface ExchangeRequest extends TokenObjectLogin {
  readonly code: string
  readonly verifier: string
  readonly redirectUri: string
}

export interface TokenObjectFailure {
  readonly ok: false
  readonly kind: LoginMintKind
  readonly reason: MintFailureReason
  readonly retryAtMs: number | null
}

export type AccessTokenAnswer =
  | {
      readonly ok: true
      readonly token: string
      /** A random id for this token, never derived from it. */
      readonly tokenId: string
      readonly expiresAtMs: number
      /** Whether the token endpoint was asked for it (Dan's decision 2: only that ends a refresh streak). */
      readonly minted: boolean
    }
  | TokenObjectFailure

/** The generation the exchanged login is sealed under, never a token. */
export type ExchangeAnswer = { readonly ok: true; readonly generation: number } | TokenObjectFailure

export class TokenObjectContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenObjectContractError'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SERVICE = /^[a-z][a-z0-9_]{0,63}$/
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)
const nonEmpty = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** An https URL with no credentials and the default port: where a token request may go. */
export function isTokenUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '' && (url.port === '' || url.port === '443')
}

function parseLogin(raw: unknown): TokenObjectLogin {
  if (!isRecord(raw)) throw new TokenObjectContractError('the request is not an object')
  const { organizationId, connectionId, service, generation, envelope, tokenUrl } = raw
  if (typeof organizationId !== 'string' || !UUID.test(organizationId)) throw new TokenObjectContractError('the request names no organization uuid')
  if (typeof connectionId !== 'string' || !UUID.test(connectionId)) throw new TokenObjectContractError('the request names no connection uuid')
  if (typeof service !== 'string' || !SERVICE.test(service)) throw new TokenObjectContractError('the request names no service')
  if (!isWhole(generation) || generation < 1) throw new TokenObjectContractError('the request\'s generation is not a whole number of at least 1')
  if (!isRecord(envelope) || !nonEmpty(envelope.iv, 64)) throw new TokenObjectContractError('the request carries no envelope')
  if (!isTokenUrl(tokenUrl)) throw new TokenObjectContractError('the token endpoint is not an https URL')
  return { organizationId, connectionId, service, generation, envelope, tokenUrl }
}

export function parseAccessTokenRequest(raw: unknown): AccessTokenRequest {
  const login = parseLogin(raw)
  const rejectedTokenId = (raw as Record<string, unknown>).rejectedTokenId
  if (!(rejectedTokenId === null || rejectedTokenId === undefined || nonEmpty(rejectedTokenId, 64))) {
    throw new TokenObjectContractError('the rejected token id is not an id')
  }
  return { ...login, rejectedTokenId: rejectedTokenId ?? null }
}

export function parseExchangeRequest(raw: unknown): ExchangeRequest {
  const login = parseLogin(raw)
  const { code, verifier, redirectUri } = raw as Record<string, unknown>
  if (!nonEmpty(code, 4096)) throw new TokenObjectContractError('the request carries no authorization code')
  // RFC 7636: a verifier is 43 to 128 characters.
  if (typeof verifier !== 'string' || verifier.length < 43 || verifier.length > 128) throw new TokenObjectContractError('the request carries no PKCE verifier')
  if (!isTokenUrl(redirectUri)) throw new TokenObjectContractError('the redirect URI is not an https URL')
  return { ...login, code, verifier, redirectUri }
}

function parseFailure(raw: Record<string, unknown>): TokenObjectFailure {
  const { kind, reason, retryAtMs } = raw
  if (!(LOGIN_MINT_KINDS as readonly unknown[]).includes(kind)) throw new TokenObjectContractError('the object answered a failure of a kind this code does not know')
  const reasons = MINT_FAILURE_REASONS[kind as LoginMintKind] as readonly unknown[]
  if (!reasons.includes(reason)) throw new TokenObjectContractError('the object answered a failure for a reason this code does not know')
  if (!(retryAtMs === null || isWhole(retryAtMs))) throw new TokenObjectContractError('the object answered an unreadable retry time')
  return { ok: false, kind: kind as LoginMintKind, reason: reason as MintFailureReason, retryAtMs }
}

export function parseAccessTokenAnswer(raw: unknown): AccessTokenAnswer {
  if (!isRecord(raw)) throw new TokenObjectContractError('the object answered something other than an object')
  if (raw.ok === false) return parseFailure(raw)
  if (raw.ok !== true) throw new TokenObjectContractError('the object answered neither ok nor a failure')
  const { token, tokenId, expiresAtMs, minted } = raw
  if (!nonEmpty(token, 16_384) || !nonEmpty(tokenId, 64) || !isWhole(expiresAtMs) || typeof minted !== 'boolean') {
    throw new TokenObjectContractError('the object answered a token in a shape this code does not read')
  }
  return { ok: true, token, tokenId, expiresAtMs, minted }
}

/**
 * A reseal of the login the object holds, during a rotation of the ops key
 * (#2333): the connection it is asked about, and whether to write (apply) or
 * only say what it would do (the default).
 */
export interface ResealLoginRequest {
  readonly organizationId: string
  readonly connectionId: string
  readonly service: string
  readonly apply: boolean
}

/**
 * What the object holds, and what the reseal did with it:
 *   none          no login (the connection is not person bound, or its login was handed back and given up)
 *   current       under the current kid already
 *   would_reseal  under an old kid; a preview, so nothing was written
 *   resealed      was under fromKid, and is now under the current kid, at the same generation
 */
export const RESEAL_LOGIN_STATES = ['none', 'current', 'would_reseal', 'resealed'] as const
export type ResealLoginState = (typeof RESEAL_LOGIN_STATES)[number]

/**
 * Why a reseal did nothing, by name (L11):
 *   refused         the request was malformed, or named another connection, organization or service than the login's
 *   busy            a refresh or a consent was in flight; run it again
 *   no_current_kid  no kid is current, so nothing may be sealed
 *   no_key          the login's kid has no private key on this Worker (NEXT unset, or the wrong key in it)
 *   open_failed     the login did not open under its kid's key
 *   failed          anything else, named by nothing it held
 */
export const RESEAL_LOGIN_REFUSALS = ['refused', 'busy', 'no_current_kid', 'no_key', 'open_failed', 'failed'] as const
export type ResealLoginRefusal = (typeof RESEAL_LOGIN_REFUSALS)[number]

export type ResealLoginAnswer =
  | { readonly ok: true; readonly state: ResealLoginState; readonly fromKid: string | null }
  | { readonly ok: false; readonly reason: ResealLoginRefusal }

export function parseResealLoginRequest(raw: unknown): ResealLoginRequest {
  if (!isRecord(raw)) throw new TokenObjectContractError('the reseal request is not an object')
  const { organizationId, connectionId, service, apply } = raw
  if (typeof organizationId !== 'string' || !UUID.test(organizationId)) throw new TokenObjectContractError('the reseal request names no organization uuid')
  if (typeof connectionId !== 'string' || !UUID.test(connectionId)) throw new TokenObjectContractError('the reseal request names no connection uuid')
  if (typeof service !== 'string' || !SERVICE.test(service)) throw new TokenObjectContractError('the reseal request names no service')
  if (!(apply === undefined || typeof apply === 'boolean')) throw new TokenObjectContractError('the reseal request\'s apply is not true or false')
  return { organizationId, connectionId, service, apply: apply === true }
}

export function parseResealLoginAnswer(raw: unknown): ResealLoginAnswer {
  if (!isRecord(raw)) throw new TokenObjectContractError('the object answered the reseal with something other than an object')
  if (raw.ok === false) {
    if (!(RESEAL_LOGIN_REFUSALS as readonly unknown[]).includes(raw.reason)) throw new TokenObjectContractError('the object refused the reseal for a reason this code does not know')
    return { ok: false, reason: raw.reason as ResealLoginRefusal }
  }
  if (raw.ok !== true) throw new TokenObjectContractError('the object answered the reseal with neither ok nor a refusal')
  const { state, fromKid } = raw
  if (!(RESEAL_LOGIN_STATES as readonly unknown[]).includes(state)) throw new TokenObjectContractError('the object answered the reseal with a state this code does not know')
  if ((state === 'none') !== (fromKid === null) || !(fromKid === null || nonEmpty(fromKid, 64))) {
    throw new TokenObjectContractError('the object answered the reseal with an unreadable kid')
  }
  return { ok: true, state: state as ResealLoginState, fromKid: fromKid as string | null }
}

export function parseExchangeAnswer(raw: unknown): ExchangeAnswer {
  if (!isRecord(raw)) throw new TokenObjectContractError('the object answered something other than an object')
  if (raw.ok === false) return parseFailure(raw)
  if (raw.ok !== true || !isWhole(raw.generation) || raw.generation < 2) throw new TokenObjectContractError('the object answered an exchange in a shape this code does not read')
  return { ok: true, generation: raw.generation }
}
