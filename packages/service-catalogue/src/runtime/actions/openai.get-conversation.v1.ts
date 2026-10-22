import { conversationIdOf, openaiRequest } from '../openai/call'
import type { ActionRun } from '../types'

/**
 * openai.get-conversation, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * One GET of /v1/conversations/{id}, as two code steps make it to learn
 * whether a stored id is still a conversation: one that is not fails as
 * `openai_not_found`, by name, so a workflow can branch on it. Pipedream has
 * no component for it.
 */
export const run: ActionRun = async (ctx, args) => {
  const id = conversationIdOf(args)
  return await openaiRequest(ctx, { method: 'GET', path: `/conversations/${id}`, writes: false })
}
