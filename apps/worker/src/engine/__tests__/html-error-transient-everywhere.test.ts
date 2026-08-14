/**
 * An HTML error page means the request died at an edge and was never processed,
 * so it is transient whatever status came with it (#694, extended to every
 * outbound node by #756).
 *
 * #694 established the rule and applied it on the two Salesforce paths, because
 * Salesforce Edge is where it was observed: an HTML 400 was classified
 * `permanent`, `retries_used = 0`, and the lead was dropped to a blip one retry
 * would have absorbed. Every other outbound node still classified by status
 * alone, so the same failure from any partner API dropped a lead the same way.
 *
 * The rule now has ONE home, `classifyHttpErrorWithBody`, and the nodes supply
 * the body text rather than each reimplementing the test (LESSONS L30: fix the
 * class, not the instance).
 *
 * Two things this must NOT do, both asserted below:
 *   - it must not upgrade a genuine JSON 4xx to transient, which would burn
 *     retries on a rejection that can never succeed
 *   - it must not beat a per-partner `response_classification` override, which
 *     is authoritative by design
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  classifyHttpError,
  classifyHttpErrorWithBody,
  classifyStepError,
} from '../error-classifier'
import { PartnerApiError } from '../partner-bid-error'
import { executeIntegrationNode } from '../nodes/integration'
import { resolveBid } from '../bid-resolver'
import { stubFetch, type FetchMock } from '../../__tests__/helpers/fetch-mock'
import type { NodeDefinition, ExecutionContext } from '../../types'
import type { Env } from '../../index'

// A realistic edge error page. Measured shape: a status line plus a request-id
// stamp, which is what support asks for, wrapped in a full document.
const EDGE_HTML_400 = `<!DOCTYPE html><html><head><title>400 Bad Request</title></head>
<body><h1>Bad Request</h1><p>Your request could not be processed.</p>
<p>Request ID: 8f3a-11ee-edge-0042</p></body></html>`

const JSON_400 = JSON.stringify([{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [LastName]' }])

describe('classifyHttpErrorWithBody: the one home of the HTML-page rule (#756)', () => {
  it('classifies an HTML body as transient even on a 400', () => {
    expect(classifyHttpErrorWithBody(400, EDGE_HTML_400)).toBe('transient')
  })

  it('classifies an HTML body as transient on a 401, which status alone calls permanent', () => {
    expect(classifyHttpErrorWithBody(401, EDGE_HTML_400)).toBe('transient')
  })

  it('classifies an HTML body as transient on a 404', () => {
    expect(classifyHttpErrorWithBody(404, EDGE_HTML_400)).toBe('transient')
  })

  it('leaves a genuine JSON 4xx permanent, so retries are not burned on a real rejection', () => {
    expect(classifyHttpErrorWithBody(400, JSON_400)).toBe('permanent')
  })

  it('leaves a plain-text 4xx permanent', () => {
    expect(classifyHttpErrorWithBody(400, 'Bad Request')).toBe('permanent')
  })

  it('falls back to status alone when there is no body', () => {
    expect(classifyHttpErrorWithBody(400, null)).toBe('permanent')
    expect(classifyHttpErrorWithBody(400, undefined)).toBe('permanent')
    expect(classifyHttpErrorWithBody(400, '')).toBe('permanent')
    expect(classifyHttpErrorWithBody(503, null)).toBe('transient')
  })

  it('agrees with classifyHttpError on every status when no body is present', () => {
    // Pins that this is strictly an ADDITION to the status rule, never a change
    // to it. A drift here would silently reclassify every ordinary failure.
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]) {
      expect(classifyHttpErrorWithBody(status, null)).toBe(classifyHttpError(status))
    }
  })

  it('does not treat stray angle brackets in a message as a document', () => {
    // The over-match direction matters (LESSONS L104): the predicate must not
    // catch the content it has to PRESERVE. A JSON rejection quoting a field
    // value with angle brackets stays permanent, which is the realistic case.
    expect(classifyHttpErrorWithBody(400, '{"message":"value must not contain < or >"}')).toBe('permanent')
    expect(classifyHttpErrorWithBody(400, '{"message":"Expected <number>, got string"}')).toBe('permanent')
    expect(classifyHttpErrorWithBody(400, '<?xml version="1.0"?><fault><code>17</code></fault>')).toBe('permanent')
  })

  it('does treat a literal <html tag as a page, an accepted over-match inherited from #695', () => {
    // Recorded rather than hidden. The shared predicate keys on `<!doctype html`
    // or `<html`, so a partner error string that literally quotes `<html` is
    // classified transient. Deliberately not tightened here: the real Salesforce
    // page serves `<!doctypehtml>` with no space and this predicate also drives
    // the #695 message summarizer, so narrowing it is a change to that behaviour
    // rather than to this one. The cost of the over-match is wasted retries on an
    // unlikely message, not a wrong answer.
    expect(classifyHttpErrorWithBody(400, '{"message":"expected <html> in template"}')).toBe('transient')
  })
})

describe('classifyStepError routes a thrown Response through the body rule (#756)', () => {
  function responseErr(status: number, bodyText?: string): Response {
    const r = new Response(bodyText ?? null, { status })
    if (bodyText !== undefined) {
      ;(r as Response & { bodyText?: string }).bodyText = bodyText
    }
    return r
  }

  it('classifies a thrown Response carrying an HTML body as transient', () => {
    expect(classifyStepError(responseErr(400, EDGE_HTML_400))).toBe('transient')
  })

  it('classifies a thrown Response carrying a JSON body as permanent', () => {
    expect(classifyStepError(responseErr(400, JSON_400))).toBe('permanent')
  })

  it('still classifies a Response with no attached body by status alone', () => {
    // Back-compat: any thrower that does not attach the text keeps the old
    // behaviour rather than silently becoming transient.
    expect(classifyStepError(responseErr(400))).toBe('permanent')
    expect(classifyStepError(responseErr(503))).toBe('transient')
  })

  it('lets a per-partner override win over the HTML rule', () => {
    // response_classification is authoritative by design. A partner that has
    // declared an HTML-bearing status permanent must not be overruled here.
    const err = new PartnerApiError('Partner API returned 400 (classified as permanent by override)', 'permanent', false)
    ;(err as PartnerApiError & { bodyText?: string }).bodyText = EDGE_HTML_400
    expect(classifyStepError(err)).toBe('permanent')
  })
})

describe('integration node: an HTML error page is transient (#756)', () => {
  let fetchMock: FetchMock

  function makeNode(config: Record<string, unknown>): NodeDefinition {
    return { id: 'int_1', namespace: 'call_partner', type: 'webhook', config }
  }

  function makeCtx(): ExecutionContext {
    return {
      trigger: { payload: { ssn: '123-45-6789' }, source: 'test', workflow_id: 'wf-1', org_id: '', trace_id: 'tr-1' },
      steps: {},
      env: {},
    } as unknown as ExecutionContext
  }

  const env = {} as unknown as Env

  beforeEach(() => { fetchMock = stubFetch() })
  afterEach(() => { vi.restoreAllMocks() })

  function fakeResponse(status: number, body: string) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
      headers: new Headers({ 'content-type': status >= 400 ? 'text/html' : 'application/json' }),
    }
  }

  async function callAndCatch(status: number, body: string): Promise<unknown> {
    fetchMock.mockResolvedValue(fakeResponse(status, body))
    try {
      await executeIntegrationNode(
        makeNode({ url: 'https://partner.test/bid', method: 'POST', body: { a: 1 } }),
        makeCtx(),
        env,
      )
    } catch (e) {
      return e
    }
    throw new Error('expected the node to throw on a non-2xx response')
  }

  it('makes an HTML 400 from a partner API transient, so the lead is retried not dropped', async () => {
    const err = await callAndCatch(400, EDGE_HTML_400)
    expect(classifyStepError(err)).toBe('transient')
  })

  it('keeps a JSON 400 from a partner API permanent', async () => {
    const err = await callAndCatch(400, JSON_400)
    expect(classifyStepError(err)).toBe('permanent')
  })

  it('logs html_error_page_transient so the frequency stays measurable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await callAndCatch(400, EDGE_HTML_400)
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('event=html_error_page_transient'))).toBe(true)
    expect(lines.some((l) => l.includes('status=400'))).toBe(true)
  })

  it('does not log the event for an ordinary JSON error', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await callAndCatch(400, JSON_400)
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('event=html_error_page_transient'))).toBe(false)
  })
})

describe('partner bid API: an HTML error page is transient (#756)', () => {
  let fetchMock: FetchMock

  beforeEach(() => { fetchMock = stubFetch() })
  afterEach(() => { vi.restoreAllMocks() })

  function fakeResponse(status: number, body: string) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(JSON.parse(body)),
      text: () => Promise.resolve(body),
      headers: new Headers({ 'content-type': status >= 400 ? 'text/html' : 'application/json' }),
    }
  }

  function makeCtx(): ExecutionContext {
    return {
      trigger: { payload: { credit_score: 700 }, source: 'test', workflow_id: 'wf-1', org_id: '', trace_id: 'tr-1' },
      steps: {},
      env: {},
    } as unknown as ExecutionContext
  }

  const env = {} as unknown as Env

  const partner = (overrides: Record<string, unknown> = {}) => ({
    slug: 'testpartner',
    bid_resolver_type: 'api',
    api_endpoint: 'https://partner.test/bid',
    api_method: 'POST',
    response_classification: null,
    alert_config: null,
    ...overrides,
  }) as unknown as Parameters<typeof resolveBid>[0]

  async function catchResolve(p: Parameters<typeof resolveBid>[0]): Promise<Record<string, unknown>> {
    try {
      await resolveBid(p, makeCtx(), env)
    } catch (e) {
      return e as unknown as Record<string, unknown>
    }
    throw new Error('expected resolveBid to throw on a non-ok partner response')
  }

  /**
   * partner-bid.ts classifies from the `status` and `bodyText` the resolver
   * attaches to the thrown error, NOT through classifyStepError. A plain Error
   * falls to the transport default there and reads transient either way, so an
   * HTML assertion routed through classifyStepError would pass for the wrong
   * reason. These assert the data contract the node actually consumes.
   */
  function classifyAsNodeDoes(err: Record<string, unknown>): string | null {
    if (err instanceof PartnerApiError) return err.errorType
    return classifyHttpErrorWithBody(err.status as number, err.bodyText as string | undefined)
  }

  it('attaches the response body text to the thrown error, which is what the node classifies from', async () => {
    fetchMock.mockResolvedValue(fakeResponse(400, EDGE_HTML_400))
    const err = await catchResolve(partner())
    expect(err.status).toBe(400)
    expect(err.bodyText).toBe(EDGE_HTML_400)
  })

  it('makes an HTML 400 from a partner bid API transient, so the bid attempt is retried', async () => {
    fetchMock.mockResolvedValue(fakeResponse(400, EDGE_HTML_400))
    expect(classifyAsNodeDoes(await catchResolve(partner()))).toBe('transient')
  })

  it('keeps a JSON 400 from a partner bid API permanent', async () => {
    fetchMock.mockResolvedValue(fakeResponse(400, JSON_400))
    expect(classifyAsNodeDoes(await catchResolve(partner()))).toBe('permanent')
  })

  it('still parses a JSON body normally, so capturing the text changes nothing else', async () => {
    // The resolver read the body with parseJsonSafe. Reading text first and
    // parsing it must leave the successful path exactly as it was.
    fetchMock.mockResolvedValue(fakeResponse(200, '{"bid":4200}'))
    const out = await resolveBid(partner(), makeCtx(), env)
    expect(out.raw).toEqual({ bid: 4200 })
  })

  it('still lets a response_classification override declare an HTML status permanent', async () => {
    // The override is authoritative by design and must outrank the body rule,
    // otherwise a partner that deliberately declared a status permanent is
    // retried anyway.
    fetchMock.mockResolvedValue(fakeResponse(400, EDGE_HTML_400))
    const err = await catchResolve(partner({
      response_classification: { permanent_signals: [{ status_code: 400 }] },
    }))
    expect(classifyAsNodeDoes(err)).toBe('permanent')
  })

  it('logs html_error_page_transient with the partner slug', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    fetchMock.mockResolvedValue(fakeResponse(400, EDGE_HTML_400))
    await catchResolve(partner())
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('event=html_error_page_transient') && l.includes('testpartner'))).toBe(true)
  })
})
