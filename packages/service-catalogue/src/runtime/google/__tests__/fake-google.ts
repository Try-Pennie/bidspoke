import type { ActionContext } from '../../types'

/**
 * TEST ONLY. Google's REST APIs standing in for the catalogue's Google tests:
 * the connection bound fetch an action is handed, answering from a queue, and
 * recording every request it was asked to send. Anything thrown from the queue
 * is thrown by fetch, as the connection bound fetch throws a refusal (an expired
 * login, a mailbox taken off the list, a 429 turned into a requeue) or a timeout.
 */

export interface SentGoogleRequest {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly json: unknown
}

export type GoogleAnswer = Response | { readonly throws: unknown }

export const MAILBOX = 'ops@trypennie.com'
export const TARGET = { subject: MAILBOX, drives: ['0AReportsDrive'] }
export const SHEET = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

export interface FakeGoogle {
  readonly ctx: ActionContext
  readonly sent: SentGoogleRequest[]
  respond(...answers: GoogleAnswer[]): void
}

export function fakeGoogle(target: unknown = TARGET): FakeGoogle {
  const queue: GoogleAnswer[] = []
  const sent: SentGoogleRequest[] = []
  const controller = new AbortController()
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const text = typeof init?.body === 'string' ? init.body : null
    sent.push({ method: init?.method ?? 'GET', url: input, headers: new Headers(init?.headers), json: text === null ? null : JSON.parse(text) })
    const next = queue.shift()
    if (next === undefined) throw new Error(`the fake Google has no answer queued for ${init?.method ?? 'GET'} ${input}`)
    if (next instanceof Response) return next
    throw next.throws
  }
  const ctx: ActionContext = {
    fetch,
    signal: controller.signal,
    target: target as ActionContext['target'],
    sleep: () => Promise.reject(new Error('a Google action never waits')),
    requestId: '00000000-0000-8000-8000-000000000001',
  }
  return { ctx, sent, respond: (...answers) => queue.push(...answers) }
}

export const gAnswer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** An error as Google's APIs send one. */
export const gError = (status: number, googleStatus: string, reason: string, message = 'refused', headers: Record<string, string> = {}) =>
  gAnswer({ error: { code: status, message, status: googleStatus, errors: [{ reason, message, domain: 'global' }] } }, status, headers)

/** A spreadsheet's worksheets, as spreadsheets.get answers with fields=sheets.properties. */
export const worksheets = (...sheets: Array<[number, string]>) =>
  gAnswer({ sheets: sheets.map(([sheetId, title]) => ({ properties: { sheetId, title } })) })
