import { ActionFailure } from '../failure'
import type { ActionContext, JsonValue } from '../types'

/**
 * How a catalogue Anthropic action talks to Anthropic (#2337): one JSON
 * request to api.anthropic.com through the step's connection bound fetch,
 * which puts the key (x-api-key) and the declared workspace
 * (anthropic-workspace-id) on it and refuses any other host, so an action never
 * holds either. The action sends the API version itself, as Pipedream's
 * Anthropic app does (PipedreamHQ/pipedream components/anthropic/anthropic.app.mjs
 * `_makeRequest`, at commit b7d67916: https://api.anthropic.com/v1 and
 * anthropic-version 2023-06-01), since the version decides how the request is read.
 *
 * A failure is read once, here:
 *  - what the connection bound fetch throws for a request not yet answered (an
 *    expired or revoked key, a 429 turned into a requeue, a timeout) is passed
 *    on unchanged, for the executor to judge (runtime/failure.ts);
 *  - a refusal is `anthropic_<Anthropic's error type>` (invalid_request_error,
 *    permission_error, not_found_error, request_too_large, rate_limit_error,
 *    with its wait named), or `anthropic_http_<status>` when it names none, not
 *    applied; the message never quotes Anthropic's own, which can quote what
 *    was sent;
 *  - a 529 (overloaded_error) is not applied: Anthropic refused the request
 *    before running the model;
 *  - another 5xx, and a 200 that cannot be read, has its outcome unknown,
 *    since the model may have run.
 */

export const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1'
export const ANTHROPIC_VERSION = '2023-06-01'

export type AnthropicObject = Readonly<Record<string, JsonValue>>

const NAME = /[^a-z0-9_]/g

function isObject(value: unknown): value is AnthropicObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Sends one POST and answers Anthropic's JSON object, or throws the failure by name. */
export async function anthropicPost(ctx: ActionContext, path: string, body: Readonly<Record<string, JsonValue>>): Promise<AnthropicObject> {
  const what = `POST ${path}`
  // Anything the connection bound fetch throws passes through unchanged.
  const response = await ctx.fetch(`${ANTHROPIC_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify(body),
    signal: ctx.signal,
  })

  if (response.ok) {
    let answer: unknown
    try {
      answer = await response.json()
    } catch {
      throw new ActionFailure('anthropic_answer_unreadable', `Anthropic's answer to ${what} was not JSON, so whether the model ran is unknown`, 'unknown')
    }
    if (!isObject(answer)) throw new ActionFailure('anthropic_answer_unreadable', `Anthropic's answer to ${what} was not a JSON object`, 'unknown')
    return answer
  }

  const status = response.status
  let type: string | null = null
  try {
    const parsed: unknown = await response.json()
    const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : null
    if (error !== null && typeof error.type === 'string' && error.type.trim() !== '') type = error.type.toLowerCase().replace(NAME, '_').slice(0, 64)
  } catch {
    // Not JSON: named by its status below.
  }
  const code = `anthropic_${type ?? `http_${status}`}`
  const said = type === null ? `HTTP ${status}` : `HTTP ${status} (${type})`

  if (status === 429) {
    const retryAfter = response.headers.get('retry-after')
    const wait = retryAfter === null ? 'no Retry-After' : `Retry-After ${retryAfter} s`
    throw new ActionFailure(code, `Anthropic rate limited ${what} (${wait}); not run`, 'not_applied')
  }
  if (status === 529) throw new ActionFailure(code, `Anthropic was overloaded and refused ${what}: ${said}; not run`, 'not_applied')
  if (status >= 500) throw new ActionFailure(code, `Anthropic answered ${what} with ${said}`, 'unknown')
  throw new ActionFailure(code, `Anthropic refused ${what}: ${said}`, 'not_applied')
}
