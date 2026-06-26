/**
 * Secret decrypt-health check (#404).
 *
 * Secret env vars are stored encrypted (`secret-crypto`, key SECRET_ENCRYPTION_KEY).
 * Since `be895af` the env-loader DECRYPTS them and SILENTLY SKIPS any that fail to
 * decrypt (created before encryption was added, or encrypted under a rotated key =
 * the "rotate to enable reveal" state). Skipping is the safe choice — it avoids
 * passing ciphertext through as a credential (the 2026-06-26 Equifax outage) — but
 * it means a node can lose a credential it needs with no signal at all.
 *
 * This daily check attempts to decrypt every global secret env var and alerts the
 * org's Slack on the ones that fail, so a dead credential surfaces before a live
 * lead hits it. Scout's ELIGIBILITY_SCOUT_CLIENT_SECRET is the live validation case.
 *
 * Scope notes:
 * - Only the "fails to decrypt" direction. The sibling "exists in the DB but not
 *   synced as a Cloudflare worker secret" direction is owned by the secret-drift
 *   check (#199, `secret-drift.ts`); duplicating it here would double-alert.
 * - Only `scope='global'` secrets — the same set the env-loader actually decrypts
 *   and skips. A secret nothing decrypts cannot silently strand a node.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import { decryptSecret } from './secret-crypto'
import { getSlackConnection, sendSecretDecryptAlert } from './slack'

export interface SecretRow {
  key: string
  value: string | null
  organization_id: string
}

/** Rows whose stored ciphertext fails to decrypt under the given key. Empty values
 * are skipped — an unset secret is a presence problem (required-secrets / secret-drift),
 * not a decrypt failure. */
export async function findUndecryptableSecrets(
  rows: SecretRow[],
  secretEncryptionKey: string,
): Promise<SecretRow[]> {
  const bad: SecretRow[] = []
  for (const row of rows) {
    if (!row.value) continue
    try {
      await decryptSecret(row.value, secretEncryptionKey)
    } catch {
      bad.push(row)
    }
  }
  return bad
}

export interface SecretDecryptHealthResult {
  checked: number
  undecryptable: number
  alerted: boolean
  skipped?: string
}

export async function runSecretDecryptHealthCheck(
  supabase: SupabaseClient,
  env: Env,
): Promise<SecretDecryptHealthResult> {
  // If the encryption key itself is missing, every decrypt would fail and flood the
  // alert. That gap is a required-secret (covered by #386); skip here to stay quiet.
  if (!env.SECRET_ENCRYPTION_KEY) {
    return { checked: 0, undecryptable: 0, alerted: false, skipped: 'no-encryption-key' }
  }

  const { data, error } = await supabase
    .from('environment_variables')
    .select('key, value, organization_id')
    .eq('is_secret', true)
    .eq('scope', 'global')

  if (error) {
    // A transient DB error must never raise a false alert (the #391 outage shape,
    // inverted). Log and skip — the next daily run re-checks.
    console.error(`[secret-decrypt-health] load failed, skipping: ${error.message}`)
    return { checked: 0, undecryptable: 0, alerted: false, skipped: 'db-error' }
  }

  const rows = (data ?? []) as SecretRow[]
  const bad = await findUndecryptableSecrets(rows, env.SECRET_ENCRYPTION_KEY)
  if (bad.length === 0) return { checked: rows.length, undecryptable: 0, alerted: false }

  // Group by org so each org's Slack connection gets only its own undecryptable keys.
  const byOrg = new Map<string, string[]>()
  for (const s of bad) {
    const list = byOrg.get(s.organization_id) ?? []
    list.push(s.key)
    byOrg.set(s.organization_id, list)
  }

  let alerted = false
  for (const [orgId, keys] of byOrg) {
    const connection = await getSlackConnection(supabase, orgId)
    if (!connection || !connection.config_alerts_enabled) continue
    if (await sendSecretDecryptAlert(connection, keys, env.APP_URL)) alerted = true
  }

  return { checked: rows.length, undecryptable: bad.length, alerted }
}
