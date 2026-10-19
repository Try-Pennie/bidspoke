/**
 * connectionFetch: the one path for every connection bound request on the ops
 * Worker (#2335, phase 5 of #1689, plan: discussion #2329, part 2).
 *
 * WHO CALLS IT. The OpsConnections entrypoint (verify, Reconnect, lookups;
 * ./ops-connections.ts, #2335 PR 8), which only the bidding Worker's
 * OPS_CONNECTIONS binding reaches (PR 9); later the still valid check and the
 * sf_limits read (Phase 10 and 6) and the ops executor's steps (Phase 9). Each
 * passes an OrganizationId that the bidding Worker derived from the caller's
 * JWT. No other ops module reaches the platform's fetch (the guard
 * ops-connection-requests-through-fetch.test.ts).
 *
 * WHOSE DATA. One connection of that organization: its copy in the ops
 * database, read through connection_copy, which refuses another organization's
 * row; its sealed login, which opens only under that organization, connection,
 * service and generation (the AAD), so a wrong organization fails in the cipher
 * and not just in a filter; and, for Salesforce, one lease of the ops pool of
 * the Salesforce org that connection measured as.
 *
 * ORDER, and why:
 *  1. The call: a valid organization, a step names its workflow and nothing
 *     else does, a candidate is verify's alone (Reconnect's call is a verify).
 *  2. The copy: a tombstone, a withdrawal and serve_until, as the database
 *     judged them on its own clock. A candidate (below) is checked against the
 *     copy's tombstone, service and generation instead.
 *  3. The service's rules, then the envelope opened, then the URL: https, and
 *     its host among the connection's declared hosts.
 *  4. For Salesforce, a lease from the ops pool (L621: here, so no caller can
 *     omit it), released in a finally. A step refused one is answered a
 *     RequeueAt with the pool's time; an interactive call waits a stated time
 *     and is then refused by name; a scheduled read is refused at once.
 *  5. Per attempt: RECORD the sanitised request (or a declared reason nothing
 *     is recorded), and only then apply the auth, and send. Redirects are never
 *     followed: a redirect would leave the declared hosts.
 *  6. A 429, or a 503 with Retry-After, is a RequeueAt. The service's declared
 *     expiry signal renews the token once and retries once; a second is
 *     needs_reauth. A body that can be read only once is never sent twice.
 *  7. For Salesforce, the latest response's Sforce-Limit-Info is the org's
 *     budget reading (#2336, ./sf-budget-reading.ts), handed to recordSfBudget
 *     beside the lease release, for a committed copy whose lease came from its
 *     measured org's pool. Bounded by SF_BUDGET_READING_DEADLINE_MS and caught:
 *     a reading never changes the answer, and its failure is reported by name.
 *
 * THE LOGIN (./minters, Dan's decision 2). The service's authorize mints or
 * reuses the token. A minter that asks a token endpoint asks it with the fetch
 * handed to it here (AuthorizeInput.fetch, #2337), held to the same https and
 * declared host rule as the request and never following a redirect, so the
 * token request too reaches the platform only through this module. A login the provider refused is needs_reauth at once. A
 * token endpoint that timed out or answered 5xx adds to the connection's
 * refresh streak (record_connection_refresh) and is answered
 * connection_auth_unavailable; the database turns the streak into needs_reauth
 * only past its bound. A login a token endpoint answered ends the streak. A
 * mint our own rule refused (the Google delegation allowlist, F129) is
 * connection_not_allowed and records nothing about the login.
 *
 * CANDIDATES (findings F116 and F126). verify and Reconnect pass the envelope
 * of a generation bidding has not committed yet. It is used for this one call
 * and held only in memory: this module has no write to connection_copies at
 * all, and a candidate's failure writes nothing about the connection's health.
 * Only a bidding serve of the committed row moves the copy forward, so a failed
 * verify or a lost compare and set on bidding leaves ops on the committed
 * generation (proven end to end in __tests__/reconnect-candidate.test.ts).
 *
 * WHAT LEAVES (finding F120). Nothing here writes to the console (the guard
 * apps/web/src/lib/__guards__/worker/connection-seal-open-callers.test.ts
 * refuses it). Every error leaving is a ConnectionRefusal built from names
 * alone and scrubbed of every known secret; the error that caused it is
 * dropped, never attached, because Workers Logs and the tail trace record an
 * uncaught exception's message with no console call.
 */
import { open, SealError, type KeyRing } from '@bidspoke/connection-seal'
import { organizationIdFrom, type OrganizationId } from '../ops-db'
import type { AcquireSfLease, ConnectionCopy, SfLeaseAnswer } from '../ops-writes'
import {
  NON_STEP_LEASE_OUTCOMES, SF_LEASE_PURPOSES, type NonStepLeaseOutcome, type RefreshOutcome, type SfLeaseOutcome, type SfLeasePurpose,
} from '../run-vocabulary'
import { ConnectionRefusal, LoginMintError, RequeueAt, type ConnectionRefusalCode, type MintFailureReason } from './refusals'
import { isCredentialHeader, sanitiseRequest, scrubSecrets, secretsOfLogin, type RecordedRequest } from './sanitise'
import { parseSforceLimitInfo, SF_BUDGET_READING_DEADLINE_MS } from './sf-budget-reading'
import type { Authorization, AuthorizeInput, OpenedLogin, ServiceRules } from './service-rules'

/** The whole call, the mint and both attempts included. */
export const CONNECTION_FETCH_DEADLINE_MS = 60_000
/** A lease outlives the call's deadline, so it never lapses while its request is in flight. */
export const SF_LEASE_TTL_SECONDS = 90
/** How long lookup and verify (Reconnect's call is a verify) wait on a full pool before they are refused (plan: a short stated time). */
export const SF_INTERACTIVE_WAIT_MS = 2_000
export const SF_INTERACTIVE_POLL_MS = 250
/** When a step refused a lease with no time of its own is next tried. */
export const STEP_LEASE_REQUEUE_MS = 60_000
/** A 429 with no Retry-After. */
export const RATE_LIMIT_DEFAULT_MS = 60_000
/** A Retry-After is held between these, so a wrong or hostile one cannot park a run for days. */
export const RETRY_AFTER_MIN_MS = 1_000
export const RETRY_AFTER_MAX_MS = 60 * 60_000

/**
 * The causes recorded with needs_reauth (connection_health.needs_reauth_cause).
 * A refused login is recorded as `login_refused: <reason>`. A failing token
 * endpoint held past decision 2's bound is written by record_connection_refresh
 * itself, as `refresh_failing_exhausted: <reason>`.
 */
export const NEEDS_REAUTH_CAUSES = {
  loginRefused: 'login_refused',
  refusedAfterRenew: 'request_refused_after_renew',
  refreshFailingExhausted: 'refresh_failing_exhausted',
} as const

/** A credential bidding has not committed, passed in the verify or Reconnect call: ciphertext and public config only. */
export interface CandidateConnection {
  readonly service: string
  readonly generation: number
  readonly envelope: unknown
  readonly target: unknown
  readonly publicConfig: unknown
}

export type ConnectionSource = { readonly kind: 'copy' } | { readonly kind: 'candidate'; readonly candidate: CandidateConnection }

/** Where the sanitised request goes before anything is sent, or the declared reason nothing is recorded. */
export type RecordTarget = ((request: RecordedRequest) => Promise<void>) | { readonly recordsNothing: string }

export interface ConnectionCall {
  readonly organizationId: OrganizationId
  readonly connectionId: string
  readonly source: ConnectionSource
  readonly purpose: SfLeasePurpose
  /** A step's workflow, and only a step's. */
  readonly workflowId?: string
  readonly record: RecordTarget
  readonly signal?: AbortSignal
  /**
   * Told which service and generation this call used, once the copy or
   * candidate has passed, before anything is opened or sent: verify records what
   * it measured under the generation the request really carried, which a serve
   * may have moved on since verify last read the copy (#2335, PR 8).
   */
  readonly onResolved?: (resolved: { readonly service: string; readonly generation: number }) => void
}

/** Something worth knowing that does not change the answer. Names only. */
export interface ConnectionEvent {
  readonly event: 'sf_lease_release_failed' | 'needs_reauth_unrecorded' | 'refresh_unrecorded' | 'sf_budget_reading_unrecorded' | 'sf_limit_info_unreadable'
  readonly connection_id: string
  readonly purpose: SfLeasePurpose
  /**
   * A name from a closed set, never a value: the parser's refusal for
   * sf_limit_info_unreadable, and write_failed or deadline for
   * sf_budget_reading_unrecorded.
   */
  readonly cause?: string
}

export interface ConnectionFetchDeps {
  /** The ops private keys by kid. */
  privateKeys: KeyRing
  /** connection_copy (ops-writes.ts readConnectionCopy), bound to the ops client. */
  readCopy(organizationId: OrganizationId, connectionId: string): Promise<ConnectionCopy>
  rulesFor(service: string): ServiceRules | undefined
  acquireSfLease(organizationId: OrganizationId, ask: AcquireSfLease): Promise<SfLeaseAnswer>
  releaseSfLease(organizationId: OrganizationId, holder: string): Promise<'released' | 'not_held'>
  /** record_connection_needs_reauth. Never called for a candidate. */
  recordNeedsReauth(organizationId: OrganizationId, connectionId: string, cause: string): Promise<unknown>
  /**
   * record_connection_refresh (Dan's decision 2): a failing token endpoint adds
   * to the streak and answers needs_reauth once past its bound; a login a token
   * endpoint answered ends it. Never called for a candidate.
   */
  recordRefresh(organizationId: OrganizationId, connectionId: string, result: { ok: true } | { ok: false; cause: string }): Promise<RefreshOutcome>
  fetch(input: string, init?: RequestInit): Promise<Response>
  /**
   * A Salesforce org's budget reading from a response's Sforce-Limit-Info
   * (#2336): ./sf-budget-reading.ts recordSfBudgetReadingFor, which keys it on
   * the connection generation's measured org and writes it at most once per org
   * a minute. Called only for a committed copy whose lease came from the org
   * pool; its failure is reported and never changes the answer.
   */
  recordSfBudget(organizationId: OrganizationId, connectionId: string, generation: number, reading: { used: number; max: number }, now: number): Promise<unknown>
  now(): number
  /** The interactive lease wait, and the bound on a budget reading's write (L524: injected). */
  sleep(ms: number): Promise<void>
  /** A lease holder unique to this call. */
  newHolder(): string
  report(event: ConnectionEvent): void
  /** Defaults to CONNECTION_FETCH_DEADLINE_MS. */
  deadlineMs?: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Reconnect's call is a verify (clearReauth), so it has no purpose of its own (#2336).
const CANDIDATE_PURPOSES: ReadonlySet<SfLeasePurpose> = new Set(['verify'])
const INTERACTIVE_PURPOSES: ReadonlySet<SfLeasePurpose> = new Set(['lookup', 'verify'])
const BUSY_OUTCOMES: ReadonlySet<SfLeaseOutcome> = new Set(['pool_full', 'workflow_share_full', 'purpose_share_full'])

const COPY_STATE_REFUSALS: Readonly<Record<Exclude<ConnectionCopy['state'], 'usable'>, ConnectionRefusalCode>> = {
  connection_removed: 'connection_removed',
  connection_withdrawn: 'connection_withdrawn',
  connection_copy_expired: 'connection_copy_expired',
  not_found: 'connection_not_found',
}

/** A refusal whose detail is scrubbed of every known secret on the way out, whatever it was built from. */
function refusal(
  code: ConnectionRefusalCode, detail: string, secrets: readonly string[], retryAt: Date | null = null, mintReason: MintFailureReason | null = null,
): ConnectionRefusal {
  return new ConnectionRefusal(code, scrubSecrets(detail, secrets), retryAt, mintReason)
}

interface Resolved {
  service: string
  generation: number
  envelope: unknown
  target: unknown
  publicConfig: unknown
  candidate: boolean
}

function checkCall(call: ConnectionCall): void {
  try {
    organizationIdFrom(call.organizationId)
  } catch {
    throw refusal('connection_call_invalid', 'the organization is not a uuid', [])
  }
  if (typeof call.connectionId !== 'string' || !UUID.test(call.connectionId)) throw refusal('connection_call_invalid', 'the connection id is not a uuid', [])
  if (!(SF_LEASE_PURPOSES as readonly string[]).includes(call.purpose)) throw refusal('connection_call_invalid', 'the purpose is not one connectionFetch knows', [])
  if ((call.purpose === 'step') !== (call.workflowId !== undefined)) {
    throw refusal('connection_call_invalid', 'a step names its workflow, and no other purpose does', [])
  }
  if (call.source.kind === 'candidate' && !CANDIDATE_PURPOSES.has(call.purpose)) {
    throw refusal('connection_candidate_not_allowed', `a ${call.purpose} call may use only the committed copy`, [])
  }
}

async function readCopyOrRefuse(readCopy: ConnectionFetchDeps['readCopy'], organizationId: OrganizationId, connectionId: string): Promise<ConnectionCopy> {
  try {
    return await readCopy(organizationId, connectionId)
  } catch {
    throw refusal('connection_copy_unreadable', 'the ops database did not answer the copy read', [])
  }
}

/** A candidate checked against what ops holds, replacing nothing (F116, F126). Throws a refusal by name. */
function refuseCandidateAgainst(copy: ConnectionCopy, candidate: CandidateConnection): void {
  if (copy.state === 'connection_removed') throw refusal('connection_removed', 'the connection is removed', [])
  if (copy.state !== 'not_found') {
    if (copy.service !== null && copy.service !== candidate.service) {
      throw refusal('connection_service_mismatch', `the candidate is a ${candidate.service} login and the copy is ${copy.service}`, [])
    }
    if (copy.generation !== null && candidate.generation < copy.generation) {
      throw refusal('connection_generation_older', `the candidate is generation ${candidate.generation} and ops holds ${copy.generation}`, [])
    }
  }
}

/**
 * The candidate rules connectionFetch holds a verify or Reconnect to, for a
 * caller that takes a candidate without sending a request through it: the
 * person bound code exchange (minters/oauth-user.ts, #2335).
 */
export async function checkCandidate(
  readCopy: ConnectionFetchDeps['readCopy'], organizationId: OrganizationId, connectionId: string, candidate: CandidateConnection,
): Promise<void> {
  refuseCandidateAgainst(await readCopyOrRefuse(readCopy, organizationId, connectionId), candidate)
}

async function resolve(deps: ConnectionFetchDeps, call: ConnectionCall): Promise<Resolved> {
  const copy = await readCopyOrRefuse((organizationId, connectionId) => deps.readCopy(organizationId, connectionId), call.organizationId, call.connectionId)

  if (call.source.kind === 'copy') {
    if (copy.state !== 'usable') throw refusal(COPY_STATE_REFUSALS[copy.state], `the copy is ${copy.state}`, [])
    if (copy.service === null || copy.generation === null) throw refusal('connection_copy_unreadable', 'a usable copy came back without its service or generation', [])
    return { service: copy.service, generation: copy.generation, envelope: copy.envelope, target: copy.target, publicConfig: copy.publicConfig, candidate: false }
  }

  const candidate = call.source.candidate
  refuseCandidateAgainst(copy, candidate)
  return { ...candidate, candidate: true }
}

async function openLogin(deps: ConnectionFetchDeps, call: ConnectionCall, resolved: Resolved): Promise<OpenedLogin> {
  const envelope = resolved.envelope
  const kid = typeof envelope === 'object' && envelope !== null && typeof (envelope as { kid?: unknown }).kid === 'string' ? (envelope as { kid: string }).kid : ''
  try {
    const plaintext = await open(deps.privateKeys, envelope, {
      organization_id: call.organizationId,
      connection_id: call.connectionId,
      service: resolved.service,
      generation: resolved.generation,
      kid,
    })
    return { plaintext }
  } catch (err) {
    // The seal's code names the cause and carries no key material; its message is not forwarded.
    throw refusal('connection_seal_refused', `the envelope did not open (${err instanceof SealError ? err.code : 'seal_error'})`, [])
  }
}

function checkUrl(url: string, rules: ServiceRules, resolved: Resolved, secrets: readonly string[]): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw refusal('connection_url_invalid', 'the request URL does not parse', secrets)
  }
  if (parsed.protocol !== 'https:') throw refusal('connection_url_invalid', `${parsed.protocol} is not https`, secrets)
  let hosts: readonly string[]
  try {
    hosts = rules.declaredHosts(resolved.target, resolved.publicConfig).map((h) => h.toLowerCase())
  } catch {
    throw refusal('connection_target_invalid', `the ${resolved.service} connection's target does not declare its hosts`, secrets)
  }
  if (!hosts.includes(parsed.hostname)) {
    throw refusal('connection_host_not_declared', `${parsed.hostname} is not among the connection's declared hosts`, secrets)
  }
  if (parsed.username !== '' || parsed.password !== '') throw refusal('connection_url_invalid', 'the request URL carries credentials', secrets)
  if (parsed.port !== '' && parsed.port !== '443') throw refusal('connection_url_invalid', `port ${parsed.port} is not the declared host's`, secrets)
  return parsed
}

/**
 * The fetch a minter asks its token endpoint with (AuthorizeInput.fetch, #2337):
 * held to the same URL rule as the request itself (checkUrl), and never
 * following a redirect, so the client secret or a signed assertion can only go
 * to a host the connection declares. A URL outside that rule is refused by name
 * before anything is sent; the refusal's own detail is dropped, as every other
 * minter failure's is. The token request is the login's, not the call's, so it
 * is not recorded in the call's send record: it carries the login itself.
 */
function tokenFetchFor(deps: ConnectionFetchDeps, rules: ServiceRules, resolved: Resolved, secrets: readonly string[]): AuthorizeInput['fetch'] {
  return async (url, init = {}) => {
    try {
      checkUrl(url, rules, resolved, secrets)
    } catch {
      throw new LoginMintError('not_allowed', 'token_host_not_declared')
    }
    return deps.fetch(url, { ...init, redirect: 'manual' })
  }
}

function isNonStepOutcome(outcome: SfLeaseOutcome): outcome is NonStepLeaseOutcome {
  return (NON_STEP_LEASE_OUTCOMES as readonly string[]).includes(outcome)
}

/** A refusal of the pool keeps its own name; the three kinds of full are one: the pool is busy. */
function leaseRefusalCode(outcome: Exclude<SfLeaseOutcome, 'granted'>): ConnectionRefusalCode {
  switch (outcome) {
    case 'pool_full':
    case 'workflow_share_full':
    case 'purpose_share_full':
      return 'sf_pool_busy'
    default:
      return outcome
  }
}

/** The pool the lease came from, or a RequeueAt for a step. Throws a named refusal for everything else. */
async function takeLease(deps: ConnectionFetchDeps, call: ConnectionCall, rules: ServiceRules, resolved: Resolved, holder: string): Promise<RequeueAt | 'org' | 'bootstrap'> {
  let bootstrapHost: string | undefined
  if (call.purpose === 'verify') {
    try {
      bootstrapHost = rules.salesforce!.instanceHost(resolved.target).toLowerCase()
    } catch {
      throw refusal('connection_target_invalid', 'the Salesforce connection\'s target does not declare its instance_url', [])
    }
  }
  const ask: AcquireSfLease = {
    connectionId: call.connectionId,
    generation: resolved.generation,
    purpose: call.purpose,
    workflowId: call.workflowId,
    holder,
    ttlSeconds: SF_LEASE_TTL_SECONDS,
    bootstrapHost,
  }
  const started = deps.now()
  for (;;) {
    let answer: SfLeaseAnswer
    try {
      answer = await deps.acquireSfLease(call.organizationId, ask)
    } catch {
      if (call.purpose === 'step') return new RequeueAt(new Date(deps.now() + STEP_LEASE_REQUEUE_MS), 'acquire_error')
      throw refusal('sf_lease_unavailable', 'the ops Salesforce pool did not answer', [])
    }
    if (answer.outcome === 'granted') return answer.pool
    const retryAt = answer.retryAt === null ? null : new Date(answer.retryAt)
    if (call.purpose === 'step') {
      const outcome = answer.outcome
      // The pool answers these only to a non step purpose; one reaching a step is not waited on (fail closed).
      if (isNonStepOutcome(outcome)) throw refusal(leaseRefusalCode(outcome), `the ops Salesforce pool answered a step ${outcome}`, [])
      return new RequeueAt(retryAt ?? new Date(deps.now() + STEP_LEASE_REQUEUE_MS), outcome)
    }
    const busy = BUSY_OUTCOMES.has(answer.outcome)
    if (busy && INTERACTIVE_PURPOSES.has(call.purpose) && deps.now() - started < SF_INTERACTIVE_WAIT_MS) {
      await deps.sleep(SF_INTERACTIVE_POLL_MS)
      continue
    }
    throw refusal(leaseRefusalCode(answer.outcome), `the ops Salesforce pool answered ${answer.outcome}`, [], retryAt)
  }
}

interface Deadline {
  readonly signal: AbortSignal
  /** Why it fired: our deadline, or the caller's signal. Null while it has not. */
  reason(): 'timeout' | 'aborted' | null
  clear(): void
}

function startDeadline(ms: number, callerSignal: AbortSignal | undefined): Deadline {
  const controller = new AbortController()
  let why: 'timeout' | 'aborted' | null = null
  const fire = (reason: 'timeout' | 'aborted') => {
    if (why !== null) return
    why = reason
    controller.abort()
  }
  const timer = setTimeout(() => fire('timeout'), ms)
  const onAbort = () => fire('aborted')
  if (callerSignal?.aborted) fire('aborted')
  else callerSignal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    reason: () => why,
    clear: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onAbort)
    },
  }
}

/** The promise, or a rejection the moment the deadline fires. */
function beforeDeadline<T>(promise: Promise<T>, deadline: Deadline): Promise<T> {
  if (deadline.signal.aborted) {
    // Its own outcome no longer matters, and must not surface as an unhandled rejection.
    promise.catch(() => undefined)
    return Promise.reject(new Error('deadline'))
  }
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(new Error('deadline'))
    deadline.signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { deadline.signal.removeEventListener('abort', onAbort); resolvePromise(value) },
      (err: unknown) => { deadline.signal.removeEventListener('abort', onAbort); reject(err instanceof Error ? err : new Error('rejected with a non Error')) },
    )
  })
}

function deadlineRefusal(deadline: Deadline, what: string, secrets: readonly string[]): ConnectionRefusal | null {
  const why = deadline.reason()
  if (why === 'timeout') return refusal('connection_timeout', `${what} passed connectionFetch's deadline`, secrets)
  if (why === 'aborted') return refusal('connection_aborted', `the caller gave up during ${what}`, secrets)
  return null
}

function clampedRetry(now: number, at: number): Date {
  return new Date(Math.min(Math.max(at, now + RETRY_AFTER_MIN_MS), now + RETRY_AFTER_MAX_MS))
}

/**
 * A Retry-After header as epoch ms: delta seconds or an HTTP date. Null when it
 * is neither. Shared with the minters' token endpoint (minters/token-endpoint.ts),
 * whose time connectionFetch clamps the same way.
 */
export function retryAfterAt(header: string, now: number): number | null {
  const trimmed = header.trim()
  const at = /^\d+$/.test(trimmed) ? now + Number(trimmed) * 1000 : Date.parse(trimmed)
  return Number.isFinite(at) ? at : null
}

/** A 429, or a 503 that says when to come back, as a RequeueAt; anything else null. */
function rateLimited(response: Response, now: number): RequeueAt | null {
  const header = response.headers.get('retry-after')
  if (response.status !== 429 && !(response.status === 503 && header !== null)) return null
  const at = header === null ? null : retryAfterAt(header, now)
  return new RequeueAt(at === null ? new Date(now + RATE_LIMIT_DEFAULT_MS) : clampedRetry(now, at), 'rate_limited')
}

/** A response nobody will read: its body is cancelled, so it does not hold the connection open. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined)
}

function isSingleUse(body: unknown): boolean {
  return typeof ReadableStream !== 'undefined' && body instanceof ReadableStream
}

/**
 * One connection bound request. Answers the response, or a RequeueAt, and
 * throws a ConnectionRefusal by name for everything else (see the header).
 */
export async function connectionFetch(deps: ConnectionFetchDeps, call: ConnectionCall, url: string, init: RequestInit = {}): Promise<Response | RequeueAt> {
  checkCall(call)
  const resolved = await resolve(deps, call)
  call.onResolved?.({ service: resolved.service, generation: resolved.generation })
  const rules = deps.rulesFor(resolved.service)
  if (rules === undefined) throw refusal('connection_service_unknown', `no rules for the ${resolved.service} service on this Worker`, [])
  const login = await openLogin(deps, call, resolved)
  const loginSecrets = secretsOfLogin(login.plaintext)
  checkUrl(url, rules, resolved, loginSecrets)

  const holder = rules.salesforce ? deps.newHolder() : null
  let pool: 'org' | 'bootstrap' | null = null
  if (holder !== null) {
    const lease = await takeLease(deps, call, rules, resolved, holder)
    if (lease instanceof RequeueAt) return lease
    pool = lease
  }
  // Only a committed copy drawing on its measured org's pool has an org to read for (a bootstrap verify has none yet, and a candidate is not the committed generation).
  const budget: BudgetObserver | null = pool === 'org' && !resolved.candidate ? { reading: null, at: 0 } : null
  const deadline = startDeadline(deps.deadlineMs ?? CONNECTION_FETCH_DEADLINE_MS, call.signal)
  try {
    return await sendWithRenewal(deps, call, rules, resolved, login, loginSecrets, deadline, url, init, budget)
  } finally {
    deadline.clear()
    if (holder !== null) {
      // The reading's write rides beside the release, so it adds no wait unless it is the slower of the two, and then at most its bound.
      await Promise.all([releaseLease(deps, call, holder), recordBudget(deps, call, resolved, budget)])
    }
  }
}

/** The latest budget reading a call's responses carried, and when it arrived (the injected clock). */
interface BudgetObserver {
  reading: { used: number; max: number } | null
  at: number
}

/** Reads a response's Sforce-Limit-Info into the observer; an unreadable one is reported by the parser's name. */
function observeBudget(deps: ConnectionFetchDeps, call: ConnectionCall, budget: BudgetObserver | null, response: Response): void {
  if (budget === null) return
  const parsed = parseSforceLimitInfo(response.headers.get('sforce-limit-info'))
  if (parsed.ok) {
    budget.reading = { used: parsed.used, max: parsed.max }
    budget.at = deps.now()
  } else if (parsed.refusal !== 'absent') {
    safeReport(deps, { event: 'sf_limit_info_unreadable', connection_id: call.connectionId, purpose: call.purpose, cause: parsed.refusal })
  }
}

async function releaseLease(deps: ConnectionFetchDeps, call: ConnectionCall, holder: string): Promise<void> {
  try {
    await deps.releaseSfLease(call.organizationId, holder)
  } catch {
    // The lease lapses at its TTL and stops counting then (L409); say so, and keep the answer.
    safeReport(deps, { event: 'sf_lease_release_failed', connection_id: call.connectionId, purpose: call.purpose })
  }
}

/** Writes the call's budget reading, bounded and caught: never throws, never waits past SF_BUDGET_READING_DEADLINE_MS. */
async function recordBudget(deps: ConnectionFetchDeps, call: ConnectionCall, resolved: Resolved, budget: BudgetObserver | null): Promise<void> {
  if (budget === null || budget.reading === null) return
  const { reading, at } = budget
  // A recorder that throws before returning a promise is caught here too.
  const write = Promise.resolve().then(() => deps.recordSfBudget(call.organizationId, call.connectionId, resolved.generation, reading, at))
  let outcome: 'written' | 'write_failed' | 'deadline'
  try {
    outcome = await Promise.race([
      write.then(() => 'written' as const, () => 'write_failed' as const),
      deps.sleep(SF_BUDGET_READING_DEADLINE_MS).then(() => 'deadline' as const),
    ])
  } catch {
    // Only the injected sleep can reject here; the write's own outcome is already caught.
    outcome = 'deadline'
  }
  if (outcome !== 'written') safeReport(deps, { event: 'sf_budget_reading_unrecorded', connection_id: call.connectionId, purpose: call.purpose, cause: outcome })
}

function safeReport(deps: ConnectionFetchDeps, event: ConnectionEvent): void {
  try {
    deps.report(event)
  } catch {
    // A report is never allowed to change the answer.
  }
}

async function needsReauth(
  deps: ConnectionFetchDeps, call: ConnectionCall, resolved: Resolved, cause: string, secrets: readonly string[], mintReason: MintFailureReason | null = null,
): Promise<never> {
  // A candidate is not the committed credential: its failure says nothing about the connection (F126).
  if (!resolved.candidate) {
    try {
      await deps.recordNeedsReauth(call.organizationId, call.connectionId, cause)
    } catch {
      safeReport(deps, { event: 'needs_reauth_unrecorded', connection_id: call.connectionId, purpose: call.purpose })
    }
  }
  throw refusal('connection_needs_reauth', cause, secrets, null, mintReason)
}

/**
 * A mint that failed, by its kind (Dan's decision 2, finding F129). Only a
 * committed copy's failure is recorded: a candidate is not the connection's
 * credential, so its failure says nothing about the connection (F126).
 */
async function mintFailed(
  deps: ConnectionFetchDeps, call: ConnectionCall, resolved: Resolved, err: LoginMintError, secrets: readonly string[],
): Promise<RequeueAt> {
  // The reason rides on every refusal below as a name from the closed set, so a caller can act on it (verify, #2335 PR 8).
  const reason = err.reason
  switch (err.kind) {
    case 'refused':
      return needsReauth(deps, call, resolved, `${NEEDS_REAUTH_CAUSES.loginRefused}: ${reason}`, secrets, reason)
    case 'rate_limited': {
      const now = deps.now()
      return new RequeueAt(err.retryAt === null ? new Date(now + RATE_LIMIT_DEFAULT_MS) : clampedRetry(now, err.retryAt.getTime()), 'rate_limited')
    }
    case 'not_allowed':
      throw refusal('connection_not_allowed', `the ${resolved.service} mint was refused by rule: ${reason}`, secrets, null, reason)
    case 'check_unavailable':
      throw refusal('connection_auth_check_unavailable', `the ${resolved.service} mint could not check its rule: ${reason}`, secrets, null, reason)
    case 'token_object_unavailable':
      // Our own infrastructure, not the login: nothing is recorded about the connection.
      throw refusal('connection_token_object_unavailable', `the ${resolved.service} login's token object: ${reason}`, secrets, null, reason)
    case 'unavailable': {
      if (resolved.candidate) throw refusal('connection_auth_unavailable', `the ${resolved.service} token endpoint is unavailable: ${reason}`, secrets, null, reason)
      let outcome: RefreshOutcome | null = null
      try {
        outcome = await deps.recordRefresh(call.organizationId, call.connectionId, { ok: false, cause: reason })
      } catch {
        safeReport(deps, { event: 'refresh_unrecorded', connection_id: call.connectionId, purpose: call.purpose })
      }
      if (outcome === 'needs_reauth') {
        // record_connection_refresh wrote needs_reauth itself, through its one writer.
        throw refusal('connection_needs_reauth', `${NEEDS_REAUTH_CAUSES.refreshFailingExhausted}: ${reason}`, secrets, null, reason)
      }
      if (outcome === 'connection_removed') throw refusal('connection_removed', 'the connection is removed', secrets)
      // The message states only what the database answered (L11): refresh_failing when it said so.
      const state = outcome === null ? 'the failure could not be recorded' : `the connection is ${outcome}`
      throw refusal('connection_auth_unavailable', `the ${resolved.service} token endpoint is unavailable (${reason}); ${state}`, secrets, null, reason)
    }
  }
}

/** A login a token endpoint answered ends a refresh streak. Its failure is reported and never changes the answer. */
async function endRefreshStreak(deps: ConnectionFetchDeps, call: ConnectionCall): Promise<void> {
  try {
    await deps.recordRefresh(call.organizationId, call.connectionId, { ok: true })
  } catch {
    safeReport(deps, { event: 'refresh_unrecorded', connection_id: call.connectionId, purpose: call.purpose })
  }
}

async function sendWithRenewal(
  deps: ConnectionFetchDeps, call: ConnectionCall, rules: ServiceRules, resolved: Resolved, login: OpenedLogin, loginSecrets: readonly string[],
  deadline: Deadline, url: string, init: RequestInit, budget: BudgetObserver | null,
): Promise<Response | RequeueAt> {
  const method = (init.method ?? 'GET').toUpperCase()
  // The connection's auth is the only credential a request carries: one the caller set is never sent.
  const callerHeaders = new Headers(init.headers)
  for (const name of [...callerHeaders.keys()]) if (isCredentialHeader(name)) callerHeaders.delete(name)
  const singleUse = isSingleUse(init.body)
  let secrets: readonly string[] = loginSecrets
  let rejected: Authorization | null = null

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (typeof call.record === 'function') {
      try {
        await call.record(sanitiseRequest({ method, url, headers: callerHeaders, body: init.body }, secrets, attempt))
      } catch {
        throw refusal('connection_record_failed', 'the sanitised request could not be recorded, so nothing was sent', secrets)
      }
    }

    let auth: Authorization
    let minted = false
    try {
      auth = await beforeDeadline(rules.authorize({
        organizationId: call.organizationId,
        connectionId: call.connectionId,
        service: resolved.service,
        generation: resolved.generation,
        target: resolved.target,
        publicConfig: resolved.publicConfig,
        envelope: resolved.envelope,
        login,
        candidate: resolved.candidate,
        renew: rejected === null ? null : { rejected },
        noteMint: () => { minted = true },
        fetch: tokenFetchFor(deps, rules, resolved, secrets),
      }), deadline)
    } catch (err) {
      const late = deadlineRefusal(deadline, 'the login', secrets)
      if (late) throw late
      if (err instanceof LoginMintError) return mintFailed(deps, call, resolved, err as LoginMintError, secrets)
      throw refusal('connection_auth_failed', `the ${resolved.service} auth failed without a declared cause`, secrets)
    }
    secrets = [...loginSecrets, ...auth.secrets, ...(rejected?.secrets ?? [])]
    if (minted && !resolved.candidate) await endRefreshStreak(deps, call)

    const headers = new Headers(callerHeaders)
    for (const [name, value] of Object.entries(auth.headers)) headers.set(name, value)
    let response: Response
    try {
      response = await beforeDeadline(deps.fetch(url, { method, headers, body: init.body, redirect: 'manual', signal: deadline.signal }), deadline)
    } catch {
      throw deadlineRefusal(deadline, `the ${method} request`, secrets) ?? refusal('connection_network_error', `the ${method} request to ${new URL(url).hostname} failed below HTTP`, secrets)
    }
    observeBudget(deps, call, budget, response)

    const requeue = rateLimited(response, deps.now())
    if (requeue) {
      discard(response)
      return requeue
    }

    let expired: boolean
    try {
      expired = await rules.expired(response.clone())
    } catch {
      expired = false
    }
    if (!expired) return response
    discard(response)
    if (attempt === 2) return needsReauth(deps, call, resolved, NEEDS_REAUTH_CAUSES.refusedAfterRenew, secrets)
    if (singleUse) throw refusal('connection_body_not_resendable', `the token expired on a ${method} whose body can be sent only once`, secrets)
    rejected = auth
  }
  // The loop returns or throws on its second attempt.
  throw refusal('connection_needs_reauth', NEEDS_REAUTH_CAUSES.refusedAfterRenew, secrets)
}
