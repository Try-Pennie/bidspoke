/**
 * Every function of the ops database the ops Worker may call, classified once
 * (#1948): read only or mutating, and whether it acts within one organization.
 *
 * Read by three things, so it is the one list:
 *  - createOpsSupabaseClient's local dev write guard (ops-db.ts), which refuses a
 *    mutating rpc, or one on neither list, when local dev points at a remote
 *    database (#669, #1409);
 *  - callOpsRpc (ops-writes.ts), the only `.rpc(` on the ops client, which refuses
 *    a name not listed here and an organization scoped call without a valid
 *    organization;
 *  - apps/web/src/lib/__guards__/worker/ops-rpcs-classified.test.ts, which
 *    fails when a name here is not created by a supabase-ops migration, a
 *    function a migration creates is not listed here, or a listed function has
 *    no typed wrapper in ops-writes.ts.
 *
 * The bidding database's list is apps/worker/src/lib/read-only-rpcs.json; the two
 * never mix, because a name is only meaningful against its own database.
 */

/** Calls that act within one organization: each takes p_organization_id and matches it. */
export const OPS_ORGANIZATION_RPCS = [
  'enqueue_run_request',
  'start_run_execution',
  'extend_run_lease',
  'complete_run_request',
  'record_send_intent',
  'record_send_result',
  'record_schedule_fire',
  'set_run_request_kept',
] as const

/**
 * Lane wide system work: the claim, the sweeps and the purge act across
 * organizations and return each row's organization, which every later call
 * then carries.
 */
export const OPS_LANE_RPCS = [
  'claim_run_requests',
  'sweep_expired_leases',
  'expire_overdue_run_requests',
  'purge_terminal_run_requests',
  'purge_expired_dedup_tombstones',
] as const

/** Read only functions (STABLE in the database, checked by run_engine_schema.test.sql). */
export const OPS_READ_ONLY_RPCS = ['run_queue_disagreements'] as const

export const OPS_MUTATING_RPCS = [...OPS_ORGANIZATION_RPCS, ...OPS_LANE_RPCS] as const

export type OpsRpcName = (typeof OPS_MUTATING_RPCS)[number] | (typeof OPS_READ_ONLY_RPCS)[number]
