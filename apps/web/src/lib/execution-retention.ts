// How long execution rows live before the nightly partition purge removes them.
//
// 7 is the designed window. It ran at 14 and then 21 from 2026-08-23 to 2026-09-06
// as insurance while the archive backlog drained and deletion was not yet gated on
// the archive; the gate shipped (#873) and #1038 put it back once every retained
// day showed 24 archived hours.
//
// The cron that enforces this is the authority, not this constant, and
// __tests__/cron-threshold-within-retention.test.ts derives the window from the last
// migration that schedules a purge, so the two cannot drift.
export const EXECUTION_RETENTION_DAYS = 7

/**
 * The HTTP status an api.ts `req()` rejection carries, when it carries one.
 *
 * WHAT THIS CORRECTS. Both readers below used to match the message prefix
 * `API <status>:`, and `req()` almost never produces that: it surfaces the
 * server's own `error` field as the message precisely so a person reads
 * "Execution not found" rather than a developer-shaped wrapper, and it puts
 * the status on the Error instead. The prefix only survives for a body with no
 * `error` field. So `isNotFoundError` answered false for every 404 this app
 * actually returns, and the execution page's not-found notice was unreachable:
 * a missing execution fell through to the generic red error box. Found by
 * looking at the rendered page while building #874, not by any test, because
 * every test asserting it built the Error by hand in the shape the reader
 * expected (L52).
 *
 * Status first, message prefix second, so nothing that does throw the old shape
 * regresses.
 */
function statusOf(e: unknown): number | null {
  if (!(e instanceof Error)) return null
  const status = (e as Error & { status?: unknown }).status
  if (typeof status === 'number') return status
  const match = /^API (\d{3})\b/.exec(e.message)
  return match ? Number(match[1]) : null
}

/**
 * True when an api.ts `req()` rejection means the row does not exist (as
 * opposed to a network failure or a 5xx).
 */
export function isNotFoundError(e: unknown): boolean {
  return statusOf(e) === 404
}

/**
 * What the archive was waiting for, when a read could not reach it (#874).
 *
 * The server answers 503 rather than 404 for this precisely so the two can be
 * told apart here. Collapsing them would tell an operator a lead never ran when
 * the only thing that happened is that a warehouse was asleep.
 *
 * A 503 whose body cannot be parsed is STILL an unavailable archive: a gateway
 * or proxy answers with HTML, and returning null for it would route it into
 * "never existed" (L11).
 */
export function archiveUnavailableFrom(
  e: unknown
): { waitingFor: string; detail: string } | null {
  if (statusOf(e) !== 503) return null
  const message = e instanceof Error ? e.message : ''
  // Every field still reports something when the body is missing or misshapen.
  // A 503 that cannot be described is still an unavailable archive, and saying
  // so vaguely beats routing it into "this never existed" (L11).
  const fallback = { waitingFor: 'the execution archive', detail: message }

  const body = (e as { body?: unknown }).body
  if (!body || typeof body !== 'object') return fallback
  const parsed = body as { waiting_for?: unknown; detail?: unknown }
  return {
    waitingFor: typeof parsed.waiting_for === 'string' ? parsed.waiting_for : fallback.waitingFor,
    detail: typeof parsed.detail === 'string' ? parsed.detail : fallback.detail,
  }
}
