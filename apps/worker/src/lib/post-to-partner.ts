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
 *
 * The call's own timer marks the abort it causes as BUYER_CALL_DEADLINE
 * (#3075), never by its text, so the row it cut short (a buyer select
 * attempt's, or since #3079 the buyer_click_send node's) can say our deadline
 * stopped it. The error thrown is the platform's abort,
 * unchanged, so every caller's handling of it is what it was. Since #3089 the
 * timer runs until the body is read, so a body it cuts off throws the same way.
 *
 * A fetch that throws for any other reason is marked too (#3080), with what
 * this function saw happen: the call was cancelled (our signal was aborted
 * from elsewhere, or the platform's abort arrived anyway), or the fetch itself
 * failed with nothing aborted, which is the connection. noAnswerOf reads all
 * three back, so the buyer select attempt can say no answer arrived and why,
 * rather than that the buyer answered. Nothing reads the error's message.
 */
import type { Env } from '../index'
import { PartnerApiError } from '../engine/partner-bid-error'
import { partnerCredentialValue } from './partner-credential'
import { containsHtmlDocument } from './html-error-summary'
import { linkAbort } from '../engine/retry'
import { abortAfter, stepTimeoutMarkerOf, BUYER_CALL_DEADLINE } from '../engine/step-timeout'

/**
 * Why a partner call that threw got no answer, where the call knows it (#3080).
 * `our_timer`: the call's own timer stopped it, after `after_ms` (null when the
 * length is not one a step row can hold). `cancelled`: it was aborted, not by
 * that timer. `connection`: the fetch failed with nothing aborted.
 */
export type NoAnswer =
  | { cause: 'our_timer'; after_ms: number | null }
  | { cause: 'connection' }
  | { cause: 'cancelled' }

/** The causes postToPartner marks itself; our timer is marked by its own timer (step-timeout.ts). */
type MarkedCause = 'connection' | 'cancelled'

/** Kept beside the error, as the deadline marks are, so the error itself is exactly what was thrown. */
const NO_ANSWER_MARKS = new WeakMap<object, MarkedCause>()

/** Records why a call that threw `err` got no answer. Returns `err` unchanged; a value that is not an object is left unmarked. */
export function markNoAnswer<T>(err: T, cause: MarkedCause): T {
  if (typeof err === 'object' && err !== null) NO_ANSWER_MARKS.set(err, cause)
  return err
}

/**
 * Why a call that threw `err` got no answer, read from the marks alone, never
 * the text: null when postToPartner did not see it happen, so a caller says
 * only that no answer arrived.
 */
export function noAnswerOf(err: unknown): NoAnswer | null {
  const deadline = stepTimeoutMarkerOf(err)
  if (deadline?.timeout_kind === BUYER_CALL_DEADLINE) return { cause: 'our_timer', after_ms: deadline.timed_out_after_ms }
  if (typeof err !== 'object' || err === null) return null
  const cause = NO_ANSWER_MARKS.get(err)
  return cause ? { cause } : null
}

/** The platform's abort, by its type and the name the platform gives every abort, never its message. */
function isPlatformAbort(err: unknown): boolean {
  return typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError'
}

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
  // Written before the call starts, so a body that cannot be written is never
  // taken for a failure of the call (#3080). The same string is sent.
  const payload = JSON.stringify(body)
  const controller = new AbortController()
  // Knows whether it was the one that aborted the call, so only its own abort is
  // marked as the buyer call's deadline; one from the step's signal is not (#3075).
  const timer = abortAfter(controller, opts.timeoutMs, BUYER_CALL_DEADLINE)
  linkAbort(controller, opts.signal)
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(target.api_endpoint, { method: 'POST', headers, body: payload, signal: controller.signal })
  } catch (err) {
    timer.clear()
    // Why no answer arrived (#3080): our timer marks its own abort below; any
    // other abort was a cancel; a fetch that failed with nothing aborted is the connection.
    if (!timer.fired()) markNoAnswer(err, controller.signal.aborted || isPlatformAbort(err) ? 'cancelled' : 'connection')
    throw timer.mark(err)
  }
  // The timer runs on through the body (#3089), so its limit is the whole
  // answer, connect to last byte: headers followed by a trickling body end at
  // it too. A body our timer cut off is no complete answer, since the rules
  // judge the body, so the call throws as a timeout before the headers does,
  // marked buyer_call, and every caller handles it exactly as that. A body read
  // that ends any other way leaves the text empty, as it always has.
  let text: string
  try {
    text = await readText(res, controller.signal)
  } catch (err) {
    if (timer.fired()) throw timer.mark(err)
    text = ''
  } finally {
    timer.clear()
  }
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

/**
 * The body as text, ending the moment `signal` aborts (#3089). The platform's
 * fetch errors the body when its signal aborts, but the wait must not depend on
 * that: a body that went on arriving would hold the call past its own limit.
 * Rejects with the signal's abort, which the caller marks when its timer caused it.
 */
function readText(res: Response, signal: AbortSignal): Promise<string> {
  const abortOf = (): Error => (signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'))
  if (signal.aborted) return Promise.reject(abortOf())
  let onAbort: () => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortOf())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([res.text(), aborted]).finally(() => signal.removeEventListener('abort', onAbort))
}
