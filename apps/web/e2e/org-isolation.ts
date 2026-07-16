/**
 * Keeping the e2e suite out of production data (#664).
 *
 * The suite signs in as e2e-test@trypennie.com and drives the real Worker +
 * Supabase. What keeps it away from Main Flow, Engine Bidding and Lead Economy
 * is the tenant model: the test user has its own organization, so every
 * org-scoped query the Worker runs is confined to test data.
 *
 * That safety is one `UPDATE users SET organization_id = ...` away from being
 * undone. This guard runs in global setup and aborts the whole run if the test
 * user is ever found back in the production org, instead of letting a green
 * suite quietly mutate live workflows the way it did before #664.
 */

/**
 * The organization that owns the money-moving workflows (Main Flow, Engine
 * Bidding, Lead Economy, RML). The e2e user must never belong to it.
 */
export const PRODUCTION_ORG_ID = '9d9d0d3a-1959-41d5-95ca-c1399fa54590'

/**
 * Throws if the e2e user's org is the production org, or if the org could not be
 * determined at all (fail closed: an unknown org is not a proven-safe one).
 */
export function assertIsolatedOrg(
  userOrgId: string | null | undefined,
  forbiddenOrgId: string = PRODUCTION_ORG_ID,
): void {
  if (!userOrgId) {
    throw new Error(
      'E2E isolation check: could not determine the test user\'s organization. ' +
        'Refusing to run against an unverified org.',
    )
  }
  if (userOrgId === forbiddenOrgId) {
    throw new Error(
      `E2E isolation breach: the test user is in the production organization (${forbiddenOrgId}). ` +
        'Running the suite would mutate live workflows. Move e2e-test@trypennie.com to its own org (#664) before running.',
    )
  }
}
