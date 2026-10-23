import type { ActionContext } from '../../types'

/**
 * TEST ONLY. An OpenAI API stand in for the catalogue's OpenAI tests: the
 * connection bound fetch an action is handed, answering from a queue, and
 * recording every request it was asked to send. Anything thrown from the queue
 * is thrown by fetch, as the connection bound fetch throws a refusal (an
 * expired key, a 429 turned into a requeue) or a timeout.
 */

export interface SentOpenAIRequest {
  readonly method: string
  readonly url: string
  readonly headers: Headers
  readonly body: Record<string, unknown> | null
}

export type OpenAIAnswer = Response | { readonly throws: unknown }

export const TARGET = { project_id: 'proj_0PS2337' }

export interface FakeOpenAI {
  readonly ctx: ActionContext
  readonly sent: SentOpenAIRequest[]
  respond(...answers: OpenAIAnswer[]): void
}

export function fakeOpenAI(target: unknown = TARGET): FakeOpenAI {
  const queue: OpenAIAnswer[] = []
  const sent: SentOpenAIRequest[] = []
  const controller = new AbortController()
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : null
    sent.push({ method: init?.method ?? 'GET', url: input, headers: new Headers(init?.headers), body: raw === null ? null : (JSON.parse(raw) as Record<string, unknown>) })
    const next = queue.shift()
    if (next === undefined) throw new Error(`the fake OpenAI has no answer queued for ${input}`)
    if (next instanceof Response) return next
    throw next.throws
  }
  const ctx: ActionContext = {
    fetch,
    signal: controller.signal,
    target: target as ActionContext['target'],
    sleep: () => Promise.reject(new Error('an OpenAI action never waits')),
  }
  return { ctx, sent, respond: (...answers) => queue.push(...answers) }
}

/** OpenAI's answer: JSON with the status given (200 unless said). */
export const openaiAnswer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** An error body as OpenAI sends one. */
export const openaiError = (status: number, type: string, code: string | null, message = 'refused', headers: Record<string, string> = {}) =>
  openaiAnswer({ error: { message, type, param: null, code } }, status, headers)

/** A chat completion with one choice. */
export const completion = (content: string | null, finishReason: string | null = 'stop', message: Record<string, unknown> = {}) =>
  openaiAnswer({
    id: 'chatcmpl-0PS',
    object: 'chat.completion',
    created: 1761140000,
    model: 'gpt-4o-mini-2024-07-18',
    choices: [{ index: 0, message: { role: 'assistant', content, refusal: null, ...message }, finish_reason: finishReason }],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  })

/** A response from the Responses API: one message whose text is `text`. */
export const responseOf = (text: string, over: Record<string, unknown> = {}, part: Record<string, unknown> = {}) =>
  openaiAnswer({
    id: 'resp_0PS',
    object: 'response',
    created_at: 1761140000,
    status: 'completed',
    model: 'gpt-4o-mini-2024-07-18',
    incomplete_details: null,
    error: null,
    output: [{ id: 'msg_0PS', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [], ...part }] }],
    usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    ...over,
  })
