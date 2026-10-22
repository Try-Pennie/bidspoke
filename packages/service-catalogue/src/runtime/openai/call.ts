import { ActionFailure } from '../failure'
import type { ActionArgs, ActionContext, JsonValue } from '../types'

/**
 * How a catalogue OpenAI action talks to OpenAI (#2337): one JSON request to
 * api.openai.com through the step's connection bound fetch, which puts the
 * key (Authorization) and the declared project (OpenAI-Project) on it and
 * refuses any other host, so an action never holds either.
 *
 * Request building follows Pipedream's OpenAI app (PipedreamHQ/pipedream
 * components/openai/openai.app.mjs `_makeRequest`, at commit b7d67916: the
 * base https://api.openai.com/v1 and a JSON body), re-implemented, not copied.
 *
 * A failure is read once, here, for every OpenAI action:
 *  - what the connection bound fetch throws for a request not yet answered (an
 *    expired or revoked key, a 429 turned into a requeue, a timeout) is passed
 *    on unchanged, for the executor to judge (runtime/failure.ts);
 *  - a 404 is `openai_not_found`; a 429 that reaches the action is
 *    `openai_rate_limited`, its wait named, or `openai_insufficient_quota`
 *    when the account has no credit left, which no wait clears; both not applied;
 *  - another refusal is `openai_<OpenAI's error code>`, or its error type
 *    when it names no code, or `openai_http_<status>` when it names neither,
 *    not applied. The message names the type and code only, never OpenAI's
 *    own message, which can quote what was sent;
 *  - a 5xx is `openai_http_<status>`, and a 200 that cannot be read is
 *    `openai_answer_unreadable`: outcome unknown for a write, since OpenAI may
 *    have acted before it failed, not applied for a read.
 */

export const OPENAI_API_BASE = 'https://api.openai.com/v1'

export interface OpenAIRequest {
  readonly method: 'GET' | 'POST'
  /** The path under /v1, starting with a slash, its query included. */
  readonly path: string
  readonly body?: Readonly<Record<string, JsonValue>>
  /** Whether the request writes (or runs a billed model call), which decides an uncertain outcome. */
  readonly writes: boolean
}

export type OpenAIObject = Readonly<Record<string, JsonValue>>

const NAME = /[^a-z0-9_]/g
const nameOf = (value: string) => value.toLowerCase().replace(NAME, '_').slice(0, 64)

function isObject(value: unknown): value is OpenAIObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Sends one request and answers OpenAI's JSON object, or throws the failure by name. */
export async function openaiRequest(ctx: ActionContext, request: OpenAIRequest): Promise<OpenAIObject> {
  const what = `${request.method} ${request.path.split('?')[0]}`
  const uncertain = request.writes ? 'unknown' : 'not_applied'
  const init: RequestInit = { method: request.method, signal: ctx.signal }
  if (request.body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(request.body)
  }
  // Anything the connection bound fetch throws passes through unchanged.
  const response = await ctx.fetch(`${OPENAI_API_BASE}${request.path}`, init)

  if (response.ok) {
    let answer: unknown
    try {
      answer = await response.json()
    } catch {
      throw new ActionFailure('openai_answer_unreadable', `OpenAI's answer to ${what} was not JSON, so whether it was applied is unknown`, uncertain)
    }
    if (!isObject(answer)) {
      throw new ActionFailure('openai_answer_unreadable', `OpenAI's answer to ${what} was not a JSON object`, uncertain)
    }
    return answer
  }

  const status = response.status
  let type: string | null = null
  let code: string | null = null
  try {
    const body: unknown = await response.json()
    const error = isObject(body) && isObject(body.error) ? body.error : null
    if (error !== null) {
      type = typeof error.type === 'string' && error.type.trim() !== '' ? nameOf(error.type) : null
      code = typeof error.code === 'string' && error.code.trim() !== '' ? nameOf(error.code) : null
    }
  } catch {
    // Not JSON: named by its status below.
  }
  const named = [type, code].filter((x) => x !== null).join(', ')
  const said = named === '' ? `HTTP ${status}` : `HTTP ${status} (${named})`

  if (status >= 500) throw new ActionFailure(`openai_http_${status}`, `OpenAI answered ${what} with ${said}`, uncertain)
  if (status === 404) throw new ActionFailure('openai_not_found', `OpenAI found nothing at ${what}: ${said}`, 'not_applied')
  if (status === 429) {
    if (code === 'insufficient_quota' || type === 'insufficient_quota') {
      throw new ActionFailure('openai_insufficient_quota', `OpenAI refused ${what}: the account has no quota left (${said}), which waiting does not clear`, 'not_applied')
    }
    const retryAfter = response.headers.get('retry-after')
    const wait = retryAfter === null ? 'no Retry-After' : `Retry-After ${retryAfter} s`
    throw new ActionFailure('openai_rate_limited', `OpenAI rate limited ${what} (${wait}); not sent`, 'not_applied')
  }
  throw new ActionFailure(`openai_${code ?? type ?? `http_${status}`}`, `OpenAI refused ${what}: ${said}`, 'not_applied')
}

// ── Arguments ────────────────────────────────────────────────────────────────

export const invalid = (message: string) => new ActionFailure('openai_argument_invalid', message, 'not_applied')

/** A required text argument, trimmed; a missing one is `code`. */
export function requiredText(args: ActionArgs, key: string, code: string, missing: string): string {
  const value = args[key]
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) throw new ActionFailure(code, missing, 'not_applied')
  if (typeof value !== 'string') throw invalid(`${key} must be text`)
  return value.trim()
}

/** An optional text argument, or undefined when blank. */
export function optionalText(args: ActionArgs, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw invalid(`${key} must be text`)
  return value
}

/** An optional finite number, optionally a whole one, within bounds. */
export function optionalNumber(args: ActionArgs, key: string, rule: { min?: number; max?: number; integer?: boolean } = {}): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${key} must be a number`)
  if (rule.integer === true && !Number.isInteger(value)) throw invalid(`${key} must be a whole number`)
  if (rule.min !== undefined && value < rule.min) throw invalid(`${key} must be at least ${rule.min}`)
  if (rule.max !== undefined && value > rule.max) throw invalid(`${key} must be at most ${rule.max}`)
  return value
}

export function optionalBoolean(args: ActionArgs, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw invalid(`${key} must be true or false`)
  return value
}

/** An optional JSON object argument. */
export function optionalObject(args: ActionArgs, key: string): OpenAIObject | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!isObject(value)) throw invalid(`${key} must be a JSON object`)
  return value
}

/** An optional JSON list argument. */
export function optionalList(args: ActionArgs, key: string): readonly JsonValue[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw invalid(`${key} must be a JSON list`)
  return value as readonly JsonValue[]
}

/** A format object, which OpenAI names by its `type`. */
export function formatObject(args: ActionArgs, key: string): OpenAIObject | undefined {
  const format = optionalObject(args, key)
  if (format !== undefined && (typeof format.type !== 'string' || format.type.trim() === '')) throw invalid(`${key} must name its type`)
  return format
}

/** Whether a format asks for JSON, so the answer is parsed. */
export const asksForJson = (format: OpenAIObject | undefined) => format !== undefined && (format.type === 'json_schema' || format.type === 'json_object')

/** OpenAI's metadata: up to 16 keys, each value text. */
export function metadataOf(args: ActionArgs): OpenAIObject | undefined {
  const metadata = optionalObject(args, 'metadata')
  if (metadata === undefined) return undefined
  const entries = Object.entries(metadata)
  if (entries.length > 16) throw invalid('metadata holds at most 16 keys')
  for (const [k, v] of entries) if (typeof v !== 'string') throw invalid(`metadata ${k} must be text, as OpenAI keeps only text`)
  return metadata
}

/** The most items one conversation request takes, applied whole. */
export const CONVERSATION_ITEMS_MAX = 20

/** Items for one conversation request: a list of 1 to 20, or more refused rather than split into a partial batch. */
export function itemsOf(args: ActionArgs, required: boolean): readonly JsonValue[] | undefined {
  const items = optionalList(args, 'items')
  if (items === undefined) {
    if (required) throw invalid('items must be a JSON list of 1 to 20 items')
    return undefined
  }
  if (required && items.length === 0) throw invalid('items must hold at least one item')
  if (items.length > CONVERSATION_ITEMS_MAX) {
    throw new ActionFailure('openai_too_many_items', `OpenAI takes at most ${CONVERSATION_ITEMS_MAX} items in one request, and ${items.length} were given; split them over steps`, 'not_applied')
  }
  return items
}

const ID = /^[A-Za-z0-9_-]{1,128}$/

/** A conversation id, safe to put in a path. */
export function conversationIdOf(args: ActionArgs): string {
  const id = requiredText(args, 'conversation_id', 'openai_conversation_missing', 'the step names no conversation')
  if (!ID.test(id)) throw invalid('conversation_id is not a conversation id')
  return id
}

/** A model's answer parsed as the JSON its format asked for, or failed by name: it was billed, so applied. */
export function parsedAnswer(content: string): JsonValue {
  try {
    return JSON.parse(content) as JsonValue
  } catch {
    throw new ActionFailure('openai_answer_not_json', 'OpenAI answered text that is not the JSON its format asked for', 'applied')
  }
}

/** Removes the keys whose value is undefined, so the body sends only what the step set. */
export function defined(fields: Readonly<Record<string, JsonValue | undefined>>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v
  return out
}
