import { conversationIdOf, itemsOf, openaiRequest } from '../openai/call'
import type { ActionRun, JsonValue } from '../types'

/**
 * openai.add-conversation-items, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * One POST to /v1/conversations/{id}/items with 1 to 20 items, which OpenAI
 * applies whole, as the one code step makes it (it seeds a new conversation
 * with a thread's history, 20 items a request). More than 20 is refused by
 * name (`openai_too_many_items`) rather than split, since a split that failed
 * halfway would leave a partial batch nothing could tell from a whole one.
 * Pipedream has no component for it.
 */
export const run: ActionRun = async (ctx, args) => {
  const id = conversationIdOf(args)
  const items = itemsOf(args, true) as readonly JsonValue[]
  return await openaiRequest(ctx, { method: 'POST', path: `/conversations/${id}/items`, body: { items }, writes: true })
}
