import type { ActionContext } from '../../types'

/**
 * TEST ONLY. A web API stand in for the catalogue's HTTP tests: the connection
 * bound fetch an action is handed, answering from a queue, and recording every
 * request it was asked to send. Anything thrown from the queue is thrown by
 * fetch, as the connection bound fetch throws a refusal (an expired key, a
 * host outside the declared one, a 429 turned into a requeue) or a timeout.
 */

export interface SentHttpRequest {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly body: string | null
}

export type HttpAnswer = Response | { readonly throws: unknown }

export const HOST = 'api.lender.example'
export const TARGET = { host: `https://${HOST}`, header: 'X-Partner-Key', check_path: '/v1/me' }

export interface FakeHttp {
  readonly ctx: ActionContext
  readonly sent: SentHttpRequest[]
  respond(...answers: HttpAnswer[]): void
}

export function fakeHttp(target: unknown = TARGET): FakeHttp {
  const queue: HttpAnswer[] = []
  const sent: SentHttpRequest[] = []
  const controller = new AbortController()
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    // The HTTP actions send every body as text.
    const body = typeof init?.body === 'string' ? init.body : null
    sent.push({ method: init?.method ?? 'GET', url: input, headers: new Headers(init?.headers), body })
    const next = queue.shift()
    if (next === undefined) throw new Error(`the fake API has no answer queued for ${input}`)
    if (next instanceof Response) return next
    throw next.throws
  }
  const ctx: ActionContext = {
    fetch,
    signal: controller.signal,
    target: target as ActionContext['target'],
    sleep: () => Promise.reject(new Error('an HTTP action never waits')),
    requestId: '00000000-0000-8000-8000-000000000001',
  }
  return { ctx, sent, respond: (...answers) => queue.push(...answers) }
}

/** A JSON answer with the status given (200 unless said). */
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** A text answer. */
export const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } })
