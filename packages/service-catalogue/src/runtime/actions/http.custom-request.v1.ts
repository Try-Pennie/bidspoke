import { ActionFailure } from '../failure'
import { HTTP_METHODS, hostOfTarget, httpSend, includeHeadersOf, invalid, requestUrl, stepHeaders, type HttpMethod } from '../http/call'
import type { ActionArgs, ActionRun, JsonValue } from '../types'

/**
 * http.custom-request, version 1 (#2337). Released: never edit it; a change is
 * version 2 (the fingerprint check refuses an edit).
 *
 * Pipedream's Send any HTTP Request (PipedreamHQ/pipedream
 * components/http/actions/custom-request/custom-request.mjs, at commit
 * b7d67916), and its Send POST Request, which is the same step with POST
 * chosen. One request by the step's method to a path on the connection's
 * declared host (or a whole address on it), with its query parameters,
 * headers and at most one body, through the connection bound fetch, which adds
 * the key. What differs from Pipedream, on purpose:
 *  - the host is the connection's, so a step cannot send its key elsewhere,
 *    and Pipedream's own auth settings (basic, bearer) are the connection's header;
 *  - a body is one of `body` (JSON, sent as application/json), `body_text`
 *    (sent as written, text/plain unless the headers name a type) or `form`
 *    (an object, sent url encoded), never two; a GET or HEAD takes none;
 *  - with include_headers the answer is { status, headers, data }, where
 *    Pipedream exported the headers beside the data, since a step has one output;
 *  - an answer that is not 2xx fails by its status (runtime/http/call.ts).
 */

const NO_BODY: ReadonlySet<HttpMethod> = new Set(['GET', 'HEAD'])

function isObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function methodOf(args: ActionArgs): HttpMethod {
  const raw = args.method
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) throw new ActionFailure('http_method_missing', 'the step names no method', 'not_applied')
  if (typeof raw !== 'string') throw invalid('method must be text')
  const method = raw.trim().toUpperCase()
  if (!(HTTP_METHODS as readonly string[]).includes(method)) throw invalid(`method must be one of ${HTTP_METHODS.join(', ')}`)
  return method as HttpMethod
}

const present = (value: JsonValue | undefined) => value !== undefined && value !== null

/** The one body the step names, and the type it is sent as unless the headers name one. */
function bodyOf(args: ActionArgs, method: HttpMethod): { body: string; type: string } | undefined {
  const named = (['body', 'body_text', 'form'] as const).filter((k) => present(args[k]))
  if (named.length > 1) throw invalid(`a request takes one body, and ${named.join(' and ')} were both given`)
  if (named.length === 0) return undefined
  if (NO_BODY.has(method)) throw invalid(`a ${method} request takes no body`)
  const key = named[0]
  if (key === 'body') return { body: JSON.stringify(args.body), type: 'application/json' }
  if (key === 'body_text') {
    if (typeof args.body_text !== 'string') throw invalid('body_text must be text')
    return { body: args.body_text, type: 'text/plain; charset=utf-8' }
  }
  const form = args.form
  if (!isObject(form)) throw invalid('form must be a JSON object of fields')
  const params = new URLSearchParams()
  for (const [name, v] of Object.entries(form)) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw invalid(`form ${name} must be text, a number, or true or false`)
    params.append(name, String(v))
  }
  return { body: params.toString(), type: 'application/x-www-form-urlencoded' }
}

export const run: ActionRun = async (ctx, args) => {
  const host = hostOfTarget(ctx)
  const method = methodOf(args)
  const url = requestUrl(args, host)
  const headers = stepHeaders(args)
  const includeHeaders = includeHeadersOf(args)
  const body = bodyOf(args, method)
  if (body !== undefined && !headers.has('content-type')) headers.set('content-type', body.type)
  return httpSend(ctx, { method, url, headers, body: body?.body, writes: true, includeHeaders })
}
