import { ActionFailure } from '../failure'
import {
  asksForJson, defined, formatObject, invalid, optionalList, optionalNumber, optionalText, openaiRequest, parsedAnswer, requiredText,
  type OpenAIObject,
} from '../openai/call'
import type { ActionRun, JsonValue } from '../types'

/**
 * openai.chat, version 1 (#2337). Released: never edit it; a change is version
 * 2 (the fingerprint check refuses an edit).
 *
 * Parity with Pipedream's Chat (PipedreamHQ/pipedream
 * components/openai/actions/chat/chat.mjs and actions/common/common.mjs
 * `_getChatArgs`, at commit b7d67916), lifted with these changes: one POST to
 * /v1/chat/completions with the model, the messages and the settings, and the
 * answer returned with `original_messages` and
 * `original_messages_with_assistant_response` as Pipedream returned it.
 *  - The messages: the system instructions and the user message, or a whole
 *    `messages` list (as the 12 code steps build it), with the user message
 *    appended when one is given. Pipedream silently dropped the system
 *    instructions when a list was given; here the two together are refused.
 *    The user message is sent as text, not as one text part.
 *  - The token limit is sent as max_completion_tokens for every model
 *    (Pipedream sent max_tokens except to o-series models, and OpenAI refuses
 *    max_tokens on the reasoning models it has deprecated it for).
 *  - Not offered: images, audio, function tools and n (no step sets them),
 *    streaming, and store, so OpenAI keeps nothing of the call.
 *  - A JSON format's answer is parsed into `parsed`, the text left as it came
 *    (Pipedream overwrote the text with the parse and kept text it could not
 *    parse); text that is not JSON fails as `openai_answer_not_json`.
 *  - Only a finished answer (finish_reason stop) succeeds. An answer cut at its
 *    token limit is `openai_answer_truncated`, a filtered one
 *    `openai_answer_filtered`, a refusal `openai_refused`, anything else
 *    `openai_answer_unfinished`: each applied, since OpenAI billed it.
 */

const MESSAGES_FORMAT = 'each message must be a JSON object with a role and content'

export const run: ActionRun = async (ctx, args) => {
  const model = requiredText(args, 'model', 'openai_model_missing', 'the step names no model')
  const userMessage = optionalText(args, 'user_message')
  const system = optionalText(args, 'system_instructions')
  const prior = optionalList(args, 'messages')

  const messages: JsonValue[] = []
  if (prior !== undefined) {
    if (system !== undefined) throw invalid('system_instructions is not used with messages: put the system message in messages')
    for (const m of prior) {
      if (typeof m !== 'object' || m === null || Array.isArray(m)) throw invalid(MESSAGES_FORMAT)
      const message = m as OpenAIObject
      if (typeof message.role !== 'string' || message.content === undefined || message.content === null) throw invalid(MESSAGES_FORMAT)
      messages.push(message)
    }
  } else if (system !== undefined) {
    messages.push({ role: 'system', content: system })
  }
  if (userMessage !== undefined) messages.push({ role: 'user', content: userMessage })
  if (userMessage === undefined && (prior === undefined || prior.length === 0)) {
    throw new ActionFailure('openai_messages_missing', 'the step holds no user message and no messages to send', 'not_applied')
  }

  const stop = args.stop
  if (stop !== undefined && stop !== null && typeof stop !== 'string' && !(Array.isArray(stop) && stop.every((s) => typeof s === 'string'))) {
    throw invalid('stop must be text or a list of text')
  }
  const responseFormat = formatObject(args, 'response_format')

  const body = defined({
    model,
    messages,
    temperature: optionalNumber(args, 'temperature'),
    max_completion_tokens: optionalNumber(args, 'max_tokens', { min: 1, integer: true }),
    top_p: optionalNumber(args, 'top_p'),
    stop: stop ?? undefined,
    presence_penalty: optionalNumber(args, 'presence_penalty'),
    frequency_penalty: optionalNumber(args, 'frequency_penalty'),
    user: optionalText(args, 'user'),
    response_format: responseFormat,
  })

  const answer = await openaiRequest(ctx, { method: 'POST', path: '/chat/completions', body, writes: true })

  const choices = Array.isArray(answer.choices) ? answer.choices : []
  const choice = (choices[0] ?? null) as OpenAIObject | null
  const message = choice !== null && typeof choice.message === 'object' && choice.message !== null && !Array.isArray(choice.message) ? (choice.message as OpenAIObject) : null
  const finish = choice !== null && typeof choice.finish_reason === 'string' ? choice.finish_reason : null

  if (message !== null && typeof message.refusal === 'string' && message.refusal !== '') {
    throw new ActionFailure('openai_refused', 'the model refused to answer', 'applied')
  }
  if (finish === 'length') throw new ActionFailure('openai_answer_truncated', 'the answer was cut short at its token limit, so it is incomplete', 'applied')
  if (finish === 'content_filter') throw new ActionFailure('openai_answer_filtered', "the answer was withheld by OpenAI's content filter", 'applied')
  if (finish !== 'stop' || message === null || typeof message.content !== 'string') {
    throw new ActionFailure('openai_answer_unfinished', `the answer did not finish (finish_reason ${finish ?? 'missing'})`, 'applied')
  }

  const content = message.content
  return {
    ...answer,
    content,
    finish_reason: finish,
    ...(asksForJson(responseFormat) ? { parsed: parsedAnswer(content) } : {}),
    original_messages: messages,
    original_messages_with_assistant_response: [...messages, message],
  }
}
