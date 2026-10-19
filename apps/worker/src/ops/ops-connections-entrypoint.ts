/**
 * OpsConnections: the ops Worker's connections entrypoint (#2335, PR 8 of phase
 * 5 of #1689; plan: discussion #2329, part 2): verify, clearReauth, revoke,
 * health, lookup and exchangeOAuthCode.
 *
 * WHO MAY CALL IT. Only a Worker holding a service binding to this named
 * entrypoint of bidspoke-worker-ops: the bidding Worker, through the
 * OPS_CONNECTIONS binding PR 9 adds (nothing binds it in the deploy that adds
 * it). Cloudflare routes public traffic only to a Worker's DEFAULT export, and
 * the ops fetch handler (index.ts) has no path that forwards here, so no public
 * request reaches a method. A Worker on this account could reach it only by
 * declaring its own binding, which takes a deploy.
 *
 * WHOSE DATA. Each request names one organization, which the bidding Worker
 * derives from its caller's JWT, and each method touches only that
 * organization's connections (connections/ops-connections.ts says how).
 *
 * EVERY ANSWER IS A VALUE, a refusal included: a rejection crossing an RPC call
 * surfaces in workerd as an uncaught error on this side as well as the
 * caller's (internal.ts). In order: the lane (LANE must be "ops", as every ops
 * request is held to), the request parsed by the contract (lib/ops-connections-contract.ts,
 * L50), the live dependencies (a missing secret is refused naming it), then
 * the method raced against its ceiling (OPS_CONNECTIONS_CEILINGS_MS): past it
 * the work is aborted and the answer is ops_connections_timeout, so ops answers
 * by name before the bidding Worker's own deadline (PR 9) gives up on it.
 *
 * DEPLOY ORDER (Phase 0 spike, #2330). This ships on ops before any binding to
 * it; Cloudflare accepts a binding to an entrypoint the deployed Worker does not
 * export and every call then throws "internal error". So this entrypoint is the
 * ops Worker's rollback floor once bidding binds it (docs/disaster-recovery.md),
 * and ops-connections-entrypoint.test.ts fails if it stops being exported.
 *
 * Each call logs one line of names: the method, the outcome code and the
 * organization. Never a request's candidate, code or verifier, and never a
 * refusal's detail.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import { raceDeadline } from '../lib/alert-claim'
import {
  OPS_CONNECTIONS_CEILINGS_MS, OpsConnectionsContractError, parseClearReauthRequest, parseExchangeOAuthCodeRequest, parseHealthRequest, parseLookupRequest,
  parseRevokeRequest, parseVerifyRequest, type ClearReauthAnswer, type ExchangeOAuthCodeAnswer, type HealthAnswer, type LookupAnswer, type OpsConnectionsMethod,
  type OpsConnectionsRefused, type RevokeAnswer, type VerifyAnswer,
} from '../lib/ops-connections-contract'
import {
  clearReauth, connectionHealth, exchangeConnectionCode, lookupConnection, revokeConnection, verifyConnection, type OpsConnectionsDeps,
} from './connections/ops-connections'
import { OPS_LANE, type OpsEnv } from './index'
import { OpsDatabaseConfigError } from './ops-db'
import { liveOpsConnectionsDeps, OpsConnectionsNotConfigured } from './ops-connections-live'

type Runner<Req, Ans> = (deps: OpsConnectionsDeps, request: Req, signal: AbortSignal) => Promise<Ans>

/** The methods that open a sealed login, and so need the ops private key. */
const OPENS_LOGINS: ReadonlySet<OpsConnectionsMethod> = new Set(['verify', 'clearReauth', 'lookup'])

const RUNNERS: { readonly [M in OpsConnectionsMethod]: Runner<never, unknown> } = {
  verify: verifyConnection,
  clearReauth,
  revoke: (deps, request) => revokeConnection(deps, request),
  health: (deps, request) => connectionHealth(deps, request),
  lookup: lookupConnection,
  exchangeOAuthCode: (deps, request) => exchangeConnectionCode(deps, request),
}

export interface OpsConnectionsAnswerOptions<Req, Ans> {
  /** For tests: the method body, in place of the real one. */
  run?: Runner<Req, Ans>
  /** For tests: the ops database client's fetch. */
  opsFetch?: typeof fetch
  /** For tests: the ceiling's timer. */
  delay?: (ms: number) => Promise<void>
}

const refused = (code: OpsConnectionsRefused['refused'], detail: string): OpsConnectionsRefused => ({ ok: false, refused: code, detail, retry_at: null })

function logAnswer(method: OpsConnectionsMethod, answer: { ok: boolean; refused?: string }, organizationId: string | null): void {
  console.log(JSON.stringify({ event: 'ops_connections', method, outcome: answer.ok ? 'ok' : answer.refused, organization_id: organizationId }))
}

/**
 * One call to one method, every step answered as a value. Exported for the
 * tests, which drive it with doubles; the entrypoint passes nothing but the env.
 */
export async function opsConnectionsAnswer<Req extends { organization_id: string }, Ans extends { ok: boolean }>(
  env: OpsEnv, method: OpsConnectionsMethod, raw: unknown, parse: (raw: unknown) => Req, options: OpsConnectionsAnswerOptions<Req, Ans> = {},
): Promise<Ans | OpsConnectionsRefused> {
  if (env.LANE !== OPS_LANE) {
    const answer = env.LANE ? refused('lane_not_ops', `this Worker serves the ${env.LANE} lane`) : refused('lane_unset', 'LANE is not set on this Worker')
    logAnswer(method, answer, null)
    return answer
  }
  let request: Req
  try {
    request = parse(raw)
  } catch (err) {
    // The contract's messages name a field, never a value.
    const answer = refused('ops_connections_request_invalid', err instanceof OpsConnectionsContractError ? err.message : 'the request could not be read')
    logAnswer(method, answer, null)
    return answer
  }

  let deps: OpsConnectionsDeps
  try {
    deps = liveOpsConnectionsDeps(env, { opsFetch: options.opsFetch, opensLogins: OPENS_LOGINS.has(method) })
  } catch (err) {
    const answer = err instanceof OpsDatabaseConfigError || err instanceof OpsConnectionsNotConfigured
      ? refused('ops_connections_not_configured', err.message)
      : refused('ops_connections_failed', `the ops connections could not be set up (an unexpected ${err instanceof Error ? err.name : 'error'})`)
    logAnswer(method, answer, request.organization_id)
    return answer
  }

  const run = options.run ?? (RUNNERS[method] as unknown as Runner<Req, Ans>)
  const ceilingMs = OPS_CONNECTIONS_CEILINGS_MS[method]
  const controller = new AbortController()
  const raced = await raceDeadline(() => run(deps, request, controller.signal), ceilingMs, options.delay)
  let answer: Ans | OpsConnectionsRefused
  if (raced.kind === 'timed_out') {
    controller.abort()
    answer = refused('ops_connections_timeout', `${method} did not finish within its ${ceilingMs / 1000} s ceiling, so it was stopped`)
  } else if (raced.kind === 'threw') {
    // Every method answers its own failures as values; a throw is a defect, named by its kind only.
    answer = refused('ops_connections_failed', `${method} failed with an unexpected ${raced.error instanceof Error ? raced.error.name : 'error'}`)
  } else {
    answer = raced.value
  }
  logAnswer(method, answer, request.organization_id)
  return answer
}

export class OpsConnections extends WorkerEntrypoint<OpsEnv> {
  verify(request: unknown): Promise<VerifyAnswer> {
    return opsConnectionsAnswer(this.env, 'verify', request, parseVerifyRequest)
  }

  clearReauth(request: unknown): Promise<ClearReauthAnswer> {
    return opsConnectionsAnswer(this.env, 'clearReauth', request, parseClearReauthRequest)
  }

  revoke(request: unknown): Promise<RevokeAnswer> {
    return opsConnectionsAnswer(this.env, 'revoke', request, parseRevokeRequest)
  }

  health(request: unknown): Promise<HealthAnswer> {
    return opsConnectionsAnswer(this.env, 'health', request, parseHealthRequest)
  }

  lookup(request: unknown): Promise<LookupAnswer> {
    return opsConnectionsAnswer(this.env, 'lookup', request, parseLookupRequest)
  }

  exchangeOAuthCode(request: unknown): Promise<ExchangeOAuthCodeAnswer> {
    return opsConnectionsAnswer(this.env, 'exchangeOAuthCode', request, parseExchangeOAuthCodeRequest)
  }
}
