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
 * - The same set the env-loader actually decrypts: every org secret, and since
 *   #1681 every secret saved for one workflow, which the loader WITHHOLDS from
 *   that workflow's runs when it cannot decrypt it. A workflow's own secret is
 *   named with its workflow, since the same key can be the org's too. One saved
 *   for a deleted workflow is left out: no run reads it, so it strands nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import { decryptSecret, secretKeys, type SecretKeyInput } from './secret-crypto'
import { getSlackConnection, sendSecretDecryptAlert } from './slack'

interface EmbeddedWorkflow {
  name: string
  deleted_at: string | null
}

export interface SecretRow {
  key: string
  value: string | null
  organization_id: string
  scope: string
  workflow_id: string | null
  /**
   * The workflow a workflow scoped secret was saved for, embedded by the read.
   * PostgREST returns a many to one embed as one object; the untyped client
   * declares it as a list, so both are accepted.
   */
  workflows: EmbeddedWorkflow | EmbeddedWorkflow[] | null
}

const embeddedWorkflow = (row: SecretRow): EmbeddedWorkflow | null =>
  (Array.isArray(row.workflows) ? row.workflows[0] : row.workflows) ?? null

/** Rows whose stored ciphertext fails to decrypt under the given key. Empty values
 * are skipped — an unset secret is a presence problem (required-secrets / secret-drift),
 * not a decrypt failure. */
export async function findUndecryptableSecrets(
  rows: SecretRow[],
  secretEncryptionKey: SecretKeyInput,
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
    .select('key, value, organization_id, scope, workflow_id, workflows(name, deleted_at)')
    .eq('is_secret', true)

  if (error) {
    // A transient DB error must never raise a false alert (the #391 outage shape,
    // inverted). Log and skip: the next daily run re-checks.
    console.error(`[secret-decrypt-health] load failed, skipping: ${error.message}`)
    return { checked: 0, undecryptable: 0, alerted: false, skipped: 'db-error' }
  }

  // A workflow scoped secret counts only while its workflow can still run, and
  // only when it names one, which is the set the loader hands a run (#1681).
  const rows = ((data ?? []) as SecretRow[]).filter((row) =>
    row.scope === 'global' || (row.scope === 'workflow' && row.workflow_id !== null && !embeddedWorkflow(row)?.deleted_at)
  )
  const bad = await findUndecryptableSecrets(rows, secretKeys(env))
  if (bad.length === 0) return { checked: rows.length, undecryptable: 0, alerted: false }

  // Group by org so each org's Slack connection gets only its own undecryptable keys.
  const byOrg = new Map<string, { key: string; workflow: string | null }[]>()
  for (const s of bad) {
    const list = byOrg.get(s.organization_id) ?? []
    list.push({ key: s.key, workflow: s.scope === 'workflow' ? (embeddedWorkflow(s)?.name ?? s.workflow_id) : null })
    byOrg.set(s.organization_id, list)
  }

  let alerted = false
  for (const [orgId, secrets] of byOrg) {
    const connection = await getSlackConnection(supabase, orgId)
    if (!connection || !connection.config_alerts_enabled) continue
    if (await sendSecretDecryptAlert(connection, secrets, env.APP_URL)) alerted = true
  }

  return { checked: rows.length, undecryptable: bad.length, alerted }
}
