/**
 * The bidding Worker's one way to call the ops Worker's OpsConnections
 * entrypoint, through the OPS_CONNECTIONS service binding (wrangler.toml;
 * #2335, PR 9 of phase 5 of #1689; plan: discussion #2329, part 2).
 *
 * NEVER ON THE MONEY PATH (Hard Rule 1). Nothing in the engine, the nodes, the
 * Durable Objects or the webhook, shadow and custom endpoint routes imports
 * this module or names the binding, so a slow or failing ops Worker cannot slow
 * a bid. apps/web/src/lib/__guards__/worker/ops-connections-off-money-path.test.ts
 * fails on a direct or an indirect import from any of them, and on the binding
 * named anywhere but here and env.ts.
 *
 * WHO CALLS IT. Bidding code serving a signed in person (today the deploy probe,
 * routes/api/ops-connections-probe.ts; the Connections routes in Phase 8). Each
 * request names the caller's organization, derived from the verified JWT, and
 * ops acts on that organization's connections alone (ops-connections-contract.ts).
 *
 * EVERY CALL IS RACED AGAINST A DEADLINE. A service binding call has no timeout
 * of its own, so a stalled ops Worker would otherwise hold the request open. Each
 * deadline is longer than the ceiling ops itself answers ops_connections_timeout
 * at (OPS_CONNECTIONS_CEILINGS_MS), so ops says why by name before bidding gives
 * up; the test compares the two constants.
 *
 * WHAT IS UNAVAILABLE. A binding that is absent, that throws, that does not
 * answer within the deadline, or that answers something this contract does not
 * read is one answer, ops_connections_unavailable, carrying its cause. The Phase
 * 0 spike (#2330) measured that a binding to an entrypoint the deployed ops
 * Worker does not export deploys green and every call then throws a plain
 * "internal error; reference = <id>" naming no cause. So a throw is logged with
 * that reference id and its kind, never its message, and nothing here says the
 * ops Worker is down: it says the call did not answer.
 */
import { raceDeadline } from './alert-claim'
import type {
  AddDelegationSubjectAnswer, AddDelegationSubjectRequest, ClearReauthAnswer, ClearReauthRequest, ExchangeOAuthCodeAnswer, ExchangeOAuthCodeRequest,
  HealthAnswer, HealthRequest, ListDelegationSubjectsAnswer, ListDelegationSubjectsRequest, LookupAnswer, LookupRequest, OpsConnectionsBinding,
  OpsConnectionsMethod, OpsDelegationMethod, RemoveDelegationSubjectAnswer, RemoveDelegationSubjectRequest, RevokeAnswer, RevokeRequest, VerifyAnswer,
  VerifyRequest,
} from './ops-connections-contract'

/**
 * How long bidding waits for each method before answering
 * ops_connections_unavailable. Each is its OPS_CONNECTIONS_CEILINGS_MS ceiling
 * plus 5 s: the ceiling's timer starts only once the call has reached ops and
 * been parsed, so the margin covers the call's way there and back, an ops
 * isolate starting cold and the answer's serialisation, with room to spare
 * (the spike measured a refused call answering in 20 to 40 ms).
 */
export const OPS_CONNECTIONS_DEADLINES_MS: Readonly<Record<OpsConnectionsMethod, number>> = {
  verify: 50_000,
  clearReauth: 50_000,
  exchangeOAuthCode: 35_000,
  lookup: 30_000,
  revoke: 15_000,
  health: 15_000,
}

/**
 * The Google list's methods (#2338), on the same rule: each its ops ceiling
 * (OPS_DELEGATION_CEILINGS_MS, one database call, 10 s) plus 5 s. They are
 * called through the same binding, and kept out of OPS_CONNECTIONS_DEADLINES_MS
 * while they are out of OPS_CONNECTIONS_METHODS (the contract says why). The
 * create route (build PR 5) reads the list; PR 6 adds and removes entries.
 */
export const OPS_DELEGATION_DEADLINES_MS: Readonly<Record<OpsDelegationMethod, number>> = {
  addDelegationSubject: 15_000,
  removeDelegationSubject: 15_000,
  listDelegationSubjects: 15_000,
}

interface DelegationRequests {
  addDelegationSubject: AddDelegationSubjectRequest
  removeDelegationSubject: RemoveDelegationSubjectRequest
  listDelegationSubjects: ListDelegationSubjectsRequest
}

interface DelegationAnswers {
  addDelegationSubject: AddDelegationSubjectAnswer
  removeDelegationSubject: RemoveDelegationSubjectAnswer
  listDelegationSubjects: ListDelegationSubjectsAnswer
}

type AnyMethod = OpsConnectionsMethod | OpsDelegationMethod

const deadlineOf = (method: AnyMethod): number =>
  Object.hasOwn(OPS_CONNECTIONS_DEADLINES_MS, method) ? OPS_CONNECTIONS_DEADLINES_MS[method as OpsConnectionsMethod] : OPS_DELEGATION_DEADLINES_MS[method as OpsDelegationMethod]

interface Requests {
  verify: VerifyRequest
  clearReauth: ClearReauthRequest
  revoke: RevokeRequest
  health: HealthRequest
  lookup: LookupRequest
  exchangeOAuthCode: ExchangeOAuthCodeRequest
}

interface Answers {
  verify: VerifyAnswer
  clearReauth: ClearReauthAnswer
  revoke: RevokeAnswer
  health: HealthAnswer
  lookup: LookupAnswer
  exchangeOAuthCode: ExchangeOAuthCodeAnswer
}

/** Why the call gave no answer this contract reads. */
export type OpsConnectionsUnavailableCause = 'binding_absent' | 'threw' | 'deadline' | 'unreadable'

/** The answer a route renders as a 503 ("Connection checks are unavailable right now", with Retry). */
export interface OpsConnectionsUnavailable {
  ok: false
  refused: 'ops_connections_unavailable'
  cause: OpsConnectionsUnavailableCause
  /** The platform's reference id from a thrown binding error, when it carried one. */
  reference: string | null
  /** Names only. */
  detail: string
  retry_at: null
}

/** The HTTP status a route answers ops_connections_unavailable with. */
export const OPS_CONNECTIONS_UNAVAILABLE_STATUS = 503

export interface OpsConnectionsCallOptions {
  /** For tests: the deadline's timer. */
  delay?: (ms: number) => Promise<void>
}

/** The env this module reads: only the binding, optional because a deploy may lack it. */
export interface OpsConnectionsEnv {
  OPS_CONNECTIONS?: OpsConnectionsBinding
}

const REFERENCE = /\breference\s*=\s*([A-Za-z0-9-]{1,64})/

/** The platform's reference id from a thrown binding error, and nothing else of its message. */
function referenceOf(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return REFERENCE.exec(message)?.[1] ?? null
}

function causeSentence(method: AnyMethod, cause: OpsConnectionsUnavailableCause, reference: string | null, errorKind: string | null): string {
  switch (cause) {
    case 'binding_absent':
      return 'this deploy of the bidding Worker has no OPS_CONNECTIONS binding'
    case 'deadline':
      return `the OpsConnections ${method} call did not answer within ${deadlineOf(method) / 1000} s`
    case 'unreadable':
      return `the OpsConnections ${method} call answered something this contract does not read`
    case 'threw':
      return `the call to OpsConnections ${method} through the binding threw (${errorKind ?? 'not an Error'}, ${reference ? `reference ${reference}` : 'no reference id'}); the error names no cause, so it does not say whether the ops Worker is running`
  }
}

function unavailable(
  method: AnyMethod, organizationId: string | null, cause: OpsConnectionsUnavailableCause, reference: string | null = null, errorKind: string | null = null,
): OpsConnectionsUnavailable {
  // One line of names: never the request, never the error's message.
  console.warn(JSON.stringify({
    event: 'ops_connections_unavailable', method, cause, reference, error_kind: errorKind, organization_id: organizationId, deadline_ms: deadlineOf(method),
  }))
  return { ok: false, refused: 'ops_connections_unavailable', cause, reference, detail: causeSentence(method, cause, reference, errorKind), retry_at: null }
}

/** An answer of the contract's shape: an object whose ok is a boolean, a refusal naming its code. */
function readable(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const answer = raw as { ok?: unknown; refused?: unknown }
  if (answer.ok === true) return true
  return answer.ok === false && typeof answer.refused === 'string'
}

function organizationOf(request: unknown): string | null {
  const org = request !== null && typeof request === 'object' ? (request as { organization_id?: unknown }).organization_id : undefined
  return typeof org === 'string' ? org : null
}

async function callMethod(env: OpsConnectionsEnv, method: AnyMethod, request: unknown, options: OpsConnectionsCallOptions): Promise<unknown> {
  const organizationId = organizationOf(request)
  const bound = env.OPS_CONNECTIONS
  if (!bound) return unavailable(method, organizationId, 'binding_absent')
  // A Google list method the deployed ops Worker does not export throws (a
  // double lacking it throws TypeError), which is answered as a throw.
  const call = (bound as Partial<Record<AnyMethod, (request: unknown) => Promise<unknown>>>)[method]
  const raced = await raceDeadline(() => (call as (request: unknown) => Promise<unknown>).call(bound, request), deadlineOf(method), options.delay)
  if (raced.kind === 'timed_out') return unavailable(method, organizationId, 'deadline')
  if (raced.kind === 'threw') {
    return unavailable(method, organizationId, 'threw', referenceOf(raced.error), raced.error instanceof Error ? raced.error.name : null)
  }
  if (!readable(raced.value)) return unavailable(method, organizationId, 'unreadable')
  return raced.value
}

/** One OpsConnections call: ops's answer (a refusal included), or ops_connections_unavailable. Never throws. */
export async function callOpsConnections<M extends OpsConnectionsMethod>(
  env: OpsConnectionsEnv, method: M, request: Requests[M], options: OpsConnectionsCallOptions = {},
): Promise<Answers[M] | OpsConnectionsUnavailable> {
  return (await callMethod(env, method, request, options)) as Answers[M] | OpsConnectionsUnavailable
}

/** One call to a Google list method (#2338), on the same rules as callOpsConnections. Never throws. */
export async function callOpsDelegation<M extends OpsDelegationMethod>(
  env: OpsConnectionsEnv, method: M, request: DelegationRequests[M], options: OpsConnectionsCallOptions = {},
): Promise<DelegationAnswers[M] | OpsConnectionsUnavailable> {
  return (await callMethod(env, method, request, options)) as DelegationAnswers[M] | OpsConnectionsUnavailable
}

export function isOpsConnectionsUnavailable(answer: unknown): answer is OpsConnectionsUnavailable {
  return readable(answer) && (answer as { refused?: unknown }).refused === 'ops_connections_unavailable'
}

/**
 * The deploy probe's request: a health request with no organization, which
 * ops's contract refuses (ops_connections_request_invalid) after its lane check
 * and before it builds a database client, so the call reads and writes nothing
 * and touches nobody's data. That answer proves the binding resolved, the
 * deployed ops Worker exports OpsConnections with health, and its LANE is ops.
 */
export const OPS_CONNECTIONS_PROBE_REQUEST: Readonly<Record<string, string>> = Object.freeze({ probe: 'deploy' })
export const OPS_CONNECTIONS_PROBE_EXPECTED = 'ops_connections_request_invalid'

export type OpsConnectionsProbeResult =
  | { outcome: 'answered'; method: 'health'; answer: typeof OPS_CONNECTIONS_PROBE_EXPECTED }
  /** Ops answered, but not the refusal the probe request earns: its config, not the binding. */
  | { outcome: 'unexpected'; method: 'health'; answer: string }
  | { outcome: 'unavailable'; method: 'health'; cause: OpsConnectionsUnavailableCause; reference: string | null; detail: string }

export async function probeOpsConnections(env: OpsConnectionsEnv, options: OpsConnectionsCallOptions = {}): Promise<OpsConnectionsProbeResult> {
  const answer = await callMethod(env, 'health', OPS_CONNECTIONS_PROBE_REQUEST, options)
  if (isOpsConnectionsUnavailable(answer)) {
    return { outcome: 'unavailable', method: 'health', cause: answer.cause, reference: answer.reference, detail: answer.detail }
  }
  const { ok, refused } = answer as { ok: boolean; refused?: string }
  if (!ok && refused === OPS_CONNECTIONS_PROBE_EXPECTED) return { outcome: 'answered', method: 'health', answer: OPS_CONNECTIONS_PROBE_EXPECTED }
  return { outcome: 'unexpected', method: 'health', answer: ok ? 'ok' : String(refused) }
}
