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
import { decryptSecret } from './secret-crypto'

const TTL = 300
const cacheKey = (orgId: string) => `env-vars-${orgId}`
const lastGoodKey = (orgId: string) => `env-vars-${orgId}-lastgood`

export async function loadEnvVars(
  orgId: string,
  kv: KVNamespace,
  supabase: SupabaseClient,
  secretEncryptionKey: string
): Promise<Record<string, string>> {
  const cached = await kv.get<Record<string, string>>(cacheKey(orgId), 'json')
  if (cached) return cached

  // Load ALL user env vars, including is_secret ones, so nodes (code-node `env`
  // global and {{env.X}} template resolution) can read the credentials they
  // exist to use (Dan 2026-06-26). is_secret is a UI-masking flag, not an access
  // gate. Secret values are stored ENCRYPTED (secret-crypto) — they MUST be
  // decrypted here. Injecting the raw ciphertext is what broke Equifax on
  // 2026-06-26 (the node sent the encrypted blob as the password → 401), so a
  // secret that fails to decrypt is SKIPPED, never passed through raw; for code
  // nodes the Cloudflare worker-secret binding remains the fallback. Platform
  // master secrets (worker bindings) are blocked separately in lib/sandbox-env.ts.
  const { data, error } = await supabase
    .from('environment_variables')
    .select('key, value, is_secret')
    .eq('organization_id', orgId)
    .eq('scope', 'global')

  if (error) {
    // Do NOT cache on error — that is the #391 outage. Fall back to the last-good
    // copy (the config vars rarely change) so a transient blip degrades
    // gracefully instead of blanking creds; empty only if we never had a good load.
    console.error(`[env-loader] load failed for org ${orgId}, not caching: ${error.message}`)
    const lastGood = await kv.get<Record<string, string>>(lastGoodKey(orgId), 'json')
    return lastGood ?? {}
  }

  const vars: Record<string, string> = {}
  for (const row of data ?? []) {
    if (!row.value) continue
    if (row.is_secret) {
      try {
        vars[row.key] = await decryptSecret(row.value, secretEncryptionKey)
      } catch {
        // Created pre-encryption or key rotated: skip rather than poison the
        // env with ciphertext (the 2026-06-26 Equifax outage).
        console.error(`[env-loader] could not decrypt secret ${row.key} for org ${orgId}; skipping`)
      }
    } else {
      vars[row.key] = row.value
    }
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
