import { ActionFailure } from '../failure'
import {
  asksForJson, defined, formatObject, invalid, metadataOf, optionalBoolean, optionalList, optionalNumber, optionalObject, optionalText,
  openaiRequest, parsedAnswer, requiredText, type OpenAIObject,
} from '../openai/call'
import type { ActionRun, JsonValue } from '../types'

/**
 * openai.create-response, version 1 (#2337). Released: never edit it; a change
 * is version 2 (the fingerprint check refuses an edit).
 *
 * One POST to /v1/responses, as the 24 code steps make it (a turn in a
 * conversation, often with a JSON schema format) and as Pipedream's Chat using
 * File Search does (PipedreamHQ/pipedream
 * components/openai/actions/chat-using-file-search/chat-using-file-search.mjs,
 * at commit b7d67916: model, input, instructions, previous_response_id,
 * truncation, a file_search tool, include, reasoning and text.format), here
 * with the tools given whole rather than built from one vector store. It
 * returns OpenAI's response with `output_text`, the text of its output
 * messages joined (as OpenAI's SDKs offer it), and `parsed` when the format
 * asks for JSON.
 *
 * Not offered: streaming and background, so a call either finishes in the
 * request or fails by name. Only a completed response succeeds: one cut at
 * max_output_tokens is `openai_answer_truncated`, a filtered one
 * `openai_answer_filtered`, another incomplete one `openai_answer_incomplete`,
 * a refusal `openai_refused` (each applied, since OpenAI billed it and, with a
 * conversation, added the turn); a failed one `openai_response_failed` and
 * one not finished `openai_response_unfinished`, each with its outcome unknown.
 */

const TRUNCATION = new Set(['auto', 'disabled'])

function isObject(value: unknown): value is OpenAIObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const run: ActionRun = async (ctx, args) => {
  const model = requiredText(args, 'model', 'openai_model_missing', 'the step names no model')
  const input = optionalText(args, 'input')
  const inputItems = optionalList(args, 'input_items')
  if (input !== undefined && inputItems !== undefined) throw invalid('give the input as text or as input_items, not both')
  if (input === undefined && inputItems === undefined) throw new ActionFailure('openai_input_missing', 'the step holds no input to send', 'not_applied')

  const truncation = optionalText(args, 'truncation')
  if (truncation !== undefined && !TRUNCATION.has(truncation)) throw invalid('truncation must be auto or disabled')
  const include = optionalList(args, 'include')
  if (include !== undefined && !include.every((x) => typeof x === 'string')) throw invalid('include must be a list of text')
  const textFormat = formatObject(args, 'text_format')

  const body = defined({
    model,
    input: input ?? inputItems,
    instructions: optionalText(args, 'instructions'),
    conversation: optionalText(args, 'conversation'),
    previous_response_id: optionalText(args, 'previous_response_id'),
    text: textFormat === undefined ? undefined : { format: textFormat },
    tools: optionalList(args, 'tools'),
    store: optionalBoolean(args, 'store'),
    temperature: optionalNumber(args, 'temperature'),
    max_output_tokens: optionalNumber(args, 'max_output_tokens', { min: 1, integer: true }),
    metadata: metadataOf(args),
    truncation,
    include,
    reasoning: optionalObject(args, 'reasoning'),
  })

  const answer = await openaiRequest(ctx, { method: 'POST', path: '/responses', body, writes: true })

  const output = Array.isArray(answer.output) ? answer.output : []
  const texts: string[] = []
  let refused = false
  for (const item of output) {
    if (!isObject(item) || item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (!isObject(part)) continue
      if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text)
      if (part.type === 'refusal') refused = true
    }
  }

  const status = typeof answer.status === 'string' ? answer.status : null
  if (status === 'failed') {
    const failedCode = isObject(answer.error) && typeof answer.error.code === 'string' ? answer.error.code : 'no code'
    throw new ActionFailure('openai_response_failed', `OpenAI's response failed (${failedCode})`, 'unknown')
  }
  if (status === 'incomplete') {
    const reason = isObject(answer.incomplete_details) && typeof answer.incomplete_details.reason === 'string' ? answer.incomplete_details.reason : null
    if (reason === 'max_output_tokens') throw new ActionFailure('openai_answer_truncated', 'the answer was cut short at max_output_tokens, so it is incomplete', 'applied')
    if (reason === 'content_filter') throw new ActionFailure('openai_answer_filtered', "the answer was withheld by OpenAI's content filter", 'applied')
    throw new ActionFailure('openai_answer_incomplete', `the response is incomplete (${reason ?? 'no reason given'})`, 'applied')
  }
  if (status !== 'completed') {
    throw new ActionFailure('openai_response_unfinished', `the response is ${status ?? 'without a status'}, not completed`, 'unknown')
  }
  if (refused) throw new ActionFailure('openai_refused', 'the model refused to answer', 'applied')

  const outputText = texts.join('')
  const result: Record<string, JsonValue> = { ...answer, output_text: outputText }
  if (asksForJson(textFormat)) result.parsed = parsedAnswer(outputText)
  return result
}
