import type { ActionContext } from '../../types'

/**
 * TEST ONLY. An Anthropic API stand in for the catalogue's Anthropic tests:
 * the connection bound fetch an action is handed, answering from a queue, and
 * recording every request it was asked to send. Anything thrown from the queue
 * is thrown by fetch, as the connection bound fetch throws a refusal (an
 * expired key, a 429 turned into a requeue) or a timeout.
 */

export interface SentAnthropicRequest {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly body: Record<string, unknown> | null
}

export type AnthropicAnswer = Response | { readonly throws: unknown }

export const TARGET = { workspace_id: 'wrkspc_0PS2337' }

export interface FakeAnthropic {
  readonly ctx: ActionContext
  readonly sent: SentAnthropicRequest[]
  respond(...answers: AnthropicAnswer[]): void
}

export function fakeAnthropic(target: unknown = TARGET): FakeAnthropic {
  const queue: AnthropicAnswer[] = []
  const sent: SentAnthropicRequest[] = []
  const controller = new AbortController()
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : null
    sent.push({ method: init?.method ?? 'GET', url: input, headers: new Headers(init?.headers), body: raw === null ? null : (JSON.parse(raw) as Record<string, unknown>) })
    const next = queue.shift()
    if (next === undefined) throw new Error(`the fake Anthropic has no answer queued for ${input}`)
    if (next instanceof Response) return next
    throw next.throws
  }
  const ctx: ActionContext = {
    fetch,
    signal: controller.signal,
    target: target as ActionContext['target'],
    sleep: () => Promise.reject(new Error('an Anthropic action never waits')),
    requestId: '00000000-0000-8000-8000-000000000001',
  }
  return { ctx, sent, respond: (...answers) => queue.push(...answers) }
}

/** Anthropic's answer: JSON with the status given (200 unless said). */
export const anthropicAnswer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** An error body as Anthropic sends one. */
export const anthropicError = (status: number, type: string, message = 'refused', headers: Record<string, string> = {}) =>
  anthropicAnswer({ type: 'error', error: { type, message }, request_id: 'req_0PS' }, status, headers)

/** A message whose content is the text blocks given, stopped for the reason given. */
export const message = (texts: string[], stopReason: string | null = 'end_turn', over: Record<string, unknown> = {}) =>
  anthropicAnswer({
    id: 'msg_0PS',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5-20250929',
    content: texts.map((text) => ({ type: 'text', text })),
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 5 },
    ...over,
  })
