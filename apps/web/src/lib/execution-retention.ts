// How long execution rows live before the nightly partition purge removes them.
//
// TEMPORARILY 21 rather than 7 (2026-08-24, migration 20260824000002): roughly 119
// hours across 2026-08-17 to 08-23 are still unarchived, and the purge is not gated
// on the archive yet (#873), so a stalled backlog walk would delete days nobody
// backed up, silently, because the alert that would say so IS the missing gate. At
// 14 the oldest of those died two days after the earliest return, which is not
// margin when nobody can react; 21 leaves time to notice. Put it back to 7 once
// every day the database holds shows 24 archived hours, checking first what the
// truncate will take, since many days then expire at once.
//
// The cron that enforces this is the authority, not this constant, and
// __tests__/cron-threshold-within-retention.test.ts derives the window from the last
// migration that schedules a purge, so the two cannot drift.
export const EXECUTION_RETENTION_DAYS = 21

/**
 * True when an api.ts `req()` rejection means the row does not exist (as
 * opposed to a network failure or a 5xx). req() throws `API <status>: <body>`.
 */
export function isNotFoundError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith('API 404')
}
