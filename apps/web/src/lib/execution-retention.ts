// How long execution rows live before the nightly partition drop removes them.
// Mirrors the cron in supabase/migrations/20260611000002 (CALL
// drop_expired_execution_partitions_safe(7)) — update both together.
export const EXECUTION_RETENTION_DAYS = 7

/**
 * True when an api.ts `req()` rejection means the row does not exist (as
 * opposed to a network failure or a 5xx). req() throws `API <status>: <body>`.
 */
export function isNotFoundError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith('API 404')
}
