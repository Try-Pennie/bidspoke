// KV-cached env var loader — avoids a Supabase round-trip on every execution.
// Cache is per-org, TTL 60s. Invalidated explicitly on any env var mutation.

import type { SupabaseClient } from '@supabase/supabase-js'

const TTL = 60
const cacheKey = (orgId: string) => `env-vars-${orgId}`

export async function loadEnvVars(
  orgId: string,
  kv: KVNamespace,
  supabase: SupabaseClient
): Promise<Record<string, string>> {
  const cached = await kv.get<Record<string, string>>(cacheKey(orgId), 'json')
  if (cached) return cached

  const { data } = await supabase
    .from('environment_variables')
    .select('key, value')
    .eq('organization_id', orgId)
    .eq('scope', 'global')
    .is('is_secret', false)

  const vars: Record<string, string> = {}
  for (const row of data ?? []) {
    if (row.value) vars[row.key] = row.value
  }

  await kv.put(cacheKey(orgId), JSON.stringify(vars), { expirationTtl: TTL })
  return vars
}

export async function invalidateEnvCache(orgId: string, kv: KVNamespace): Promise<void> {
  await kv.delete(cacheKey(orgId))
}
