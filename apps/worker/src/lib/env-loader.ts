// KV-cached env var loader — avoids a Supabase round-trip on every execution.
// Cache is per-org, TTL 300s. Invalidated explicitly on any env var mutation.
// Pre-warmed by the scheduled cron in index.ts.
//
// #391: a transient DB error must NEVER be cached as an empty env map. Doing so
// blanked the non-secret Salesforce creds for the full 300s TTL and caused a
// 2026-06-26 lead outage (a brief connection-pool blip cascaded into ~5 min of
// failures). So: only cache a SUCCESSFUL load, and keep a long-lived "last-good"
// copy to serve during a blip so creds don't go blank at all.

import type { SupabaseClient } from '@supabase/supabase-js'

const TTL = 300
const cacheKey = (orgId: string) => `env-vars-${orgId}`
const lastGoodKey = (orgId: string) => `env-vars-${orgId}-lastgood`

export async function loadEnvVars(
  orgId: string,
  kv: KVNamespace,
  supabase: SupabaseClient
): Promise<Record<string, string>> {
  const cached = await kv.get<Record<string, string>>(cacheKey(orgId), 'json')
  if (cached) return cached

  // All user-defined env vars load, including is_secret ones: nodes (code nodes
  // and {{env.X}} template resolution) must be able to read the very credentials
  // they exist to use (Dan 2026-06-26). `is_secret` is a UI-masking flag only,
  // not an access gate. Platform master secrets (Cloudflare worker bindings like
  // SECRET_ENCRYPTION_KEY / SSN_HASH_PEPPER) are a SEPARATE layer, still withheld
  // from the sandbox by lib/sandbox-env.ts ENV_SANDBOX_POLICY — this query only
  // covers the environment_variables table.
  const { data, error } = await supabase
    .from('environment_variables')
    .select('key, value')
    .eq('organization_id', orgId)
    .eq('scope', 'global')

  if (error) {
    // Do NOT cache on error — that is the #391 outage. Fall back to the last-good
    // copy (the non-secret config vars rarely change) so a transient blip degrades
    // gracefully instead of blanking creds; empty only if we never had a good load.
    console.error(`[env-loader] load failed for org ${orgId}, not caching: ${error.message}`)
    const lastGood = await kv.get<Record<string, string>>(lastGoodKey(orgId), 'json')
    return lastGood ?? {}
  }

  const vars: Record<string, string> = {}
  for (const row of data ?? []) {
    if (row.value) vars[row.key] = row.value
  }

  const serialized = JSON.stringify(vars)
  // Short cache for the hot path; long-lived last-good (no TTL) for blip resilience.
  await kv.put(cacheKey(orgId), serialized, { expirationTtl: TTL })
  await kv.put(lastGoodKey(orgId), serialized)
  return vars
}

export async function invalidateEnvCache(orgId: string, kv: KVNamespace): Promise<void> {
  // Only drop the short cache. The last-good copy is intentionally kept: the next
  // successful load overwrites it, and keeping it preserves blip resilience even
  // right after an edit.
  await kv.delete(cacheKey(orgId))
}
