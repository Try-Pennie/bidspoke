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
 * True when an api.ts `req()` rejection means the row does not exist (as
 * opposed to a network failure or a 5xx). req() throws `API <status>: <body>`.
 */
export function isNotFoundError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith('API 404')
}
