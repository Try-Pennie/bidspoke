import type { ActionContext } from '../../types'

/**
 * TEST ONLY. A Supabase project's REST API (PostgREST) stand in for the
 * catalogue's Supabase tests: the connection bound fetch an action is handed,
 * answering from a queue, and recording every request it was asked to send.
 * Anything thrown from the queue is thrown by fetch, as the connection bound
 * fetch throws a refusal (an expired key, a 429 turned into a requeue) or a timeout.
 */

export interface SentSupabaseRequest {
  readonly method: string
  readonly url: URL
  readonly headers: Headers
  readonly body: unknown
}

export type SupabaseAnswer = Response | { readonly throws: unknown }

export const REF = 'blicjwldjfjubbukxatn'
export const TARGET = { project_url: `https://${REF}.supabase.co` }
export const REST = `https://${REF}.supabase.co/rest/v1`

export interface FakeSupabase {
  readonly ctx: ActionContext
  readonly sent: SentSupabaseRequest[]
  respond(...answers: SupabaseAnswer[]): void
}

export function fakeSupabase(target: unknown = TARGET): FakeSupabase {
  const queue: SupabaseAnswer[] = []
  const sent: SentSupabaseRequest[] = []
  const controller = new AbortController()
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === 'string' ? init.body : null
    sent.push({ method: init?.method ?? 'GET', url: new URL(input), headers: new Headers(init?.headers), body: raw === null ? null : JSON.parse(raw) as unknown })
    const next = queue.shift()
    if (next === undefined) throw new Error(`the fake Supabase has no answer queued for ${input}`)
    if (next instanceof Response) return next
    throw next.throws
  }
  const ctx: ActionContext = {
    fetch,
    signal: controller.signal,
    target: target as ActionContext['target'],
    sleep: () => Promise.reject(new Error('a Supabase action never waits')),
    requestId: '00000000-0000-8000-8000-000000000001',
  }
  return { ctx, sent, respond: (...answers) => queue.push(...answers) }
}

/** PostgREST's answer: JSON rows with the status given, and its Content-Range when given. */
export const rows = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, statusText: STATUS_TEXT[status] ?? '', headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })

/** The reason phrases a real answer carries, which a constructed Response leaves empty. */
const STATUS_TEXT: Readonly<Record<number, string>> = { 200: 'OK', 201: 'Created' }

/** An error as PostgREST sends one. */
export const pgError = (status: number, code: string, message = 'refused') =>
  rows({ code, message, details: null, hint: null }, status)
