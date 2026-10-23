import { ActionFailure } from '../failure'
import { conversationIdOf, invalid, optionalNumber, optionalText, openaiRequest } from '../openai/call'
import type { ActionRun, JsonValue } from '../types'

/**
 * openai.list-conversation-items, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * One GET of /v1/conversations/{id}/items: one page, of the size asked (1 to
 * 100, 20 when not given, as the code steps read the last 10 or 20 items), in
 * the order asked, after the item given. It reads exactly the page asked for
 * and says whether there is more (`has_more`, `last_id`), so it never stops
 * short silently; it does not walk pages. Pipedream has no component for it.
 */

const ORDER = new Set(['asc', 'desc'])

export const run: ActionRun = async (ctx, args) => {
  const id = conversationIdOf(args)
  const limit = optionalNumber(args, 'limit', { min: 1, max: 100, integer: true }) ?? 20
  const order = optionalText(args, 'order')
  if (order !== undefined && !ORDER.has(order)) throw invalid('order must be asc or desc')
  const after = optionalText(args, 'after')
  const query = new URLSearchParams({ limit: String(limit) })
  if (order !== undefined) query.set('order', order)
  if (after !== undefined) query.set('after', after)

  const answer = await openaiRequest(ctx, { method: 'GET', path: `/conversations/${id}/items?${query.toString()}`, writes: false })
  if (!Array.isArray(answer.data)) {
    throw new ActionFailure('openai_answer_unreadable', "OpenAI's list of conversation items holds no data list", 'not_applied')
  }
  const text = (v: JsonValue | undefined) => (typeof v === 'string' ? v : null)
  return { data: answer.data, has_more: answer.has_more === true, first_id: text(answer.first_id), last_id: text(answer.last_id) }
}
