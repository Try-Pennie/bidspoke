import type { ActionContext } from '../../types'

/**
 * TEST ONLY. A Slack Web API stand in for the catalogue's Slack tests: the
 * connection bound fetch an action is handed, answering from a queue, and
 * recording every request it was asked to send. Anything thrown from the
 * queue is thrown by fetch, as the connection bound fetch throws a refusal (an
 * expired login, a 429 turned into a requeue) or a timeout.
 */

export interface SentSlackRequest {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly form: Record<string, string>
}

export type SlackAnswer = Response | { readonly throws: unknown }

export const TARGET = { team_id: 'T0OPS2337' }

export interface FakeSlack {
  readonly ctx: ActionContext
  readonly sent: SentSlackRequest[]
  respond(...answers: SlackAnswer[]): void
}

export function fakeSlack(target: unknown = TARGET): FakeSlack {
  const queue: SlackAnswer[] = []
  const sent: SentSlackRequest[] = []
  const controller = new AbortController()
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : ''
    sent.push({ method: init?.method ?? 'GET', url: input, headers: new Headers(init?.headers), form: Object.fromEntries(new URLSearchParams(raw)) })
    const next = queue.shift()
    if (next === undefined) throw new Error(`the fake Slack has no answer queued for ${input}`)
    if (next instanceof Response) return next
    throw next.throws
  }
  const ctx: ActionContext = {
    fetch,
    signal: controller.signal,
    target: target as ActionContext['target'],
    sleep: () => Promise.reject(new Error('a Slack action never waits')),
    requestId: '00000000-0000-8000-8000-000000000001',
  }
  return { ctx, sent, respond: (...answers) => queue.push(...answers) }
}

/** Slack's answer: JSON with the status given (200 unless said). */
export const slackAnswer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** chat.postMessage's answer for a delivered message. */
export const posted = (channel = 'C0OPS1', ts = '1729600000.000100') =>
  slackAnswer({ ok: true, channel, ts, message: { type: 'message', text: 'hello', ts, bot_id: 'B0OPS' } })
