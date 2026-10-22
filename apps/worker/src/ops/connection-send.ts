/**
 * A run step's send through a connection (#1950, PR 2 of B3): what
 * connectionFetch answers, turned into the ForwardAnswer the run invocation
 * judges a send by (run-invocation.ts). The ops executor's steps (#2339) hand
 * this to ctx.send as their forward:
 *
 *   ctx.send({ ..., forward: ({ signal }) => connectionAnswer(() => connectionFetch(deps, { ...call, signal }, url, init)) })
 *
 *  - a Response is answered, whatever its status;
 *  - a RequeueAt is a requeue, keeping its time, its cause and the HTTP status
 *    that asked for it (429, a 503 with Retry-After, or null when no request
 *    was made), which is what lets the run tell a 503 that may have been
 *    applied from a 429 that was not (#2337 comment, 2026-10-22);
 *  - a ConnectionRefusal whose cause comes before anything is sent is
 *    not_sent, by its code, and the ledger row is marked failed;
 *  - anything else is thrown, which the run records as a send whose outcome
 *    is unknown: a network error, a deadline or an abort may each come after
 *    the request left, and an error that is not a refusal says nothing.
 *
 * NOTHING_SENT_REFUSALS names every refusal code, so a new code must be
 * classified here before it compiles: a code read as not sent when the request
 * may have left would let a run repeat a send that landed.
 */
import { ConnectionRefusal, RequeueAt, type ConnectionRefusalCode } from './connections/refusals'
import type { ForwardAnswer } from './run-invocation'

/**
 * Whether a refusal proves nothing was applied. True: refused before sending,
 * or the service refused the request outright (an expired login refused it,
 * twice for needs_reauth). False: the request may have reached the service.
 */
export const NOTHING_SENT_REFUSALS: Readonly<Record<ConnectionRefusalCode, boolean>> = {
  connection_call_invalid: true,
  connection_removed: true,
  connection_withdrawn: true,
  connection_copy_expired: true,
  connection_not_found: true,
  connection_copy_unreadable: true,
  connection_service_unknown: true,
  connection_service_mismatch: true,
  connection_generation_older: true,
  connection_candidate_not_allowed: true,
  connection_seal_refused: true,
  connection_target_invalid: true,
  connection_url_invalid: true,
  connection_host_not_declared: true,
  sf_pool_busy: true,
  sf_org_unmeasured: true,
  sf_cap_unset: true,
  sf_purpose_cap_unset: true,
  sf_budget_floor: true,
  sf_budget_unmeasured: true,
  sf_lease_unavailable: true,
  connection_record_failed: true,
  // The service answered the expiry signal, a refusal of the request, on each try.
  connection_needs_reauth: true,
  connection_auth_unavailable: true,
  connection_not_allowed: true,
  connection_auth_check_unavailable: true,
  connection_token_object_unavailable: true,
  connection_auth_failed: true,
  // Below HTTP, past the deadline, or abandoned by the caller: it may have left.
  connection_network_error: false,
  connection_aborted: false,
  connection_timeout: false,
  // The first try was answered the expiry signal, so it was refused, and nothing was resent.
  connection_body_not_resendable: true,
  // Answered only to a caller that cannot wait, never to a step; a 429 or 503 it may be, so not proven.
  connection_rate_limited: false,
}

export async function connectionAnswer(send: () => Promise<Response | RequeueAt>): Promise<ForwardAnswer<Response>> {
  let answer: Response | RequeueAt
  try {
    answer = await send()
  } catch (err) {
    if (err instanceof ConnectionRefusal && NOTHING_SENT_REFUSALS[err.code]) return { kind: 'not_sent', reason: err.code }
    throw err
  }
  if (answer instanceof RequeueAt) return { kind: 'requeue', notBefore: answer.notBefore, cause: answer.cause, status: answer.status }
  return { kind: 'answered', status: answer.status, value: answer }
}
