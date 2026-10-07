/**
 * The one way code a sender reaches may read its query string (#1815).
 *
 * Workers Logs keeps every request's full address, query string included, so
 * Dan decided (2026-10-06) that nothing a sender puts in an address is acted on:
 * partner data comes in the body. A fixed control word is the one exception,
 * because it carries no data of the sender's. This answers with the matching
 * word from the caller's own list, or undefined, so a sender can choose between
 * our words and no text of theirs is ever read back.
 *
 * __guards__/worker/inbound-no-query-string.test.ts refuses every other read of
 * a request's query string outside the signed-in app's routes.
 */
import type { HonoRequest } from 'hono'

export function controlWordFromQuery<const W extends string>(req: HonoRequest, name: string, words: readonly W[]): W | undefined {
  const value = req.query(name)
  return words.find((word) => word === value)
}
