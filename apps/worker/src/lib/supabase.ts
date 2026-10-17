import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import type { Database } from '../types/database'
import rpcLists from './read-only-rpcs.json'
import { guardLocalDevWrites, type RpcClassification } from './local-dev-write-guard'
import { secretKeys } from './secret-crypto'
import { registerSlackKeyRing } from './slack-key-ring'

// Local `wrangler dev` shares the real production Supabase project (there is no
// separate local backend), and the Worker connects as service_role, which
// bypasses RLS. So a local run can write anywhere in production. The guard in
// ./local-dev-write-guard blocks writes from local dev unless the operator
// explicitly opts in (#669); the ops database client carries the same guard
// (#1709).
//
// Reads stay allowed, and so do the rpcs on the READ ONLY list in
// read-only-rpcs.json (#1409, L96). The old rule let every rpc through on the
// claim that all of them read; record_archive_day_measurement already wrote,
// and save_buyer_profile is a user facing write path, so the rule is now an
// allowlist: a mutating rpc, or one nobody has classified, is refused with the
// same message as a blocked insert. auth_user_with_allowlist runs on every
// authenticated request and is on the read only list, so local dev stays usable.
const READ_ONLY_RPCS: ReadonlySet<string> = new Set(rpcLists.readOnly)
/** Exported for the guard tests and so a scan can name the writers (L41). */
export const MUTATING_RPCS: ReadonlySet<string> = new Set(rpcLists.mutating)

const BIDDING_RPCS: RpcClassification = {
  readOnly: READ_ONLY_RPCS,
  mutating: MUTATING_RPCS,
  listFile: 'apps/worker/src/lib/read-only-rpcs.json',
}

/**
 * Every Supabase request is abandoned after this long (#1484).
 *
 * service_role carries a 30s statement_timeout, so Postgres already bounds a query
 * it is RUNNING. What it does not bound is a connection that stalls before or after
 * the query (TCP, the pooler, PostgREST, or a response body that stops mid-stream):
 * on 2026-09-23 one such call left the 14:23 archive run waiting 899,991 ms until
 * the platform killed it on wall time. #1480 put a deadline on every Snowflake
 * request; this is the same for Supabase.
 *
 * ONE value for every path (webhook executions, step logging, crons, admin),
 * because the 30s statement_timeout already bounds every real query uniformly, so
 * only a stall can exceed it, and a stall is equally unwelcome everywhere. It sits
 * ABOVE the 30s statement_timeout, with margin for Postgres to cancel a slow query
 * and PostgREST to return its own 57014 error, so a slow QUERY fails with that
 * message rather than this abort; only a genuine stall reaches the abort.
 */
export const SUPABASE_REQUEST_DEADLINE_MS = 45_000

/** A Supabase request abandoned at its deadline, distinct from one that failed outright. */
export class SupabaseRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SupabaseRequestTimeoutError'
  }
}

/**
 * Combine a caller's signal with the deadline timeout into one that aborts when
 * either does, carrying the reason of whichever fired. Built from AbortController
 * and addEventListener rather than AbortSignal.any, which has no proven support on
 * this worker's runtime; AbortSignal.timeout does (snowflake.ts), and these two
 * primitives are older still.
 *
 * The combined signal must stay abortable for the whole request, the response body
 * read included, so the listeners cannot be torn down when fetch RESOLVES (that is
 * only the headers phase; the body is read afterwards). Instead each listener is
 * `once`, so the caller's is removed the moment it fires, and the timeout's handler
 * also removes the caller's when IT fires, so by the deadline (when the request is
 * certainly over) nothing is left on the caller's signal. For the real callers,
 * whose signal is a short-lived AbortSignal.timeout, the listener is gone as soon
 * as that fires; only a long-lived reused signal would hold one until the deadline,
 * and never for longer.
 */
function anyOf(caller: AbortSignal, timeout: AbortSignal): AbortSignal {
  if (caller.aborted) return caller
  if (timeout.aborted) return timeout
  const ctrl = new AbortController()
  const onCaller = () => ctrl.abort(caller.reason)
  const onTimeout = () => {
    ctrl.abort(timeout.reason)
    caller.removeEventListener('abort', onCaller)
  }
  caller.addEventListener('abort', onCaller, { once: true })
  timeout.addEventListener('abort', onTimeout, { once: true })
  return ctrl.signal
}

/**
 * Wrap a fetch so every call carries a deadline, bounding a connection that stalls
 * before, during or after the query.
 *
 * The AbortSignal is passed to the underlying fetch, which ties it to the whole
 * request AND the response body stream, so a response whose headers arrive and
 * whose body then stalls is still abandoned at the deadline rather than hanging the
 * run. The NAMED SupabaseRequestTimeoutError is thrown only for an abort in the
 * headers phase, which this function awaits; a body-phase stall aborts while the
 * caller (supabase-js) reads the body, outside this try, and surfaces as the
 * signal's own TimeoutError. Both are bounded; only the common case is renamed.
 *
 * A caller that already passes its own signal (the per-read lead budget, the
 * volume-cliff probe) keeps it: the two are combined, whichever fires first wins,
 * and a shorter caller deadline still reports as that caller's abort rather than
 * this one.
 */
export function withRequestDeadline(
  baseFetch: typeof fetch,
  deadlineMs: number = SUPABASE_REQUEST_DEADLINE_MS,
): typeof fetch {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(deadlineMs)
    const signal = init?.signal ? anyOf(init.signal, timeout) : timeout
    try {
      return await baseFetch(input, { ...init, signal })
    } catch (e) {
      // Only OUR deadline becomes the named error. An incoming signal aborting
      // (a shorter caller budget) is that caller's concern and is re-thrown as is.
      if (timeout.aborted && !(init?.signal?.aborted ?? false)) {
        const method = (init?.method ?? 'GET').toUpperCase()
        throw new SupabaseRequestTimeoutError(
          `Supabase ${method} got no answer within ${deadlineMs} ms, so the request was abandoned`,
        )
      }
      throw e
    }
  }
}

/**
 * `retry: false` turns off the library's own read retries (1, 2 and 4 s waits)
 * for every read on the client; a lead's client sets it (#1844).
 */
export function createSupabaseClient(env: Env, options: { fetch?: typeof fetch; retry?: boolean } = {}): SupabaseClient<Database> {
  // Every request carries a deadline, so a stalled connection cannot hang the run
  // (#1484). The injected fetch (tests, the lead's client) is wrapped too, so there
  // is no path to the client without one. When none is injected, the global fetch is
  // looked up per call rather than captured here, so a later global replacement
  // (a test's vi.stubGlobal, the runtime swapping it) is still honoured, as it was
  // before this wrapper existed.
  const baseFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init))
  // The outage drill overrides the deadline so it need not wait 45s out for every
  // simulated-stall call; a bad value falls back to the production default rather
  // than to NaN (L50).
  const override = Number(env.SUPABASE_REQUEST_DEADLINE_MS)
  const deadlineMs = Number.isFinite(override) && override > 0 ? override : SUPABASE_REQUEST_DEADLINE_MS
  const client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
    ...(options.retry === false ? { db: { retry: false } } : {}),
    global: { fetch: withRequestDeadline(baseFetch, deadlineMs) },
  })
  const guarded = guardLocalDevWrites(client, env, env.SUPABASE_URL, BIDDING_RPCS)
  // The Slack readers open the sealed bot token with this client's ring (#2331).
  // Read here, once, from the env the client was built with; a missing key is
  // left for the reader to report by name rather than failing every client.
  if (env.SECRET_ENCRYPTION_KEY) registerSlackKeyRing(guarded, secretKeys(env))
  return guarded
}
