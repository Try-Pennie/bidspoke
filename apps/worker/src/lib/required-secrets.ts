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
import { orgIdsToTell, slackOrgIds } from './alert-fanout'
import type { Env } from '../index'
import { sendRequiredSecretsAlert } from './slack'

// The lists live in ./secret-lists, a module with no runtime imports, so the CI
// parity check (.github/scripts/worker-secret-parity.mjs) reads the same lists
// the daily guard does (#1709).
import { OPS_OPTIONAL_SECRETS, OPS_REQUIRED_SECRETS, REQUIRED_SECRETS, REQUIRED_PARTNER_SECRETS } from './secret-lists'
import type { OpsEnv } from '../ops/index'
export { REQUIRED_SECRETS, REQUIRED_PARTNER_SECRETS }

// Compile time: every required name is a binding of the Worker that needs it, so a
// typo or a renamed binding fails the typecheck rather than the daily alert.
const moneyBindings: readonly (keyof Env)[] = REQUIRED_SECRETS
const opsBindings: readonly (keyof OpsEnv)[] = OPS_REQUIRED_SECRETS
const opsOptionalBindings: readonly (keyof OpsEnv)[] = OPS_OPTIONAL_SECRETS
void moneyBindings
void opsBindings
void opsOptionalBindings

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

  const orgIds = orgIdsToTell(await slackOrgIds(supabase, 'required-secrets', 'tell-only'))

  let alerted = false
  for (const orgId of orgIds) {
    if (await sendRequiredSecretsAlert(supabase, orgId, missing)) alerted = true
  }
  return { missing, alerted }
}
