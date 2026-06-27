/**
 * Required-secrets guard (#386).
 *
 * The worker depends on ~15 secrets that have no default and no in-repo source
 * (they are set via `wrangler secret put`). A forgotten `secret put` after a new
 * integration is invisible until a live lead hits that code path and the
 * execution fails. This guard asserts every required secret is present and
 * non-empty, so a gap is surfaced as a daily alert instead of silently breaking
 * money-moving traffic. Optional/feature-gated secrets (GITHUB_TOKEN,
 * ANTHROPIC_API_KEY) and non-secret vars that ship defaults in wrangler.toml
 * (APP_URL, SUPABASE_JWKS_URL, ...) are intentionally excluded.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import { sendRequiredSecretsAlert } from './slack'

/** Secrets the worker cannot run correctly without — every one must be set in prod. */
export const REQUIRED_SECRETS = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'API_KEY_MAP',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'SECRET_ENCRYPTION_KEY',
  'SSN_HASH_PEPPER',
  'SNOWFLAKE_ACCOUNT',
  'SNOWFLAKE_USER',
  'SNOWFLAKE_PRIVATE_KEY',
  'SNOWFLAKE_DATABASE',
  'SNOWFLAKE_SCHEMA',
  'SNOWFLAKE_WAREHOUSE',
  'SNOWFLAKE_ROLE',
] as const satisfies readonly (keyof Env)[]

/**
 * Partner values that live workflows depend on but the typed `Env` doesn't cover:
 * Salesforce is read dynamically (cast off Env), and Equifax/Tripoint are consumed
 * inside code-node scripts (the sandbox), invisible to a source grep.
 *
 * This guard checks the worker's *secret bindings*, so it must only list values that
 * are genuine wrangler secrets. The Salesforce/Equifax connection details that live
 * as non-secret rows in the `environment_variables` table (SALESFORCE_INSTANCE_URL,
 * SALESFORCE_CLIENT_ID, EQUIFAX_USERNAME) are NOT worker secrets — they are owned by
 * the separate required-env-vars guard (#394). Listing them here produced a daily
 * false-positive alert (they are always absent from the binding); likewise EQ_USER /
 * EQ_PASS were never real keys (the Equifax password secret is EQUIFAX_PASSWORD).
 * Feature-gated partners (Achieve, Eligibility Scout) stay excluded to avoid false
 * alarms.
 */
export const REQUIRED_PARTNER_SECRETS = [
  'SALESFORCE_CLIENT_SECRET',
  'EQUIFAX_PASSWORD',
  'TRIPOINT_PROXY_SECRET',
] as const

/** Required secrets (core + partner) that are absent, empty, or whitespace-only, in declared order. */
export function findMissingRequiredSecrets(env: Env): string[] {
  const record = env as unknown as Record<string, unknown>
  return [...REQUIRED_SECRETS, ...REQUIRED_PARTNER_SECRETS].filter((key) => {
    const value = record[key]
    return typeof value !== 'string' || value.trim() === ''
  })
}

export interface RequiredSecretsResult {
  missing: string[]
  alerted: boolean
}

/**
 * Daily guard: if any required secret is missing in prod, alert every org that
 * has a Slack connection (the worker's secrets are global, so there is no single
 * org to target). Returns the missing keys and whether an alert was sent.
 */
export async function runRequiredSecretsCheck(
  supabase: SupabaseClient,
  env: Env,
): Promise<RequiredSecretsResult> {
  const missing = findMissingRequiredSecrets(env)
  if (missing.length === 0) return { missing: [], alerted: false }

  const { data: conns } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  let alerted = false
  for (const orgId of orgIds) {
    if (await sendRequiredSecretsAlert(supabase, orgId, missing)) alerted = true
  }
  return { missing, alerted }
}
