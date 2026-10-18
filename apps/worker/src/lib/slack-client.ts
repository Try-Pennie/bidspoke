/**
 * The one place a Slack Web API client is built (#2331 phase 1b, #1689 D3).
 *
 * Slack calls go through slack-web-api-client (MIT, no runtime dependencies,
 * fetch only), pinned to an exact version in package.json, instead of a hand
 * written fetch per caller. Two of its defaults are wrong for this Worker, and
 * this factory turns both off for every client:
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
 * lib/__tests__/slack-client.test.ts asserts both on what a built client does.
 *
 * Callers: deliverMessage in lib/slack.ts (every alert), sendThreadReply
 * beside it (the summary under an alert), and in routes/api/integrations.ts
 * POST /slack/resolve (auth.test and the first conversations.list), POST
 * /slack's token check (auth.test) and GET /slack/channels
 * (conversations.list, paged). Nothing else calls Slack (#2331).
 */
import { SlackAPIClient, SlackAPIConnectionError, SlackAPIError } from 'slack-web-api-client'

/** Build a Slack client for a resolved connection's bot token, with no retries and no debug logging. */
export function createSlackClient(connection: { bot_token: string }): SlackAPIClient {
  return new SlackAPIClient(connection.bot_token, {
    // Only 'DEBUG' prints; 'ERROR' is the quietest level the library names.
    logLevel: 'ERROR',
    // A fresh empty list per client: no handler, so no in-request sleep.
    retryHandlers: [],
    // ok:false raises SlackAPIError, so a refusal can never read as a success.
    throwSlackAPIError: true,
  })
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
 * POST /slack/resolve (routes/api/integrations.ts) used fetchJson, which
 * parsed the body as JSON without looking at the status. So `ok:false` came
 * back as the body; a 429 or a 5xx whose body was Slack's JSON
 * (`{ ok: false, error: 'ratelimited' }`) came back as that body too; a body
 * that was not JSON threw SyntaxError; and no answer threw the fetch's own
 * error. This keeps every one of those, so what the Settings page is told
 * does not change:
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
