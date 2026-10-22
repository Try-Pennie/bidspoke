import { ActionFailure } from '../failure'
import { defined, itemsOf, metadataOf, openaiRequest } from '../openai/call'
import type { ActionRun } from '../types'

/**
 * openai.create-conversation, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * One POST to /v1/conversations with the metadata and opening items given, as
 * 13 code steps make it (each with text metadata: the lead's external id, a
 * first name, a topic), returning the conversation OpenAI made. Pipedream has
 * no component for it. An answer naming no id was applied, so it fails as
 * `openai_answer_incomplete`, applied, and is never repeated.
 */
export const run: ActionRun = async (ctx, args) => {
  const body = defined({ metadata: metadataOf(args), items: itemsOf(args, false) })
  const answer = await openaiRequest(ctx, { method: 'POST', path: '/conversations', body, writes: true })
  if (typeof answer.id !== 'string' || answer.id === '') {
    throw new ActionFailure('openai_answer_incomplete', 'OpenAI made the conversation and named no id for it', 'applied')
  }
  return answer
}
