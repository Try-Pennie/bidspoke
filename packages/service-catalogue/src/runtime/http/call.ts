import { httpHostOf } from '../../schema/http-host'
import { ActionFailure } from '../failure'
import type { ActionArgs, ActionContext, JsonValue } from '../types'

/**
 * How a catalogue HTTP action talks to a web API (#2337): one request to the
 * connection's declared host through the step's connection bound fetch, which
 * puts the key in the connection's declared header and refuses any other host,
 * so an action never holds the key. Request building follows what Pipedream's
 * HTTP request offered (a method, a URL, query parameters, headers and a body;
 * PipedreamHQ/pipedream components/http, at commit b7d67916), re-implemented.
 *
 * The host is the target's, read by the one host rule (schema/http-host.ts),
 * so a step's URL is a path on it or a whole address on it; any other host is
 * refused here before anything is sent (`http_host_not_declared`), and
 * connectionFetch refuses it again if it got that far.
 *
 * A failure is read once, here:
 *  - what the connection bound fetch throws for a request not yet answered (a
 *    refused or revoked key after its one renewal, a 429 turned into a
 *    requeue, a timeout, a host it refuses) passes on unchanged, for the
 *    executor to judge (runtime/failure.ts);
 *  - an answer that is not 2xx is `http_<status>`, its body never read into
 *    the message, which could quote what was sent. A 4xx (a 403 for a key the
 *    API forbids, a 429 that reached the action, its wait named) is not
 *    applied. A 5xx, and a 3xx, which is never followed since it would leave
 *    the declared host, are unknown for a write (a 303 answers a write that
 *    ran) and not applied for a read;
 *  - a 2xx whose body cannot be read, is larger than HTTP_MAX_ANSWER_BYTES, or
 *    says it is JSON and is not, was applied for a write and not for a read.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

/** The largest answer an action returns: it becomes the step's output, which a run stores. */
export const HTTP_MAX_ANSWER_BYTES = 5 * 1024 * 1024

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
// eslint-disable-next-line no-control-regex
const HEADER_VALUE_FORBIDDEN = /[\r\n\u0000]/

export const invalid = (message: string) => new ActionFailure('http_argument_invalid', message, 'not_applied')

function isObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The connection's declared host, or a refusal by name: a target the host rule refuses sends nothing. */
export function hostOfTarget(ctx: ActionContext): string {
  const declared = isObject(ctx.target) ? ctx.target.host : undefined
  const host = httpHostOf(declared)
  if (!host.ok) throw new ActionFailure('http_target_invalid', 'the connection declares no host an HTTP step may reach', 'not_applied')
  return host.host
}

/** The step's URL on the declared host, with its query parameters added. */
export function requestUrl(args: ActionArgs, host: string): URL {
  const raw = args.url
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) throw new ActionFailure('http_url_missing', 'the step names no URL', 'not_applied')
  if (typeof raw !== 'string') throw invalid('url must be text')
  const value = raw.trim()
  let url: URL
  if (value.startsWith('/') && !value.startsWith('//')) {
    url = new URL(`https://${host}${value}`)
  } else if (/^https:\/\//i.test(value)) {
    try {
      url = new URL(value)
    } catch {
      throw invalid('url is not an address')
    }
  } else {
    throw invalid('url must be a path starting with / or a whole https address')
  }
  if (url.hostname.toLowerCase() !== host || url.port !== '' || url.username !== '' || url.password !== '') {
    throw new ActionFailure('http_host_not_declared', 'the step\'s URL is not on the host its connection declares, so nothing was sent', 'not_applied')
  }
  const query = args.query
  if (query !== undefined && query !== null) {
    if (!isObject(query)) throw invalid('query must be a JSON object of parameters')
    for (const [name, v] of Object.entries(query)) {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw invalid(`query ${name} must be text, a number, or true or false`)
      url.searchParams.append(name, String(v))
    }
  }
  return url
}

/** The step's headers, each name a header name and each value one line of text. */
export function stepHeaders(args: ActionArgs): Headers {
  const headers = new Headers()
  const given = args.headers
  if (given === undefined || given === null) return headers
  if (!isObject(given)) throw invalid('headers must be a JSON object of header names to text')
  for (const [name, value] of Object.entries(given)) {
    if (!HEADER_NAME.test(name)) throw invalid('a header name holds a character a header name cannot')
    if (typeof value !== 'string') throw invalid(`header ${name} must be text`)
    if (HEADER_VALUE_FORBIDDEN.test(value)) throw invalid(`header ${name} must be one line`)
    headers.set(name, value)
  }
  return headers
}

export function includeHeadersOf(args: ActionArgs): boolean {
  const value = args.include_headers
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw invalid('include_headers must be true or false')
  return value
}

export interface HttpRequest {
  readonly method: HttpMethod
  readonly url: URL
  readonly headers: Headers
  readonly body?: string
  /** Whether the request may change something, which decides an uncertain outcome. */
  readonly writes: boolean
  readonly includeHeaders: boolean
}

function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined)
}

const isJsonType = (contentType: string | null) => contentType !== null && /^[^;]*\bjson\b/i.test(contentType)

/** Sends one request and answers its data (or status, headers and data), or throws the failure by name. */
export async function httpSend(ctx: ActionContext, request: HttpRequest): Promise<JsonValue> {
  const what = `${request.method} ${request.url.pathname}`
  const uncertain = request.writes ? 'unknown' : 'not_applied'
  const answered = request.writes ? 'applied' : 'not_applied'
  const init: RequestInit = { method: request.method, headers: request.headers, signal: ctx.signal }
  if (request.body !== undefined) init.body = request.body
  // Anything the connection bound fetch throws passes through unchanged.
  const response = await ctx.fetch(request.url.toString(), init)
  const status = response.status

  if (status < 200 || status >= 300) {
    discard(response)
    const code = `http_${status}`
    if (status === 429) {
      const retryAfter = response.headers.get('retry-after')
      const wait = retryAfter === null ? 'no Retry-After' : `Retry-After ${retryAfter} s`
      throw new ActionFailure(code, `the API rate limited ${what} (${wait}); not sent`, 'not_applied')
    }
    if (status >= 300 && status < 400) throw new ActionFailure(code, `the API redirected ${what} with HTTP ${status}, which is not followed`, uncertain)
    if (status >= 500) throw new ActionFailure(code, `the API answered ${what} with HTTP ${status}`, uncertain)
    throw new ActionFailure(code, `the API refused ${what} with HTTP ${status}`, 'not_applied')
  }

  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > HTTP_MAX_ANSWER_BYTES) {
    discard(response)
    throw new ActionFailure('http_answer_too_large', `the answer to ${what} is over ${HTTP_MAX_ANSWER_BYTES} bytes, more than a step returns`, answered)
  }
  let body: string
  try {
    body = await response.text()
  } catch {
    throw new ActionFailure('http_answer_unreadable', `the answer to ${what} could not be read`, answered)
  }
  if (new TextEncoder().encode(body).byteLength > HTTP_MAX_ANSWER_BYTES) {
    throw new ActionFailure('http_answer_too_large', `the answer to ${what} is over ${HTTP_MAX_ANSWER_BYTES} bytes, more than a step returns`, answered)
  }
  let data: JsonValue = body
  if (body !== '' && isJsonType(response.headers.get('content-type'))) {
    try {
      data = JSON.parse(body) as JsonValue
    } catch {
      throw new ActionFailure('http_answer_not_json', `the answer to ${what} says it is JSON and is not`, answered)
    }
  }
  if (!request.includeHeaders) return data
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value
  })
  return { status, headers, data }
}
