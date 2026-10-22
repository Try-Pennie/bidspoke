/**
 * @bidspoke/slack-client: the one place a Slack Web API client is built
 * (#2331 phase 1b, #1689 D3). It moved here from the Worker's
 * lib/slack-client.ts (#2337) so the service catalogue's ops Slack actions
 * (Phase 7) build their clients in the same place as every alert, under the
 * same two settings and the same guards, rather than through a copy.
 *
 * Slack calls go through slack-web-api-client (MIT, no runtime dependencies,
 * fetch only), pinned to an exact version in this package's package.json, the
 * only manifest in the repo allowed to declare it, instead of a hand written
 * fetch per caller. Two of its defaults are wrong for a Worker, and this
 * factory turns both off for every client:
 *
 * - The rate limit retry handler. It sleeps for whatever Retry-After says
 *   inside the request, with no cap and no clock a test can move (L365, L524),
 *   so one 429 could hold an alert, or a request, for as long as Slack asks.
 *   With no handler a 429 comes back at once as an error, and the caller
 *   decides (an alert logs it and moves on).
 * - Debug logging. At DEBUG the library prints every request body and every
 *   response, and for oauth.v2.access the body holds the client secret and the
 *   refresh token. Nothing may set it, here or anywhere.
 *
 * src/__tests__/client.test.ts asserts both on what a built client does, and
 * src/__tests__/connection-bound.test.ts on the connection bound client.
 * apps/web/src/lib/__guards__/worker/slack-calls-one-client.test.ts fails on
 * any Slack call made any other way, in the src of any workspace package (the
 * Worker and packages/service-catalogue included), and on any import of the
 * library outside this file: a caller takes the types it needs from here.
 *
 * Callers with a bot token, all in the Worker: deliverMessage in lib/slack.ts
 * (every alert), sendThreadReply beside it (the summary under an alert), and in
 * routes/api/integrations.ts POST /slack/resolve (auth.test and the first
 * conversations.list) and GET /slack/channels (conversations.list, paged), and
 * lib/slack-token-check.ts's auth.test, which POST /slack's token check and
 * the Connections list's status of the alert login (#2338) both ask.
 *
 * Callers with a connection's fetch (#2337), on the ops Worker, never holding
 * the login: the service catalogue's Slack actions
 * (packages/service-catalogue/src/runtime/slack) and the ops Slack verify
 * (apps/worker/src/ops/connections/slack-service.ts). Nothing else calls Slack.
 */
import { SlackAPIClient, SlackAPIConnectionError, SlackAPIError } from 'slack-web-api-client'

/** The library's types a caller needs, re-exported so nothing else imports the library (#2337). */
export type { AnyMessageBlock, SlackAPIClient } from 'slack-web-api-client'

/** The fetch a connection bound client sends through: the ops connectionFetch, which applies the login itself. */
export type SlackFetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * What a client is built for: a bot token the caller holds (the Worker's
 * alerts and Settings routes), or a connection's fetch (the ops Slack actions
 * and the ops Slack verify, #2337), which holds the login itself.
 */
export type SlackConnection = { readonly bot_token: string } | { readonly fetch: SlackFetch; readonly signal?: AbortSignal }

/**
 * The library's request, sent through a connection's fetch (#2337). The
 * library always sends through the global fetch and offers no other way, but
 * an ops request must go through connectionFetch, which applies the login
 * after recording the request and refuses any host the connection did not
 * declare. So `call`, which every API method the library binds goes through,
 * builds the request exactly as the library's own `call` does (pinned
 * 1.1.15, dist/client/api-client.js: form encoded, an object as JSON, a list
 * of plain values joined by commas, null and undefined left out) and reads the
 * answer exactly as it does (any status but 200 a SlackAPIConnectionError
 * carrying the body and headers, ok:false with a code a SlackAPIError), with
 * two differences on purpose:
 *
 * - no Authorization header, and a `token` parameter is refused before
 *   anything is sent: the connection applies the login, never the caller;
 * - what the fetch throws is passed on unchanged rather than wrapped in a
 *   SlackAPIConnectionError, because an ops action leaves a refusal, a requeue
 *   or a timeout to the executor, which reads them as themselves.
 *
 * The two upload methods do not go through `call` (they send through the
 * global fetch), so they are refused here. Re-read the library's `call` when
 * the pinned version changes.
 */
class ConnectionBoundSlackClient extends SlackAPIClient {
  readonly #fetch: SlackFetch
  readonly #signal: AbortSignal | undefined

  constructor(fetch: SlackFetch, signal: AbortSignal | undefined, options: ConstructorParameters<typeof SlackAPIClient>[1]) {
    super(undefined, options)
    this.#fetch = fetch
    this.#signal = signal
    const refuse = (name: string) => () =>
      Promise.reject(new Error(`${name} is not available on a connection bound Slack client: it sends through the global fetch`))
    const files = this.files as unknown as Record<string, unknown>
    files.upload = refuse('files.upload')
    files.uploadV2 = refuse('files.uploadV2')
  }

  override async call(name: string, params: Record<string, unknown> = {}): Promise<never> {
    if (params !== null && params !== undefined && Object.hasOwn(params, 'token')) {
      throw new Error(`${name}: a connection bound Slack call takes no token; the connection applies the login`)
    }
    const form: Record<string, string> = {}
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null) continue
      if (typeof value === 'object') {
        form[key] = Array.isArray(value) && value.length > 0 && typeof value[0] !== 'object'
          ? value.map((v: unknown) => String(v)).join(',')
          : JSON.stringify(value)
      } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        form[key] = String(value)
      } else {
        throw new Error(`${name}: the parameter ${key} is not a value Slack can be sent`)
      }
    }
    const response = await this.#fetch(`${SLACK_API_BASE}${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      ...(this.#signal ? { signal: this.#signal } : {}),
    })
    if (response.status !== 200) {
      throw new SlackAPIConnectionError(name, response.status, await response.text(), response.headers, undefined)
    }
    const body = (await response.json()) as Record<string, unknown>
    const result: Record<string, unknown> = { ...body, headers: response.headers }
    const error = body.error
    if (typeof error === 'string' && error !== '') throw new SlackAPIError(name, error, result as never)
    return result as never
  }
}

/**
 * Where the library sends (its default baseUrl), named here and nowhere else:
 * the one place the guard slack-calls-one-client.test.ts lets name it.
 */
const SLACK_API_BASE = 'https://slack.com/api/'

/** Build a Slack client for a resolved connection, with no retries and no debug logging. */
export function createSlackClient(connection: SlackConnection): SlackAPIClient {
  const options = {
    // Only 'DEBUG' prints; 'ERROR' is the quietest level the library names.
    logLevel: 'ERROR' as const,
    // A fresh empty list per client: no handler, so no in-request sleep.
    retryHandlers: [],
    // ok:false raises SlackAPIError, so a refusal can never read as a success.
    throwSlackAPIError: true,
  }
  if ('fetch' in connection) return new ConnectionBoundSlackClient(connection.fetch, connection.signal, options)
  return new SlackAPIClient(connection.bot_token, options)
}

/**
 * A Slack call that got an ANSWER, and the answer was a failure. In the pinned
 * version (1.1.14) the library throws exactly these for an answer:
 *
 * - `SlackAPIError` for HTTP 200 with `ok:false` and an `error` code;
 * - `SlackAPIConnectionError` with the HTTP status for any status but 200 (a
 *   429 and a 5xx included), carrying the response headers.
 *
 * It also throws `SlackAPIConnectionError`, with status -1 and the fetch error
 * as `cause`, when there was NO answer (a network failure), which is not a
 * failure answer and reads as null here. Anything else (a 200 whose body is not
 * JSON throws SyntaxError) also reads as null. Re-read the library's
 * errors.js and client/api-client.js when the pinned version changes.
 */
export type SlackCallFailure =
  | { kind: 'api'; error: string }
  | { kind: 'http'; status: number; retryAfter: string | null }

export function slackCallFailure(e: unknown): SlackCallFailure | null {
  if (e instanceof SlackAPIError) return { kind: 'api', error: e.error }
  if (e instanceof SlackAPIConnectionError && e.status > 0) {
    return { kind: 'http', status: e.status, retryAfter: e.headers?.get('Retry-After') ?? null }
  }
  return null
}

/**
 * A Slack call read the way the Settings routes read Slack before the client
 * (#2331): the BODY of any answer is the answer, whatever its status.
 *
 * POST /slack/resolve and GET /slack/channels (routes/api/integrations.ts,
 * every paged conversations.list) used fetchJson, which parsed the body as
 * JSON without looking at the status. So `ok:false` came back as the body;
 * a 429 or a 5xx whose body was Slack's JSON (`{ ok: false, error:
 * 'ratelimited' }`) came back as that body too; a body that was not JSON
 * threw SyntaxError; and no answer threw the fetch's own error. Both routes
 * now read their answers through this, which keeps every one of those, so
 * what the Settings page is told does not change:
 *
 * - success, and `ok:false` with no code (the library returns it without
 *   throwing): the result as returned;
 * - `ok:false` with a code (SlackAPIError): the body it carried;
 * - any status but 200 (SlackAPIConnectionError with that status): its body
 *   parsed as JSON, which throws SyntaxError when it is not JSON, as before.
 *   A 429 is never waited for (the client has no retry handler); its
 *   Retry-After is logged;
 * - no answer: the fetch's own error, rethrown (slackNetworkCause).
 */
export async function slackBodyOf<T>(apiName: string, call: () => Promise<T>): Promise<T & { ok?: boolean; error?: string }> {
  try {
    return (await call()) as T & { ok?: boolean; error?: string }
  } catch (e) {
    if (e instanceof SlackAPIError) return e.result as unknown as T & { ok?: boolean; error?: string }
    if (e instanceof SlackAPIConnectionError && e.status > 0) {
      const retryAfter = e.headers?.get('Retry-After') ?? null
      console.warn(`[slack] ${apiName} HTTP error ${e.status}${retryAfter ? `, Retry-After ${retryAfter} s, not waited for` : ''}`)
      return JSON.parse(e.body) as T & { ok?: boolean; error?: string }
    }
    throw slackNetworkCause(e)
  }
}

/**
 * What a caller rethrows or logs for a failure that was not a Slack answer: for
 * a network failure, the error the fetch itself threw (so the value is the one
 * a hand written fetch threw before the switch), and anything else as is.
 * deliverMessage rethrows it; sendThreadReply, which never throws (F123), logs
 * it.
 */
export function slackNetworkCause(e: unknown): unknown {
  if (e instanceof SlackAPIConnectionError && e.status <= 0 && e.cause !== undefined) return e.cause
  return e
}
