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
 * Partner secrets that live workflows depend on but the typed `Env` doesn't cover:
 * Salesforce/Achieve are read dynamically (cast off Env), and Equifax/Tripoint are
 * consumed inside code-node scripts (the sandbox), invisible to a source grep. This
 * list is curated to the partners that are live and mandatory (confirmed 2026-06-26):
 * Salesforce, Equifax, Tripoint. Feature-gated partners (Achieve until its node is
 * flipped to prod, Eligibility Scout) are deliberately excluded to avoid false alarms.
 */
export const REQUIRED_PARTNER_SECRETS = [
  'SALESFORCE_INSTANCE_URL',
  'SALESFORCE_CLIENT_ID',
  'SALESFORCE_CLIENT_SECRET',
  'EQ_USER',
  'EQ_PASS',
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
