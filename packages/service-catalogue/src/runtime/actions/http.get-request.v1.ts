import { hostOfTarget, httpSend, includeHeadersOf, requestUrl, stepHeaders } from '../http/call'
import type { ActionRun } from '../types'

/**
 * http.get-request, version 1 (#2337). Released: never edit it; a change is
 * version 2 (the fingerprint check refuses an edit).
 *
 * One GET to a path on the connection's declared host (or a whole address on
 * it), with the step's query parameters and headers, through the connection
 * bound fetch, which adds the key. It answers the data: parsed when the answer
 * says it is JSON, the text otherwise, and empty text for an empty answer;
 * with include_headers, { status, headers, data }. No Pipedream step in use
 * is a GET of its own: this is the custom request with GET chosen, kept apart
 * because a read is safe to repeat and changes nothing (its traits,
 * schema/services/http.ts).
 */
export const run: ActionRun = async (ctx, args) => {
  const host = hostOfTarget(ctx)
  const url = requestUrl(args, host)
  const headers = stepHeaders(args)
  const includeHeaders = includeHeadersOf(args)
  return httpSend(ctx, { method: 'GET', url, headers, writes: false, includeHeaders })
}
