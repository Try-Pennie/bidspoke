/**
 * Canonical registry of the monthly RANGE-partitioned tables and their partition
 * keys.
 *
 * Any UPDATE/DELETE against one of these must carry a predicate on its partition
 * key. Matching on an identifier alone (`.eq('id', ...)`) cannot be pruned, so
 * Postgres fans the write out to every monthly partition to reach one row, a cost
 * that grows with every month the table lives (#589). This trap has recurred
 * twice, so #619 added the build-time `worker-partition-key-write-guard` test
 * that reads THIS file (as text) to know which writes to police.
 *
 * Single source of truth: the sightings export purge bounds its deletes with
 * these keys, and the guard derives its policed set from them. Keys are verified
 * against the migrations, not guessed:
 *   20260430000001_lead_sightings.sql   → PARTITION BY RANGE (execution_started_at_utc)
 *                                        → PARTITION BY RANGE (attempted_at_utc)
 *   20260610000001_achieve_evaluations.sql → PARTITION BY RANGE (requested_at_utc)
 */
export const PARTITIONED_TABLES = {
  lead_sightings: 'execution_started_at_utc',
  lead_sighting_bids: 'attempted_at_utc',
  achieve_evaluations: 'requested_at_utc',
} as const satisfies Record<string, string>

export function partitionKeyFor(tableName: string): string {
  const key = (PARTITIONED_TABLES as Record<string, string>)[tableName]
  if (!key) throw new Error(`no partition key registered for ${tableName}`)
  return key
}
