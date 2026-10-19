/**
 * The most rows each configuration list may hold before its read refuses
 * (#1437 P6). Every read named here goes through `fetchUpTo` (paginate.ts),
 * which asks for one row more than its bound and refuses a list that holds
 * more, so a list past its bound fails loudly instead of coming back cut at
 * PostgREST's 1,000 row cap looking complete.
 *
 * Each bound is sized from the production count measured on 2026-10-19 (the
 * largest organization, read only) with clear headroom, and kept here so every
 * size claim is in one place a reviewer can read against the database. A list
 * that outgrows its bound is refused, never truncated: raise the bound (up to
 * 999) or page the read with fetchAllPaged.
 */
export const CONFIG_LIST_BOUNDS = {
  /** workflows of one organization, deleted ones included: 36 (11 undeleted). */
  workflows: 500,
  /** partner_configs of one organization: 9. Also the most partner ids a rename may name. */
  partnerConfigs: 200,
  /** partner_uuid_map of one organization: 7 (4 for one partner). */
  partnerUuids: 500,
  /** buyer_profiles of one organization: 2. */
  buyerProfiles: 200,
  /** environment_variables of one organization: 62 (26 secrets). */
  environmentVariables: 500,
  /** env_var_folders of one organization: 10. */
  envVarFolders: 200,
  /** folders of one organization: 3. */
  folders: 200,
  /** webhook_endpoints of one organization: 9. */
  webhookEndpoints: 500,
  /** service_presets of one organization: 0. */
  servicePresets: 200,
  /** partner_bid_configs of one organization: 0. */
  partnerBidConfigs: 200,
  /** api_sources of one organization: 7. */
  apiSources: 200,
  /** source_workflow_assignments of one organization: 6 (1 for one source), at most one per workflow and source. */
  sourceAssignments: 500,
  /** user_allowlist, global: 9. */
  allowlist: 500,
  /** field_presence_silences of one workflow: 0, at most one per watched field (80 for the widest workflow). */
  fieldSilences: 500,
} as const
