import { anthropicPost, type AnthropicObject } from '../anthropic/call'
import { ActionFailure } from '../failure'
import type { ActionArgs, ActionRun, JsonValue } from '../types'

/**
 * anthropic.chat, version 1 (#2337). Released: never edit it; a change is
 * version 2 (the fingerprint check refuses an edit).
 *
 * Lifted from Pipedream's Chat (PipedreamHQ/pipedream
 * components/anthropic/actions/chat/chat.mjs, at commit b7d67916), with little
 * change: prior messages as text alternate from the person, the user message
 * is appended, and one POST to /v1/messages sends them with the model,
 * max_tokens, temperature, top_p and top_k; the answer is returned as
 * Pipedream returned it, with `original_messages` (each message's content)
 * and `original_messages_with_assistant_response`. What differs, on purpose:
 *  - `messages` may also be whole { role, content } objects, content blocks
 *    and all, as the one code step sends PDF and image documents; the user
 *    message is then optional;
 *  - `system`, `stop_sequences` and `output_format` (sent as
 *    output_config.format) are offered, as the code step uses a system prompt
 *    and a JSON schema; a JSON schema answer is parsed into `parsed`, and text
 *    that is not JSON fails as `anthropic_answer_not_json`;
 *  - `text` joins every text block, where Pipedream read only the first;
 *  - only a finished answer (stop_reason end_turn or stop_sequence) succeeds:
 *    one cut at max_tokens is `anthropic_answer_truncated`, a refusal
 *    `anthropic_refused`, a full context window
 *    `anthropic_context_window_exceeded`, anything else
 *    `anthropic_answer_unfinished`, each applied, since Anthropic billed it;
 *  - a model is required (Pipedream defaulted to claude-sonnet-4-5-20250929),
 *    so a step never changes model when a default does.
 */

const invalid = (message: string) => new ActionFailure('anthropic_argument_invalid', message, 'not_applied')
const MESSAGE_FORMAT = 'messages must be a list of text, alternating from the person, or of { role, content } objects'
const FINISHED = new Set(['end_turn', 'stop_sequence'])

function isObject(value: unknown): value is AnthropicObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function number(args: ActionArgs, key: string, integer: boolean, min?: number): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${key} must be a number`)
  if (integer && !Number.isInteger(value)) throw invalid(`${key} must be a whole number`)
  if (min !== undefined && value < min) throw invalid(`${key} must be at least ${min}`)
  return value
}

function text(args: ActionArgs, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw invalid(`${key} must be text`)
  return value
}

export const run: ActionRun = async (ctx, args) => {
  const model = text(args, 'model')?.trim()
  if (model === undefined || model === '') throw new ActionFailure('anthropic_model_missing', 'the step names no model', 'not_applied')
  const userMessage = text(args, 'user_message')

  const messages: Array<{ role: string; content: JsonValue }> = []
  const prior = args.messages
  if (prior !== undefined && prior !== null) {
    if (!Array.isArray(prior)) throw invalid(MESSAGE_FORMAT)
    const list = prior as readonly JsonValue[]
    if (list.every((m) => typeof m === 'string')) {
      list.forEach((content, i) => messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content }))
    } else if (list.every((m) => isObject(m) && typeof m.role === 'string' && m.content !== undefined && m.content !== null)) {
      for (const m of list as AnthropicObject[]) messages.push({ role: m.role as string, content: m.content })
    } else {
      throw invalid(MESSAGE_FORMAT)
    }
  }
  if (userMessage !== undefined) messages.push({ role: 'user', content: userMessage })
  if (messages.length === 0) throw new ActionFailure('anthropic_messages_missing', 'the step holds no user message and no messages to send', 'not_applied')

  const maxTokens = number(args, 'max_tokens', true, 1)
  if (maxTokens === undefined) throw new ActionFailure('anthropic_max_tokens_missing', 'the step sets no max_tokens, which Anthropic requires', 'not_applied')
  const stops = args.stop_sequences
  if (stops !== undefined && stops !== null && !(Array.isArray(stops) && stops.every((s) => typeof s === 'string'))) {
    throw invalid('stop_sequences must be a list of text')
  }
  const format = args.output_format
  if (format !== undefined && format !== null && !(isObject(format) && typeof format.type === 'string' && format.type !== '')) {
    throw invalid('output_format must be a JSON object naming its type')
  }

  const body: Record<string, JsonValue> = { model, max_tokens: maxTokens, messages }
  const system = text(args, 'system')
  if (system !== undefined) body.system = system
  if (isObject(format)) body.output_config = { format }
  const temperature = number(args, 'temperature', false)
  if (temperature !== undefined) body.temperature = temperature
  const topP = number(args, 'top_p', false)
  if (topP !== undefined) body.top_p = topP
  const topK = number(args, 'top_k', true, 1)
  if (topK !== undefined) body.top_k = topK
  if (Array.isArray(stops)) body.stop_sequences = stops

  const answer = await anthropicPost(ctx, '/messages', body)
  if (!Array.isArray(answer.content)) {
    throw new ActionFailure('anthropic_answer_unreadable', "Anthropic's message holds no content list, so whether the model ran is unknown", 'unknown')
  }
  const stopReason = typeof answer.stop_reason === 'string' ? answer.stop_reason : null
  if (stopReason === 'max_tokens') throw new ActionFailure('anthropic_answer_truncated', 'the answer was cut short at max_tokens, so it is incomplete', 'applied')
  if (stopReason === 'refusal') throw new ActionFailure('anthropic_refused', 'the model refused to answer', 'applied')
  if (stopReason === 'model_context_window_exceeded') {
    throw new ActionFailure('anthropic_context_window_exceeded', "the answer stopped when the model's context window was full, so it is incomplete", 'applied')
  }
  if (stopReason === null || !FINISHED.has(stopReason)) {
    throw new ActionFailure('anthropic_answer_unfinished', `the answer did not finish (stop_reason ${stopReason ?? 'missing'})`, 'applied')
  }

  const answerText = answer.content.flatMap((block) => (isObject(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('')
  const originalMessages = messages.map((m) => m.content)
  const result: Record<string, JsonValue> = {
    original_messages: originalMessages,
    original_messages_with_assistant_response: [...originalMessages, answerText],
    ...answer,
    text: answerText,
  }
  if (isObject(format) && format.type === 'json_schema') {
    try {
      result.parsed = JSON.parse(answerText) as JsonValue
    } catch {
      throw new ActionFailure('anthropic_answer_not_json', 'Anthropic answered text that is not the JSON its format asked for', 'applied')
    }
  }
  return result
}
