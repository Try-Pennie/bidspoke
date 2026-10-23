import type { ActionContext } from '../../types'

/**
 * TEST ONLY. A Salesforce REST API stand in for the catalogue's Salesforce
 * tests: the connection bound fetch an action is handed, answering from a
 * queue, and recording every request it was asked to send. Anything thrown
 * from the queue is thrown by fetch, as the connection bound fetch throws a
 * refusal (an expired login, a 429 turned into a requeue) or a timeout.
 */

export interface SentSalesforceRequest {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly text: string | null
  readonly json: unknown
}

export type SalesforceAnswer = Response | { readonly throws: unknown }

export const HOST = 'trypennie.my.salesforce.com'
export const TARGET = { instance_url: `https://${HOST}`, client_id: 'ops-app-client' }
export const DATA = `https://${HOST}/services/data/v60.0`

export interface FakeSalesforce {
  readonly ctx: ActionContext
  readonly sent: SentSalesforceRequest[]
  respond(...answers: SalesforceAnswer[]): void
}

export function fakeSalesforce(target: unknown = TARGET): FakeSalesforce {
  const queue: SalesforceAnswer[] = []
  const sent: SentSalesforceRequest[] = []
  const controller = new AbortController()
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const text = typeof init?.body === 'string' ? init.body : null
    let json: unknown
    try {
      json = text === null ? null : JSON.parse(text)
    } catch {
      json = null
    }
    sent.push({ method: init?.method ?? 'GET', url: input, headers: new Headers(init?.headers), text, json })
    const next = queue.shift()
    if (next === undefined) throw new Error(`the fake Salesforce has no answer queued for ${init?.method ?? 'GET'} ${input}`)
    if (next instanceof Response) return next
    throw next.throws
  }
  const ctx: ActionContext = {
    fetch,
    signal: controller.signal,
    target: target as ActionContext['target'],
    sleep: () => Promise.reject(new Error('a Salesforce action never waits')),
  }
  return { ctx, sent, respond: (...answers) => queue.push(...answers) }
}

/** Salesforce's answer: JSON with the status given (200 unless said). */
export const sfAnswer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** An error body as the REST API sends one: a list of { errorCode, message, fields }. */
export const sfError = (status: number, errorCode: string, message = 'refused', fields: string[] = [], headers: Record<string, string> = {}) =>
  sfAnswer([{ errorCode, message, fields }], status, headers)

/** A 204 No Content, as an update answers. */
export const noContent = () => new Response(null, { status: 204 })

/** A CSV answer, as a bulk job's results are. */
export const csvAnswer = (text: string, status = 200) => new Response(text, { status, headers: { 'content-type': 'text/csv' } })

/** The Salesforce Edge error page, as it answers a request that died at the edge (#694). */
export const edgePage = (status = 400) => new Response('<!doctypehtml><html><body>Salesforce Edge error, Sam Lee</body></html>', { status })

/** A query page. */
export const queryPage = (records: unknown[], over: Record<string, unknown> = {}) =>
  sfAnswer({ totalSize: records.length, done: true, records, ...over })
