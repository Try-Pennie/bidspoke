/**
 * ConnectionTokenObject: one per person bound connection, on the ops Worker
 * (#2334 made it, inert; #2335 PR 5 of phase 5 of #1689 makes it live; plan:
 * discussion #2329, part 2; Dan's decision 1 of 2026-10-17: build person bound
 * logins now).
 *
 * WHAT IT IS FOR. A person bound connection is an OAuth user login: the app's
 * client id and secret plus the person's refresh token, sealed to the ops key.
 * An access token is minted from the refresh token, and many providers ROTATE
 * the refresh token on every refresh: the old one is dead the moment the
 * provider answers. So a refresh must happen once at a time per connection
 * (single flight, here), and the new refresh token must be kept before anything
 * else can go wrong (L33, L561).
 *
 * THE ORDER, and why:
 *  1. Single flight. A refresh in flight is held in memory with the time it
 *     started (on the injected clock); a caller arriving meanwhile awaits the
 *     holder's answer and never calls the token endpoint itself. The marker is
 *     cleared when the holder's refresh settles, success or failure.
 *  2. The rotated refresh token is sealed to the ops public key and written to
 *     this object's storage, with an alarm set, BEFORE the access token is
 *     returned. A crash after that write keeps it; a crash between the
 *     provider's answer and the write cannot be closed by any order, and the
 *     next refresh then meets invalid_grant, which is needs_reauth.
 *  3. The write back to the declared home (service_connections.credential_enc,
 *     L83) is the alarm's alone: a compare and set through
 *     OPS_GATEWAY.storeRotatedEnvelope on the generation this object last knew
 *     the row at, retried with backoff while bidding is down.
 *
 * THE HANDOVER (one home, stated). While this object holds a generation ahead
 * of the row, it is authoritative for that connection's login; once the
 * compare and set lands, the row is again, and the object's copy is the same
 * envelope. A caller hands in the copy it holds (connection_copy); the object
 * uses its own login only when it is newer than that copy, or the same one, and
 * gives its own up the moment the copy is ahead or the row answers that it
 * moved (a Reconnect) or is gone (a removal). Each rotation is sealed under a
 * generation above both, so the row only ever takes this object's envelope at a
 * generation nobody else wrote. A lost answer is told from a Reconnect by the
 * envelope's iv, which every seal draws afresh: the sends whose answers never
 * came back are kept until one does.
 *
 * WHAT LEAVES (F120). A failure is a kind and a reason from refusals.ts's
 * closed sets, nothing a provider said and nothing that was sent. The refresh
 * token never leaves; the access token leaves only as the answer to the ops
 * minter that asked (minters/oauth-user.ts). Nothing here writes to the
 * console (the connection-seal-open-callers guard refuses it).
 *
 * WHO MAY CALL IT. Only the ops Worker, through its own CONNECTION_TOKENS
 * binding, by RPC: a Durable Object has no public route, its fetch handler
 * serves nothing, and the bidding Worker binds no ops object. WHOSE DATA. One
 * connection: the object is named by the connection id, every request must name
 * the connection and organization its login was sealed for (the AAD, so another
 * organization fails in the cipher), and its write back names that
 * organization's row.
 *
 * Who calls it in this deploy: nothing that runs. The person bound minter and
 * exchangeOAuthCode (minters/oauth-user.ts) call it, and they are reached only
 * once a person bound service has rules on this Worker (Phase 7) and the
 * OpsConnections entrypoint exists (PR 8 of this phase).
 */
import { DurableObject } from 'cloudflare:workers'
import { CURRENT_OPS_KID, open, OPS_CONNECTION_PUBLIC_KEYS, seal, type KeyRing, type SealedEnvelope } from '@bidspoke/connection-seal'
import { parseStoreRotatedEnvelopeAnswer, type OpsGatewayBinding, type StoreRotatedEnvelopeAnswer } from '../lib/ops-gateway-contract'
import type { OpsEnv } from './index'
import { LoginMintError, type LoginMintKind, type MintFailureReason } from './connections/refusals'
import { readAccessToken, requestToken, TOKEN_ENDPOINT_TIMEOUT_MS } from './connections/minters/token-endpoint'
import {
  parseAccessTokenRequest, parseExchangeRequest, type AccessTokenAnswer, type ExchangeAnswer, type TokenObjectFailure, type TokenObjectLogin,
} from './connections/token-object-contract'

/** What the fetch handler answers: the object is reached by RPC only. */
export const CONNECTION_TOKEN_OBJECT_RPC_ONLY = 'connection_token_object_rpc_only'

/** A holder that has not settled in this long is presumed dead, and the next caller refreshes (well past the token request's own timeout). */
export const IN_FLIGHT_STALE_MS = 30_000
/** A held access token is reused until this long before it expires. */
export const ACCESS_REUSE_MARGIN_MS = 60_000
/** An access token whose answer gives no expires_in is held at most this long (the Salesforce money path's ceiling for the same kind of token). */
export const ACCESS_DEFAULT_LIFE_MS = 3_500_000
/** The write back's wait on the gateway, as the minute tick waits on it. */
export const WRITE_BACK_DEADLINE_MS = 15_000
/** The write back's retry, doubling from the first to the ceiling while bidding stays down. */
export const WRITE_BACK_RETRY_MIN_MS = 30_000
export const WRITE_BACK_RETRY_MAX_MS = 15 * 60_000
/** Sends whose answers never came back, kept to recognise one that landed. The oldest goes first past this. */
export const MAX_UNANSWERED_SENDS = 50

/** The login this object holds: a rotated one, sealed to the ops key. */
export interface StoredLogin {
  organizationId: string
  connectionId: string
  service: string
  /** The generation the envelope is sealed under. */
  generation: number
  envelope: SealedEnvelope
  /** The row's generation as this object last knew it: what the compare and set expects. */
  committedGeneration: number
  /** pending while the row has not taken this envelope; landed once it has. */
  writeBack: 'pending' | 'landed'
  /** Failed write backs in a row. */
  attempts: number
}

/** A send whose answer never came back: it may have landed. */
interface UnansweredSend {
  generation: number
  iv: string
}

interface HeldToken {
  token: string
  id: string
  expiresAtMs: number
  /** The iv of the login it came from or produced: it is served only while that login is the one in use. */
  loginIv: string
}

/** The keys this object opens and seals with. */
export interface SealKeys {
  privateKeys: KeyRing
  publicKeys: KeyRing
  /** The kid a rotated login is sealed under; null when none is current, and then nothing is refreshed. */
  kid: string | null
}

/**
 * The ops Worker's own keys: the private half of the current kid, and the
 * committed public keys bidding seals to. Only the current kid opens here: a
 * login sealed under a kid in rotation is resealed by resealConnections, a
 * later PR, which extends this.
 */
export function opsSealKeys(env: Pick<OpsEnv, 'OPS_CONNECTIONS_PRIVATE_KEY'>): SealKeys {
  const privateKeys: Record<string, string> = {}
  if (CURRENT_OPS_KID !== null && typeof env.OPS_CONNECTIONS_PRIVATE_KEY === 'string' && env.OPS_CONNECTIONS_PRIVATE_KEY.trim() !== '') {
    privateKeys[CURRENT_OPS_KID] = env.OPS_CONNECTIONS_PRIVATE_KEY
  }
  return { privateKeys, publicKeys: OPS_CONNECTION_PUBLIC_KEYS, kid: CURRENT_OPS_KID }
}

type Source =
  | { kind: 'copy'; generation: number; envelope: SealedEnvelope }
  | { kind: 'stored'; generation: number; envelope: SealedEnvelope; committedGeneration: number }

function failure(kind: LoginMintKind, reason: MintFailureReason, retryAtMs: number | null = null): TokenObjectFailure {
  return { ok: false, kind, reason, retryAtMs }
}

function failureOf(err: LoginMintError): TokenObjectFailure {
  return failure(err.kind, err.reason, err.retryAt === null ? null : err.retryAt.getTime())
}

function ivOf(envelope: unknown): string {
  return (envelope as { iv: string }).iv
}

/** The opened login of a person bound connection: the app's client id, its secret when it has one, and (after consent) the refresh token. */
function loginOf(plaintext: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new LoginMintError('refused', 'login_malformed')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new LoginMintError('refused', 'login_malformed')
  const login = parsed as Record<string, unknown>
  if (typeof login.client_id !== 'string' || login.client_id.trim() === '') throw new LoginMintError('refused', 'login_malformed')
  if (login.client_secret !== undefined && (typeof login.client_secret !== 'string' || login.client_secret === '')) throw new LoginMintError('refused', 'login_malformed')
  return login
}

function withClient(body: URLSearchParams, login: Record<string, unknown>): URLSearchParams {
  body.set('client_id', login.client_id as string)
  if (typeof login.client_secret === 'string') body.set('client_secret', login.client_secret)
  return body
}

function expiryOf(json: Readonly<Record<string, unknown>>, now: number): number {
  const seconds = json.expires_in
  const life = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, ACCESS_DEFAULT_LIFE_MS * 24) : ACCESS_DEFAULT_LIFE_MS
  return Math.floor(now + life)
}

/** The promise, or a rejection once ms have passed. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms) }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}

export class ConnectionTokenObject extends DurableObject<OpsEnv> {
  /** Epoch ms. A field a test replaces through runInDurableObject (L524), set in the future there. */
  clock: () => number = () => Date.now()
  /** The token endpoint request. A field a test replaces. */
  fetchToken: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init)
  tokenTimeoutMs: number = TOKEN_ENDPOINT_TIMEOUT_MS
  sealKeys: () => SealKeys = () => opsSealKeys(this.env)
  gateway: () => OpsGatewayBinding | undefined = () => this.env.OPS_GATEWAY
  gatewayDeadlineMs: number = WRITE_BACK_DEADLINE_MS

  private held: HeldToken | null = null
  private inFlight: { startedAt: number; promise: Promise<AccessTokenAnswer> } | null = null
  private waiting = 0

  /** When the refresh in flight started, or null when none is: for tests and, later, health. */
  inFlightSince(): number | null {
    return this.inFlight?.startedAt ?? null
  }

  /** How many callers are parked on the refresh in flight. */
  waitingOnFlight(): number {
    return this.waiting
  }

  fetch(_request: Request): Promise<Response> {
    return Promise.resolve(Response.json({ error: CONNECTION_TOKEN_OBJECT_RPC_ONLY }, { status: 404 }))
  }

  /** An access token for the connection, held, awaited from the holder, or refreshed. Never throws. */
  async accessToken(raw: unknown): Promise<AccessTokenAnswer> {
    let request
    try {
      request = parseAccessTokenRequest(raw)
    } catch {
      return failure('token_object_unavailable', 'token_object_refused')
    }
    try {
      const stored = await this.readLogin()
      if (stored && !this.sameConnection(stored, request)) return failure('token_object_unavailable', 'token_object_refused')
      const source = await this.chooseSource(stored, request)
      if (request.rejectedTokenId !== null && this.held?.id === request.rejectedTokenId) this.held = null
      const now = this.clock()
      const held = this.held
      if (held && held.loginIv === ivOf(source.envelope) && held.expiresAtMs - ACCESS_REUSE_MARGIN_MS > now) {
        return { ok: true, token: held.token, tokenId: held.id, expiresAtMs: held.expiresAtMs, minted: false }
      }
      // The waiter: a refresh is in flight, so this caller is answered what the holder is.
      if (this.inFlight && now - this.inFlight.startedAt < IN_FLIGHT_STALE_MS) {
        this.waiting += 1
        try {
          return await this.inFlight.promise
        } finally {
          this.waiting -= 1
        }
      }
      return await this.holdFlight(now, () => this.refresh(request, source))
    } catch {
      return failure('token_object_unavailable', 'token_object_failed')
    }
  }

  /**
   * A person's consent: the authorization code exchanged for the first refresh
   * token, stored as the connection's login before it answers, and handed back
   * by the alarm. Answers the generation the new login is sealed under, never a
   * token. Never throws.
   */
  async exchange(raw: unknown): Promise<ExchangeAnswer> {
    let request
    try {
      request = parseExchangeRequest(raw)
    } catch {
      return failure('token_object_unavailable', 'token_object_refused')
    }
    try {
      // After any refresh in flight, so the two never both write a login.
      while (this.inFlight && this.clock() - this.inFlight.startedAt < IN_FLIGHT_STALE_MS) {
        this.waiting += 1
        try {
          await this.inFlight.promise
        } finally {
          this.waiting -= 1
        }
      }
      let generation = 0
      const answer = await this.holdFlight(this.clock(), async () => {
        // Read only now, under this flight: a refresh that just finished may have stored a newer login.
        const stored = await this.readLogin()
        if (stored && !this.sameConnection(stored, request)) return failure('token_object_unavailable', 'token_object_refused')
        const result = await this.exchangeCode(request, stored)
        if (!result.ok) return result
        generation = result.generation
        return result.token
      })
      return answer.ok ? { ok: true, generation } : answer
    } catch {
      return failure('token_object_unavailable', 'token_object_failed')
    }
  }

  /** The write back: one compare and set, then retry later, give up, or rest. */
  async alarm(): Promise<void> {
    const login = await this.readLogin()
    if (!login || login.writeBack === 'landed') return
    const now = this.clock()
    const unanswered = (await this.ctx.storage.get<UnansweredSend[]>('unanswered')) ?? []
    const gateway = this.gateway()
    if (!gateway) {
      await this.retryLater(login, now)
      return
    }
    // Recorded before it is sent: if the answer never comes back, it may still have landed.
    const send: UnansweredSend = { generation: login.generation, iv: login.envelope.iv }
    await this.ctx.storage.put('unanswered', [...unanswered, send].slice(-MAX_UNANSWERED_SENDS))
    let answer: StoreRotatedEnvelopeAnswer
    try {
      answer = parseStoreRotatedEnvelopeAnswer(await within(gateway.storeRotatedEnvelope({
        organization_id: login.organizationId,
        connection_id: login.connectionId,
        expected_generation: login.committedGeneration,
        generation: login.generation,
        envelope: login.envelope,
      }), this.gatewayDeadlineMs))
    } catch {
      await this.retryLater(login, now)
      return
    }
    // An answer came back, so the row's state is known: no earlier send is in doubt any more.
    await this.ctx.storage.delete('unanswered')
    const current = await this.readLogin()
    switch (answer.outcome) {
      case 'stored':
      case 'already_stored': {
        if (!current) return
        if (current.envelope.iv === login.envelope.iv) {
          await this.writeLogin({ ...current, committedGeneration: login.generation, writeBack: 'landed', attempts: 0 })
          return
        }
        // A newer rotation arrived while this one was in flight: the row is at this one's generation now.
        await this.writeLogin({ ...current, committedGeneration: Math.max(current.committedGeneration, login.generation), attempts: 0 })
        await this.ctx.storage.setAlarm(now)
        return
      }
      case 'moved': {
        const landed = unanswered.find((s) => s.generation === answer.current_generation && s.iv === answer.current_iv)
        if (landed && current && current.generation > landed.generation) {
          // An earlier send whose answer was lost did land: send on top of it.
          await this.writeLogin({ ...current, committedGeneration: landed.generation, attempts: 0 })
          await this.ctx.storage.setAlarm(now)
          return
        }
        // The row moved past this object (a Reconnect): the row is the authority, and this login is dead.
        await this.giveUp()
        return
      }
      case 'not_found':
        // The connection was removed.
        await this.giveUp()
        return
    }
  }

  private sameConnection(stored: StoredLogin, request: TokenObjectLogin): boolean {
    return stored.organizationId === request.organizationId && stored.connectionId === request.connectionId && stored.service === request.service
  }

  private async readLogin(): Promise<StoredLogin | null> {
    return (await this.ctx.storage.get<StoredLogin>('login')) ?? null
  }

  private async writeLogin(login: StoredLogin): Promise<void> {
    await this.ctx.storage.put('login', login)
  }

  private async giveUp(): Promise<void> {
    await this.ctx.storage.delete(['login', 'unanswered'])
    await this.ctx.storage.deleteAlarm()
    this.held = null
  }

  private async retryLater(login: StoredLogin, now: number): Promise<void> {
    const attempts = login.attempts + 1
    const current = await this.readLogin()
    if (current) await this.writeLogin({ ...current, attempts })
    const wait = Math.min(WRITE_BACK_RETRY_MIN_MS * 2 ** (attempts - 1), WRITE_BACK_RETRY_MAX_MS)
    await this.ctx.storage.setAlarm(now + wait)
  }

  /** The login to refresh from: this object's own while it is newer than the caller's copy or the same one; the copy otherwise, giving its own up. */
  private async chooseSource(stored: StoredLogin | null, request: TokenObjectLogin): Promise<Source> {
    const copy: Source = { kind: 'copy', generation: request.generation, envelope: request.envelope as SealedEnvelope }
    if (!stored) return copy
    if (stored.generation > request.generation || (stored.generation === request.generation && stored.envelope.iv === ivOf(request.envelope))) {
      return { kind: 'stored', generation: stored.generation, envelope: stored.envelope, committedGeneration: stored.committedGeneration }
    }
    // The copy is ahead, or took another envelope at this generation: the row moved past this object.
    await this.giveUp()
    return copy
  }

  /** Runs one refresh or exchange as the flight others wait on, clearing the marker however it ends. */
  private async holdFlight(now: number, run: () => Promise<AccessTokenAnswer>): Promise<AccessTokenAnswer> {
    const promise = run().catch(() => failure('token_object_unavailable', 'token_object_failed'))
    const marker = { startedAt: now, promise }
    this.inFlight = marker
    try {
      return await promise
    } finally {
      if (this.inFlight === marker) this.inFlight = null
    }
  }

  private async openLogin(keys: SealKeys, request: TokenObjectLogin, generation: number, envelope: SealedEnvelope): Promise<Record<string, unknown>> {
    let plaintext: string
    try {
      plaintext = await open(keys.privateKeys, envelope, {
        organization_id: request.organizationId,
        connection_id: request.connectionId,
        service: request.service,
        generation,
        kid: envelope.kid,
      })
    } catch {
      // connectionFetch opened the same envelope under the same binding, so this is our keys, not the login.
      throw new Error('the envelope did not open here')
    }
    return loginOf(plaintext)
  }

  private async sealLogin(keys: SealKeys, request: TokenObjectLogin, generation: number, login: Record<string, unknown>): Promise<SealedEnvelope> {
    return seal(keys.publicKeys, JSON.stringify(login), {
      organization_id: request.organizationId,
      connection_id: request.connectionId,
      service: request.service,
      generation,
      kid: keys.kid as string,
    })
  }

  private tokenDeps() {
    return { fetch: this.fetchToken, now: () => this.clock(), tokenTimeoutMs: this.tokenTimeoutMs }
  }

  /** Stores a new login before anything is returned, and makes sure an alarm will hand it back. */
  private async keep(login: StoredLogin, now: number): Promise<void> {
    await this.writeLogin(login)
    const alarm = await this.ctx.storage.getAlarm()
    // An alarm already set is a write back retrying on its own schedule: it sends this newer login then.
    if (alarm === null) await this.ctx.storage.setAlarm(now)
  }

  private async refresh(request: TokenObjectLogin, source: Source): Promise<AccessTokenAnswer> {
    const keys = this.sealKeys()
    // A rotated token that could not be sealed would be lost, so with no kid to seal to nothing is asked.
    if (keys.kid === null) return failure('token_object_unavailable', 'token_object_failed')
    let login: Record<string, unknown>
    try {
      login = await this.openLogin(keys, request, source.generation, source.envelope)
    } catch (err) {
      if (err instanceof LoginMintError) return failureOf(err as LoginMintError)
      return failure('token_object_unavailable', 'token_object_failed')
    }
    const refreshToken = login.refresh_token
    if (typeof refreshToken !== 'string' || refreshToken === '') return failure('refused', 'login_malformed')

    let json: Readonly<Record<string, unknown>>
    let token: string
    const asked = this.clock()
    try {
      json = await requestToken(this.tokenDeps(), request.tokenUrl, withClient(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }), login))
      token = readAccessToken(json)
    } catch (err) {
      if (err instanceof LoginMintError) return failureOf(err as LoginMintError)
      return failure('unavailable', 'token_endpoint_unreachable')
    }

    let loginIv = source.envelope.iv
    const rotated = json.refresh_token
    if (typeof rotated === 'string' && rotated !== '' && rotated !== refreshToken) {
      // Above both what this object held and the copy, so nobody else can have written this generation.
      const generation = source.generation + 1
      const envelope = await this.sealLogin(keys, request, generation, { ...login, refresh_token: rotated })
      await this.keep({
        organizationId: request.organizationId,
        connectionId: request.connectionId,
        service: request.service,
        generation,
        envelope,
        committedGeneration: source.kind === 'stored' ? source.committedGeneration : source.generation,
        writeBack: 'pending',
        attempts: source.kind === 'stored' ? (await this.readLogin())?.attempts ?? 0 : 0,
      }, asked)
      loginIv = envelope.iv
    }
    const held: HeldToken = { token, id: crypto.randomUUID(), expiresAtMs: expiryOf(json, asked), loginIv }
    this.held = held
    return { ok: true, token, tokenId: held.id, expiresAtMs: held.expiresAtMs, minted: true }
  }

  private async exchangeCode(
    request: ReturnType<typeof parseExchangeRequest>, stored: StoredLogin | null,
  ): Promise<{ ok: true; generation: number; token: AccessTokenAnswer } | TokenObjectFailure> {
    const keys = this.sealKeys()
    if (keys.kid === null) return failure('token_object_unavailable', 'token_object_failed')
    let app: Record<string, unknown>
    try {
      app = await this.openLogin(keys, request, request.generation, request.envelope as SealedEnvelope)
    } catch (err) {
      if (err instanceof LoginMintError) return failureOf(err as LoginMintError)
      return failure('token_object_unavailable', 'token_object_failed')
    }
    const body = withClient(new URLSearchParams({
      grant_type: 'authorization_code',
      code: request.code,
      code_verifier: request.verifier,
      redirect_uri: request.redirectUri,
    }), app)
    let json: Readonly<Record<string, unknown>>
    let token: string
    const asked = this.clock()
    try {
      json = await requestToken(this.tokenDeps(), request.tokenUrl, body)
      token = readAccessToken(json)
    } catch (err) {
      if (err instanceof LoginMintError) return failureOf(err as LoginMintError)
      return failure('unavailable', 'token_endpoint_unreachable')
    }
    const refreshToken = json.refresh_token
    if (typeof refreshToken !== 'string' || refreshToken === '') return failure('refused', 'refresh_token_missing')

    // A consent replaces whatever this object held; its generation is above both.
    const generation = Math.max(request.generation, stored?.generation ?? 0) + 1
    const { refresh_token: _old, ...appOnly } = app
    const envelope = await this.sealLogin(keys, request, generation, { ...appOnly, refresh_token: refreshToken })
    await this.keep({
      organizationId: request.organizationId,
      connectionId: request.connectionId,
      service: request.service,
      generation,
      envelope,
      committedGeneration: request.generation,
      writeBack: 'pending',
      attempts: 0,
    }, asked)
    const held: HeldToken = { token, id: crypto.randomUUID(), expiresAtMs: expiryOf(json, asked), loginIv: envelope.iv }
    this.held = held
    return { ok: true, generation, token: { ok: true, token, tokenId: held.id, expiresAtMs: held.expiresAtMs, minted: true } }
  }
}
