// KV-cached env var loader — avoids a Supabase round-trip on every execution.
// Cache is per-org, TTL 300s. Invalidated explicitly on any env var mutation.
// Pre-warmed by the scheduled cron in index.ts.
//
// #391: a transient DB error must NEVER be cached as an empty env map. Doing so
// blanked the non-secret Salesforce creds for the full 300s TTL and caused a
// 2026-06-26 lead outage (a brief connection-pool blip cascaded into ~5 min of
// failures). So: only cache a SUCCESSFUL load, and keep a long-lived "last-good"
// copy to serve during a blip so creds don't go blank at all.
//
// #491: the cached map holds DECRYPTED secrets, so it is now encrypted at rest in
// KV. Secrets are encrypted in Postgres precisely so they are not lying around in
// the clear, and decrypting them into a plaintext cache undid that: anyone able to
// read the KV namespace (a leaked Cloudflare token) could read every live
// credential. The last-good copy has no TTL, so a rotated or deleted credential's
// plaintext sat there indefinitely. Both keys now hold ciphertext, and invalidation
// re-warms last-good so a superseded credential does not survive its own rotation.

import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { decryptSecret, encryptSecret, type SecretKeyInput } from './secret-crypto'

const TTL = 300
const cacheKey = (orgId: string) => `env-vars-${orgId}`
const lastGoodKey = (orgId: string) => `env-vars-${orgId}-lastgood`

// Read an encrypted env map out of KV. A blob we cannot decrypt is treated as a
// MISS, never as an error: that is what a SECRET_ENCRYPTION_KEY rotation (a
// documented operation) leaves behind, and also what the pre-#491 plaintext entries
// look like on the first deploy after this ships. In both cases the right move is
// the same, fall through to the DB and rewrite the entry, which self-heals them.
async function readEncrypted(
  kv: KVNamespace,
  key: string,
  secretEncryptionKey: SecretKeyInput
): Promise<Record<string, string> | null> {
  const blob = await kv.get(key)
  if (!blob) return null
  try {
    return JSON.parse(await decryptSecret(blob, secretEncryptionKey)) as Record<string, string>
  } catch {
    return null
  }
}

export async function loadEnvVars(
  orgId: string,
  kv: KVNamespace,
  supabase: SupabaseClient,
  secretEncryptionKey: SecretKeyInput
): Promise<Record<string, string>> {
  const cached = await readEncrypted(kv, cacheKey(orgId), secretEncryptionKey)
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
    const lastGood = await readEncrypted(kv, lastGoodKey(orgId), secretEncryptionKey)
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

  // Encrypted at rest (#491): this map carries the decrypted secrets.
  const serialized = await encryptSecret(JSON.stringify(vars), secretEncryptionKey)
  // Short cache for the hot path; long-lived last-good (no TTL) for blip resilience.
  await kv.put(cacheKey(orgId), serialized, { expirationTtl: TTL })
  await kv.put(lastGoodKey(orgId), serialized)
  return vars
}

export async function invalidateEnvCache(
  orgId: string,
  kv: KVNamespace,
  supabase: SupabaseClient,
  secretEncryptionKey: SecretKeyInput
): Promise<void> {
  await kv.delete(cacheKey(orgId))

  // Re-warm, rather than only dropping the short key (#491). Last-good has no TTL,
  // so a rotated or deleted credential used to sit in it forever. Loading fresh here
  // overwrites it with only the current values, so the superseded one leaves KV.
  //
  // Overwrite, never delete: last-good is what keeps creds from going blank during a
  // DB blip (#391), and deleting it would reopen that outage for the window after
  // every edit. If this re-warm's read fails, last-good keeps its previous contents
  // (stale, but encrypted at rest, and purged by the next successful load) rather
  // than leaving the org with nothing to fall back on. The caller has just committed
  // a DB write, so the read is overwhelmingly likely to succeed.
  try {
    await loadEnvVars(orgId, kv, supabase, secretEncryptionKey)
  } catch (e) {
    console.error(
      `[env-loader] cache re-warm after mutation failed for org ${orgId}: ${formatErr(e)}`
    )
  }
}
