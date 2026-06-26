/**
 * Required env-var guard (#394).
 *
 * The non-secret partner config that lives in the `environment_variables` table
 * (is_secret=false, loaded per-org via env-loader.ts) has no presence check. When
 * SALESFORCE_INSTANCE_URL / SALESFORCE_CLIENT_ID went blank during the 2026-06-26
 * outage the Salesforce node failed, and after #393 a low-volume config gap pages
 * nothing (it's suppressed below the failure-aggregation threshold). This daily
 * guard reads the table directly (the source of truth, not the KV cache) and
 * asserts a curated set of mandatory config keys resolves non-empty for every
 * configured org, alerting Slack if any is missing or blank.
 *
 * The list mirrors the required-secrets guard's "live and mandatory" curation
 * (#386/#390): Salesforce + Equifax. SALESFORCE_CLIENT_SECRET is stored as a
 * secret (covered by the secret guard), not here. Feature-gated partners
 * (Achieve, Eligibility Scout) and the narrower LendSwift per-state usernames are
 * deliberately excluded to avoid false alarms — extend this list when a partner
 * becomes mandatory.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import { sendRequiredEnvVarsAlert } from './slack'

/** Non-secret config keys a production org cannot run live traffic without. */
export const REQUIRED_ENV_VARS = [
  'SALESFORCE_INSTANCE_URL',
  'SALESFORCE_CLIENT_ID',
  'EQUIFAX_USERNAME',
] as const

/** Required keys that are absent, empty, or whitespace-only, in declared order. */
export function findMissingEnvVars(vars: Record<string, string>): string[] {
  return REQUIRED_ENV_VARS.filter((key) => {
    const value = vars[key]
    return typeof value !== 'string' || value.trim() === ''
  })
}

export interface RequiredEnvVarsResult {
  /** Distinct required keys found missing across all checked orgs, in declared order. */
  missing: string[]
  alerted: boolean
}

/**
 * Daily guard: for every org with a Slack connection, read its non-secret env
 * vars straight from the DB and alert if any required key is missing or blank.
 * Orgs with no non-secret env vars configured at all are skipped (an unconfigured
 * tenant has nothing to assert), and a transient DB error never raises an alert —
 * a blip must not page a false-missing.
 */
export async function runRequiredEnvVarsCheck(
  supabase: SupabaseClient,
  env: Env,
): Promise<RequiredEnvVarsResult> {
  const { data: conns } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  const missingAcrossOrgs = new Set<string>()
  let alerted = false

  for (const orgId of orgIds) {
    const { data, error } = await supabase
      .from('environment_variables')
      .select('key, value')
      .eq('organization_id', orgId)
      .eq('scope', 'global')
      .is('is_secret', false)

    if (error) {
      // Transient DB error: don't treat as missing (that's the #391 failure mode
      // inverted). Log and skip — the next daily run re-checks.
      console.error(`[required-env-vars] load failed for org ${orgId}, skipping: ${(error as { message: string }).message}`)
      continue
    }

    const rows = (data ?? []) as { key: string; value: string | null }[]
    if (rows.length === 0) continue // unconfigured tenant — nothing to assert

    const vars: Record<string, string> = {}
    for (const row of rows) if (typeof row.value === 'string') vars[row.key] = row.value

    const missing = findMissingEnvVars(vars)
    if (missing.length === 0) continue

    for (const key of missing) missingAcrossOrgs.add(key)
    if (await sendRequiredEnvVarsAlert(supabase, orgId, missing, env.APP_URL)) alerted = true
  }

  return {
    missing: REQUIRED_ENV_VARS.filter((k) => missingAcrossOrgs.has(k)),
    alerted,
  }
}
