/**
 * The one place Salesforce credentials are resolved (#1174).
 *
 * WHERE THEY ACTUALLY LIVE, measured on prod 2026-09-04 rather than assumed:
 *
 *   SALESFORCE_INSTANCE_URL    environment_variables table only
 *   SALESFORCE_CLIENT_ID       environment_variables table only
 *   SALESFORCE_CLIENT_SECRET   environment_variables table AND a Worker secret
 *
 * So a reader that consults the Worker env alone sees ONE value of three and
 * refuses before any query runs. The engine's Salesforce node works because the
 * executor hands it a merged `ctx.env` that already includes the org store; every
 * scheduled job that read the raw Worker env instead has been broken:
 *
 *   the hourly bid matrix sync, failing every hour since 2026-08-22 (#982)
 *   the matrix audit, the same way
 *   the Salesforce token prewarm, whose gate has therefore always been false
 *   the Tripoint revenue fill, which inherited it within the hour (#1171, #1172)
 *
 * The failure is invisible to any check done by hand, because the interactive
 * path is the merged one. That is why this lives in one module with a source
 * guard behind it rather than being written correctly four times.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import { loadEnvVars } from './env-loader'
import { secretKeys } from './secret-crypto'

export interface SalesforceCreds {
  instanceUrl: string
  clientId: string
  clientSecret: string
}

// Defined beside the rule that a workflow cannot hold its own copy of them (#1681).
export { SALESFORCE_CRED_KEYS } from './org-only-env-keys'

/**
 * Choose each value from the organization store first, then the Worker env.
 *
 * The store wins where both carry a value, because it is the copy the engine
 * uses successfully thousands of times a day. Every missing name is reported,
 * not just the first, or somebody sets one value and meets the same error twice
 * more. An empty string counts as missing rather than as a credential.
 */
export function pickSalesforceCreds(
  orgVars: Record<string, string>,
  cfEnv: Record<string, string | undefined>,
): { creds: SalesforceCreds | null; missing: string[] } {
  const pick = (key: string): string => {
    const fromStore = orgVars[key]
    if (typeof fromStore === 'string' && fromStore.trim()) return fromStore.trim()
    const fromCf = cfEnv[key]
    return typeof fromCf === 'string' && fromCf.trim() ? fromCf.trim() : ''
  }

  const instanceUrl = pick('SALESFORCE_INSTANCE_URL').replace(/\/$/, '')
  const clientId = pick('SALESFORCE_CLIENT_ID')
  const clientSecret = pick('SALESFORCE_CLIENT_SECRET')

  const missing: string[] = []
  if (!instanceUrl) missing.push('SALESFORCE_INSTANCE_URL')
  if (!clientId) missing.push('SALESFORCE_CLIENT_ID')
  if (!clientSecret) missing.push('SALESFORCE_CLIENT_SECRET')
  if (missing.length) return { creds: null, missing }

  return { creds: { instanceUrl, clientId, clientSecret }, missing: [] }
}

/**
 * Resolve for one organization. Returns the missing names rather than throwing,
 * so a caller that must not fail the whole run (the cache prewarm) can decline
 * quietly while a caller that needs them can throw with the list.
 */
export async function resolveSalesforceCredsFor(
  env: Env,
  supabase: SupabaseClient,
  orgId: string,
): Promise<{ creds: SalesforceCreds | null; missing: string[] }> {
  // Organization credentials for jobs that run outside any workflow, so the
  // org values only: no one workflow's own values may stand in for them (#1681).
  const orgVars = await loadEnvVars(orgId, env.WORKFLOW_CACHE, supabase, secretKeys(env), 'global-only')
  return pickSalesforceCreds(orgVars, env as unknown as Record<string, string | undefined>)
}

/** The same, throwing with every missing name, for a caller that cannot proceed. */
export async function requireSalesforceCreds(
  env: Env,
  supabase: SupabaseClient,
  orgId: string,
  purpose: string,
): Promise<SalesforceCreds> {
  const { creds, missing } = await resolveSalesforceCredsFor(env, supabase, orgId)
  if (!creds) {
    throw new Error(
      `Salesforce credentials missing for ${purpose}: ${missing.join(', ')} (checked the org env store and the Worker env)`,
    )
  }
  return creds
}

/**
 * The organization that HOLDS the global Salesforce credentials, for a caller
 * with no organization of its own (the worker-level matrix audit).
 *
 * Derived from the data rather than hardcoded, and it REFUSES when more than one
 * organization holds them instead of picking: using one tenant's credentials to
 * read another's Salesforce is worse than not running (LESSONS L75).
 */
export async function resolveSalesforceCredentialOrg(
  supabase: SupabaseClient,
): Promise<{ orgId: string | null; error: string | null }> {
  // paginate-ok: one row per organization holding a global SALESFORCE_INSTANCE_URL, single digits
  const { data, error } = await supabase
    .from('environment_variables')
    .select('organization_id')
    .eq('key', 'SALESFORCE_INSTANCE_URL')
    .eq('scope', 'global')

  if (error) return { orgId: null, error: `salesforce_cred_org_lookup_failed: ${error.message}` }

  const orgIds = [
    ...new Set(
      ((data ?? []) as Array<{ organization_id?: unknown }>)
        .map((r) => r.organization_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ]
  if (orgIds.length === 0) return { orgId: null, error: 'no_org_holds_salesforce_credentials' }
  if (orgIds.length > 1) {
    return {
      orgId: null,
      error: `several_orgs_hold_salesforce_credentials: ${orgIds.length}, so which tenant to read as is ambiguous`,
    }
  }
  return { orgId: orgIds[0], error: null }
}
