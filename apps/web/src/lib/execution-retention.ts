// How long execution rows live before the nightly partition purge removes them.
//
// TEMPORARILY 14 rather than 7 (2026-08-23, migration 20260823000002): six days
// were only partly archived while nobody was available to intervene, and the purge
// is not gated on the archive yet (#873), so this buys the backlog walk time. Put
// it back to 7 once every day the database holds shows 24 archived hours.
//
// The cron that enforces this is the authority, not this constant, and
// __tests__/retention-matches-purge-cron.test.ts fails if the two drift.
export const EXECUTION_RETENTION_DAYS = 14

/**
 * True when an api.ts `req()` rejection means the row does not exist (as
 * opposed to a network failure or a 5xx). req() throws `API <status>: <body>`.
 */
export function isNotFoundError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith('API 404')
}
