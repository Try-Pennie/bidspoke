/**
 * The one way a schema lookup sends a request and reads its answer (#2335, PR 7
 * of phase 5), so every service fails the same named way: a throw from the
 * injected fetch, a status that is not success and a body that is not the
 * expected shape each become a SchemaLookupError, and nothing a provider said
 * or a thrown error carried rides out on it (F120).
 */
import { parseJson } from '../json'
import { SchemaLookupError, type SchemaStep } from './errors'
import type { SchemaRequestBase, SchemaService } from './types'

export interface RequestContext {
  readonly service: SchemaService
  readonly step: SchemaStep
  readonly subject?: string | null
}

/** The shape of a refusal code: lower case words joined by underscores. */
const REFUSAL_CODE = /^[a-z][a-z0-9_]{0,63}$/

/**
 * The code of a refusal the injected fetch threw. Only connectionFetch's own
 * ConnectionRefusal is read (by its name, so this module imports nothing from
 * ops), and only a code shaped like one; any other error is known by nothing
 * but whether it was a timeout.
 */
function refusalCodeOf(err: unknown): string | null {
  if (!(err instanceof Error) || err.name !== 'ConnectionRefusal') return null
  const code: unknown = Reflect.get(err, 'code')
  return typeof code === 'string' && REFUSAL_CODE.test(code) ? code : null
}

function isTimeout(err: unknown, upstreamCode: string | null): boolean {
  if (upstreamCode === 'connection_timeout') return true
  return err instanceof Error && err.name === 'TimeoutError'
}

export function failedBeforeAnswer(ctx: RequestContext, err: unknown): SchemaLookupError {
  const upstreamCode = refusalCodeOf(err)
  return new SchemaLookupError({
    ...ctx,
    code: isTimeout(err, upstreamCode) ? 'schema_request_timeout' : 'schema_request_failed',
    upstreamCode,
  })
}

/** Sends with the caller's auth on top of the request's own headers. */
export async function send(
  source: SchemaRequestBase,
  ctx: RequestContext,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  try {
    return await source.fetch(url, { ...init, headers: { ...init.headers, ...source.auth } })
  } catch (err) {
    throw failedBeforeAnswer(ctx, err)
  }
}

export function statusFailure(ctx: RequestContext, status: number): SchemaLookupError {
  const code = status === 401 || status === 403
    ? 'schema_auth_refused'
    : status === 404
      ? 'schema_not_found'
      : status === 429
        ? 'schema_rate_limited'
        : 'schema_service_error'
  return new SchemaLookupError({ ...ctx, code, status })
}

/** Refuses any status that is not success. */
export function requireOk(ctx: RequestContext, res: Response): void {
  if (!res.ok) throw statusFailure(ctx, res.status)
}

export function malformed(ctx: RequestContext, status: number | null): SchemaLookupError {
  return new SchemaLookupError({ ...ctx, code: 'schema_response_malformed', status })
}

/** Reads the body as JSON of the shape `is` accepts, or fails as malformed. */
export async function readBody<T>(ctx: RequestContext, res: Response, is: (value: unknown) => value is T): Promise<T> {
  let body: unknown
  try {
    body = await parseJson<unknown>(res)
  } catch {
    // The parser's message can quote the body, so none of it is kept.
    throw malformed(ctx, res.status)
  }
  if (!is(body)) throw malformed(ctx, res.status)
  return body
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An https URL with no userinfo, query or fragment, as a base to append paths to. */
export function isHttpsBase(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
}
