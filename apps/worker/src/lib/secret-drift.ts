/**
 * Secret-drift check (#199).
 *
 * Secret env vars live in two systems that must stay in lockstep: the
 * `environment_variables` row (encrypted copy + metadata) and the real
 * Cloudflare worker secret keyed by the var's `key`. If a Cloudflare write
 * failed halfway or a rename left things inconsistent, a workflow's secret
 * reference silently resolves to nothing with no signal (bit us in #104, #78).
 *
 * This daily check lists the secrets the database expects and compares them to
 * the secrets actually in Cloudflare, reporting the ones the database expects
 * that Cloudflare is missing — the case that actually breaks a workflow. The
 * reverse direction (Cloudflare secrets with no database row) is intentionally
 * not flagged: those are almost always platform/partner master secrets, and an
 * extra secret is harmless. A re-push repair lives at POST /api/env/resync-secrets.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import { listCfSecretNames } from './cf-secrets'
import { getSlackConnection, sendSecretDriftAlert } from './slack'
import { fetchAllPaged } from './paginate'

export interface DbSecret {
  key: string
  scope: string
  workflow_id: string | null
  organization_id: string
}

/**
 * DB secret keys that Cloudflare is missing, the workflow-breaking direction.
 * Only org secrets are expected there: a workflow's own secret is never written
 * to Cloudflare, whose Worker holds one value per name for every workflow, so
 * its absence is the design rather than drift (#1681).
 */
export function findMissingSecrets(dbSecrets: DbSecret[], cfNames: Set<string>): DbSecret[] {
  return dbSecrets.filter((s) => s.scope === 'global' && !cfNames.has(s.key))
}

export interface SecretDriftResult {
  checked: number
  missing: number
  alerted: boolean
  skipped?: string
}

/** Every organization's secret variable names and scopes. Throws on a failed read. */
export async function readDbSecrets(supabase: SupabaseClient): Promise<DbSecret[]> {
  // Paged by the primary key past PostgREST's 1,000 row cap (#1437).
  return fetchAllPaged<DbSecret>(
    (from, to) =>
      supabase
        .from('environment_variables')
        .select('key, scope, workflow_id, organization_id')
        .eq('is_secret', true)
        .order('id', { ascending: true })
        .range(from, to),
    'environment_variables query',
  )
}

export async function runSecretDriftCheck(
  supabase: SupabaseClient,
  env: Env
): Promise<SecretDriftResult> {
  const cfNames = await listCfSecretNames(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN)
  if (cfNames === null) return { checked: 0, missing: 0, alerted: false, skipped: 'cf-not-configured' }

  const dbSecrets = await readDbSecrets(supabase)
  const missing = findMissingSecrets(dbSecrets, cfNames)
  if (missing.length === 0) return { checked: dbSecrets.length, missing: 0, alerted: false }

  // Group by org so each org's Slack connection gets its own alert.
  const byOrg = new Map<string, DbSecret[]>()
  for (const s of missing) {
    const list = byOrg.get(s.organization_id) ?? []
    list.push(s)
    byOrg.set(s.organization_id, list)
  }

  let alerted = false
  for (const [orgId, secrets] of byOrg) {
    const connection = await getSlackConnection(supabase, orgId)
    if (!connection || !connection.config_alerts_enabled) continue
    const sent = await sendSecretDriftAlert(connection, secrets, env.APP_URL)
    alerted = alerted || sent
  }

  return { checked: dbSecrets.length, missing: missing.length, alerted }
}
