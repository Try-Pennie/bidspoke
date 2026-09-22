/**
 * postToPartner (#1411): the one outbound POST to a partner, shared by the bid
 * resolver's API call and the buyer_select node's sale attempt, so the
 * credential rule, the trace header and the body handling live once (L613).
 *
 * The credential rule is #411 and #417: a partner configured to require a
 * credential whose value is unset or blank is OUR fault, so it is a permanent
 * config error the call never makes and the circuit breaker never counts. The
 * body is read once as text and parsed beside it, because the text is what the
 * HTML error page rule needs (#756): an HTML document means an edge answered,
 * not the partner. The fetch is injectable so a test needs no network.
 */
import type { Env } from '../index'
import { PartnerApiError } from '../engine/partner-bid-error'
import { partnerCredentialValue } from './partner-credential'
import { containsHtmlDocument } from './html-error-summary'
import { linkAbort } from '../engine/retry'

export interface PartnerCallTarget {
  slug: string
  api_endpoint: string | null
  cf_secret_key: string | null
}

export interface PartnerCallOptions {
  traceId: string
  /** The whole call, connect to last byte. */
  timeoutMs: number
  /** The step's own signal, so a step timeout cancels the request too (#66). */
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface PartnerCallResult {
  status: number
  text: string
  /** The body parsed as JSON, or null when it is not JSON. */
  json: unknown
  /** The body is an HTML document: something in front of the partner answered. */
  isHtml: boolean
  headers: Record<string, string>
}

export function partnerRequestHeaders(target: PartnerCallTarget, env: Env, traceId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Trace-Id': traceId,
  }
  if (target.cf_secret_key) {
    const secretValue = partnerCredentialValue(env, target.cf_secret_key)
    if (!secretValue) {
      throw new PartnerApiError(
        `Partner ${target.slug} requires credential '${target.cf_secret_key}' but it is missing or blank`,
        'permanent',
        false,
        true
      )
    }
    headers['Authorization'] = `Bearer ${secretValue}`
  }
  return headers
}

const HEADER_DENYLIST = new Set(['set-cookie', 'authorization'])

export async function postToPartner(target: PartnerCallTarget, body: unknown, env: Env, opts: PartnerCallOptions): Promise<PartnerCallResult> {
  if (!target.api_endpoint) {
    throw new PartnerApiError(`Partner ${target.slug} has no api_endpoint configured`, 'permanent', false, true)
  }
  const headers = partnerRequestHeaders(target, env, opts.traceId)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs)
  linkAbort(controller, opts.signal)
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(target.api_endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
  const text = await res.text().catch(() => '')
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  const responseHeaders: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    if (!HEADER_DENYLIST.has(key.toLowerCase())) responseHeaders[key.toLowerCase()] = value
  })
  return { status: res.status, text, json, isHtml: containsHtmlDocument(text), headers: responseHeaders }
}
