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
import { logReadFailure } from './scheduled-read'
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
  // Execution archive (#871). Each pair is registered in the change that first
  // READS it, never when it is merely declared: this guard alerts every org's
  // Slack daily, so a secret listed before it is set pages every morning for
  // nothing.
  //
  // The reader and eraser were held back on exactly that reasoning, and the
  // deferral then outlived its reason. Their code paths shipped on 2026-08-22
  // (the deletion gate and the settings read-back authenticate as the reader,
  // the erasure path as the eraser), both credentials were still unset in
  // production, and the only thing that noticed was a downstream job failing
  // the next morning with a message about Snowflake availability. A deferral
  // whose condition has expired is not a deferral, it is a gap (L129).
  //
  // Kept in step with the credential map by a derived test rather than by hand.
  'ARCHIVE_WRITER_USER',
  'ARCHIVE_WRITER_PRIVATE_KEY',
  'ARCHIVE_READER_USER',
  'ARCHIVE_READER_PRIVATE_KEY',
  'ARCHIVE_ERASER_USER',
  'ARCHIVE_ERASER_PRIVATE_KEY',
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
  // The shared key FFN's firewall Skip rule matches on, sent by both the Achieve
  // Offers node and the Eligibility Scout code node (see engine/nodes/ffn-identity.ts).
  // Listed here and not with the feature-gated partners above because the Scout call
  // is on the live Main Flow path: unset, that path stays blocked, and the only thing
  // that reports it is a field-presence alert four days later, naming a symptom.
  'FFN_PARTNER_KEY',
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

  const { data: conns, error: connsError } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  logReadFailure('required-secrets', 'slack connections', connsError)
  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  let alerted = false
  for (const orgId of orgIds) {
    if (await sendRequiredSecretsAlert(supabase, orgId, missing)) alerted = true
  }
  return { missing, alerted }
}
