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

/** Writes that act within one organization: each takes p_organization_id and matches it. */
export const OPS_ORGANIZATION_RPCS = [
  'enqueue_run_request',
  'start_run_execution',
  'extend_run_lease',
  'complete_run_request',
  'record_send_intent',
  'record_send_result',
  'record_schedule_fire',
  'set_run_request_kept',
  // The minute cron's (#1949).
  'record_schedule_observation',
  // The ops connections' and Salesforce pool's (#2334).
  'record_connection_tombstone',
  'record_connection_check',
  'record_connection_needs_reauth',
  'record_connection_reauth_cleared',
  'record_measured_identity',
  'acquire_sf_lease',
  'release_sf_lease',
  // Decision 2's refresh streak (#2335).
  'record_connection_refresh',
  // The per organization cap on OpsConnections.lookup (#2335, PR 8).
  'take_lookup_allowance',
  // The Google mailboxes and drives list's writes, each with its change record (#2338).
  'add_google_delegation_subject',
  'remove_google_delegation_subject',
  // A workflow version's definition, copied from the bidding Worker (#1950).
  'save_workflow_definition',
  // A step's latest test result (#2339).
  'record_step_test',
  // Each step a run walks, fenced by its claim token (#2703).
  'record_ops_step',
  // A run's checkpoint, named on its run by its holder, fenced like every run write (#1951).
  'record_run_checkpoint',
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
  // The minute cron's (#1949): a sweep's interval, and the saved workflow copies, which span organizations.
  'claim_ops_sweep',
  'save_workflow_copies',
  // The ops connections' and Salesforce pool's (#2334): the served copies span
  // organizations, and the purge, the lease sweep and a Salesforce org's budget
  // reading belong to none.
  'save_connection_copies',
  'purge_expired_connection_tombstones',
  'sweep_sf_leases',
  'record_sf_budget_reading',
  // The observation_purge sweep (#1950): retention is the same for every organization.
  'purge_schedule_observations',
  // The same nightly sweep purges step test results past 7 days (#2339).
  'purge_step_test_results',
  // And the records of run attempts started more than 7 days ago (#2703).
  'purge_ops_step_records',
  // And a run's recorded variables once it has been terminal more than 7 days (#2998).
  'purge_run_variables',
  // The last good copy of each ops version's plain variables (#2999): the tick's
  // one batched write spans organizations, and the nightly purge belongs to none.
  'save_variable_copies',
  'purge_variable_copies',
  // How long an ops key reseal has been switched on, and what its runs last
  // said (#2486): the lane's own state, which belongs to no organization.
  'observe_ops_reseal',
  'record_ops_reseal_run',
  // The measured identities of connections bidding never stored, removed after a complete serve (#2573): the list spans organizations.
  'remove_unserved_measured_identities',
] as const

/**
 * Read only functions (STABLE in the database, checked by run_engine_schema.test.sql
 * and connection_storage.test.sql). Lane wide ones take no organization;
 * organization scoped ones take p_organization_id and answer only that
 * organization's rows (#2334: one connection's copy, and one organization's
 * connection statuses; #2335: whether a mailbox and drives are on that
 * organization's Google delegation allowlist; #2338: that allowlist itself).
 */
export const OPS_LANE_READ_ONLY_RPCS = [
  'run_queue_disagreements', 'ops_now', 'workflow_copies', 'due_queue_depth',
  // The sf_limits sweep's measured Salesforce orgs (#2336): a Salesforce org belongs to no one organization.
  'sf_limits_targets',
  // The connection_check sweep's list and the tick's login states (#2340): every ops connection, each row carrying its organization.
  'connection_check_targets',
  // The saved copies whose current version has no definition held yet (#1950), each row carrying its organization.
  'missing_workflow_definitions',
] as const
export const OPS_ORGANIZATION_READ_ONLY_RPCS = [
  'connection_copy', 'connection_status', 'google_delegation_check', 'list_google_delegation_subjects',
  // One version of one organization's workflow definition (#1950).
  'workflow_definition',
  // One step's latest test result, nothing past 7 days (#2339).
  'step_test_result',
  // A past run's payload and recorded step outputs, for a step test from that run, nothing past 7 days (#2703).
  'run_step_context',
  // The checkpoint a run names, answered to its holder alone (#1951).
  'run_checkpoint',
  // One organization's kept copies of the versions asked about (#2999).
  'variable_copies',
] as const
export const OPS_READ_ONLY_RPCS = [...OPS_LANE_READ_ONLY_RPCS, ...OPS_ORGANIZATION_READ_ONLY_RPCS] as const

export const OPS_MUTATING_RPCS = [...OPS_ORGANIZATION_RPCS, ...OPS_LANE_RPCS] as const

export type OpsRpcName = (typeof OPS_MUTATING_RPCS)[number] | (typeof OPS_READ_ONLY_RPCS)[number]
