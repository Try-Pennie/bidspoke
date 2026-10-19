/**
 * Seal an organization's Slack bot token into credential_enc, and verify every
 * seal before the plaintext may go (#2331, phase 1 of #1689; F128).
 *
 * Called by POST /api/admin/seal-slack-token. Who may call it: any signed in
 * user (Bidspoke has no admin role; every /api/admin route takes any signed in
 * user's JWT). Whose data: only the caller's organization, in the read AND in
 * the UPDATE's WHERE (`organization_id = <caller's org> AND credential_enc IS
 * NULL`), which also makes a second run change nothing.
 *
 * Modelled on reencrypt-secrets: a preview unless dryRun is false, idempotent,
 * reporting rows changed. The plaintext in config.bot_token is left where it is:
 * the code before this release reads only that (L640), and it is stripped only
 * in the contract release, which may go ahead only when `readyForContract`
 * is true for every organization: each Slack row sealed, opening under the key
 * new writes use, holding the same token as config.bot_token, and no key
 * rotation in flight. The verification reads the rows back after the writes,
 * so it measures what was stored, not what was meant to be (L581).
 *
 * The audit row is the table trigger's, naming the caller through updated_by
 * (F119); this writes none of its own. The saved Slack copy is not edited: the
 * token itself does not change, only where it is kept, and the next healthy
 * minute probe rewrites the copy from the rows with the key ring in force.
 *
 * The answer carries row ids and booleans only, never a token or a ciphertext.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptSecret, encryptSecret, type SecretKeys } from '../../lib/secret-crypto'
import { NO_ROW_MATCHED_CODE, requireRowsAffected } from '../../lib/db-retry'

export interface SealVerification {
  id: string
  sealed: boolean
  /** Whether the ciphertext opens with the key new writes use, alone. */
  opensWithLockKey: boolean
  /** Whether it holds the same token as config.bot_token; null when it could not be opened, or there is no plaintext. */
  matchesPlaintext: boolean | null
}

export interface SealResult {
  dryRun: boolean
  /** True while SECRET_ENCRYPTION_KEY_NEXT is set: the contract release waits for the swap. */
  rotating: boolean
  rowsSeen: number
  /** Rows sealed by this run, or on a preview, rows that would be. */
  sealed: number
  alreadySealed: number
  /** Unsealed rows with no plaintext token to seal. */
  cannotSeal: string[]
  /** Unsealed rows that changed between this run's read and its write (sealed meanwhile). */
  changedMeanwhile: string[]
  verification: SealVerification[]
  readyForContract: boolean
}

interface SlackRow {
  id: string
  config: unknown
  credential_enc: string | null
}

const plaintextOf = (config: unknown): string | null => {
  if (!config || typeof config !== 'object') return null
  const t = (config as Record<string, unknown>).bot_token
  return typeof t === 'string' && t.length > 0 ? t : null
}

/**
 * The most Slack rows one organization's seal reads (#1437). Today the store
 * holds at most one (UNIQUE organization_id, service_type; measured 2026-10-18,
 * one row in all). Release 2 of #2332 allows an alert row plus named ops rows,
 * and 20 leaves room for that. The read asks for one more, and a full answer
 * throws: a cut list could call the contract release safe with a row unseen.
 */
export const SLACK_ROWS_MAX = 20

async function readRows(supabase: SupabaseClient, orgId: string): Promise<SlackRow[]> {
  const { data, error } = await supabase
    .from('service_connections')
    .select('id, config, credential_enc')
    .eq('organization_id', orgId)
    .eq('service_type', 'slack')
    .limit(SLACK_ROWS_MAX + 1)
  if (error) throw new Error(`reading service_connections failed: ${error.message}`)
  const rows: SlackRow[] = data ?? []
  if (rows.length > SLACK_ROWS_MAX) {
    throw new Error(`organization ${orgId} has more than ${SLACK_ROWS_MAX} Slack rows; the read is bounded there, so the seal was refused rather than judged on a cut list`)
  }
  return rows
}

async function verify(row: SlackRow, keys: SecretKeys): Promise<SealVerification> {
  if (!row.credential_enc) return { id: row.id, sealed: false, opensWithLockKey: false, matchesPlaintext: null }
  let opened: string | null
  try {
    opened = await decryptSecret(row.credential_enc, keys.encryptWith)
  } catch {
    opened = null
  }
  const plaintext = plaintextOf(row.config)
  return {
    id: row.id,
    sealed: true,
    opensWithLockKey: opened !== null,
    matchesPlaintext: opened === null || plaintext === null ? null : opened === plaintext,
  }
}

export async function sealSlackTokens(
  supabase: SupabaseClient,
  keys: SecretKeys,
  orgId: string,
  actorId: string,
  opts: { dryRun: boolean },
): Promise<SealResult> {
  const rotating = keys.decryptWith.length > 1
  const rows = await readRows(supabase, orgId)
  let sealed = 0
  let alreadySealed = 0
  const cannotSeal: string[] = []
  const changedMeanwhile: string[] = []

  for (const row of rows) {
    if (row.credential_enc) {
      alreadySealed++
      continue
    }
    const plaintext = plaintextOf(row.config)
    if (!plaintext) {
      cannotSeal.push(row.id)
      continue
    }
    const ciphertext = await encryptSecret(plaintext, keys)
    // Refuse to store anything the lock key cannot read back to the same token.
    if ((await decryptSecret(ciphertext, keys.encryptWith)) !== plaintext) {
      throw new Error(`the sealed token for row ${row.id} did not read back`)
    }
    if (opts.dryRun) {
      sealed++
      continue
    }
    // Matching no row is expected (sealed meanwhile by another run) and counts
    // as changed meanwhile; a real database error throws.
    const written = await requireRowsAffected(
      'service_connections.credential_enc',
      () =>
        supabase
          .from('service_connections')
          .update({ credential_enc: ciphertext, sealed_for: 'bidding_ring', updated_by: actorId })
          .eq('id', row.id)
          .eq('organization_id', orgId)
          .eq('service_type', 'slack')
          .is('credential_enc', null)
          .select('id'),
      { onMiss: 'silent' },
    )
    if (written.error && written.error.code !== NO_ROW_MATCHED_CODE) throw new Error(`sealing row ${row.id} failed: ${written.error.message}`)
    if (written.rows.length === 1) sealed++
    else changedMeanwhile.push(row.id)
  }

  // Verified from the rows as stored now, so a write that did not land, or
  // landed something else, shows here.
  const stored = opts.dryRun ? rows : await readRows(supabase, orgId)
  const verification = await Promise.all(stored.map((r) => verify(r, keys)))
  const readyForContract =
    !rotating && verification.length > 0 && verification.every((v) => v.sealed && v.opensWithLockKey && v.matchesPlaintext === true)

  return { dryRun: opts.dryRun, rotating, rowsSeen: rows.length, sealed, alreadySealed, cannotSeal, changedMeanwhile, verification, readyForContract }
}
