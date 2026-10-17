/**
 * Re-lock every stored secret with the key new writes use (#384).
 *
 * The middle step of a SECRET_ENCRYPTION_KEY rotation (see secret-crypto.ts).
 * With SECRET_ENCRYPTION_KEY_NEXT set, each stored value is read with whichever
 * key opens it and written back locked with NEXT. Once every row reports current,
 * the primary can be set to the NEXT value with nothing left that only the old
 * key could read.
 *
 * Four tables hold values locked with this key: the secret environment
 * variables, app_settings.value_encrypted, the failed Salesforce writes held
 * for replay (#1993: body, error and last error of outcome_writeback_deadletters),
 * and the sealed Slack bot token (#2331: service_connections.credential_enc
 * where sealed_for is bidding_ring; an ops_key row is locked for the ops key
 * and is neither read nor written here). The other things it locks (the env and
 * Slack caches in KV) are rebuilt from these tables when they cannot be read,
 * so they need no pass here.
 *
 * service_connections is audited by its own trigger (#2331, F119), which names
 * the actor from updated_by, so a re-lock there sets updated_by to the caller
 * when one is given; without one the trigger labels it direct_sql.
 *
 * Run twice or concurrently, it is safe: a row already locked with NEXT is left
 * alone, and each write is conditional on the value it read, so a secret somebody
 * saves while this runs is never overwritten with the older value. Such a row is
 * reported, and a second run confirms it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptSecret, encryptSecret, type SecretKeys } from './secret-crypto'
import { NO_ROW_MATCHED_CODE, requireRowsAffected } from './db-retry'
import { fetchAllPaged } from './paginate'

/** PostgREST's default row cap. A read that reaches it may be missing rows. */
const ROW_CAP = 1000

export interface ReencryptTableResult {
  table: 'environment_variables' | 'app_settings' | 'outcome_writeback_deadletters' | 'service_connections'
  checked: number
  alreadyCurrent: number
  /** Rows re-locked, or on a preview, rows that would be. */
  relocked: number
  /** Names of values no key in the ring can open. Left untouched. */
  undecryptable: string[]
  /** Names of values that changed between this pass's read and its write. */
  changedMeanwhile: string[]
}

export interface ReencryptResult {
  dryRun: boolean
  /** True when every stored value is, or on a preview would be, readable by the lock key alone. */
  ok: boolean
  tables: ReencryptTableResult[]
}

interface StoredValue {
  name: string
  value: string
  /** Writes the new value only if the row still holds `value`; resolves to rows changed. */
  write: (next: string) => Promise<number>
}

async function opensWith(value: string, key: string): Promise<boolean> {
  try {
    await decryptSecret(value, key)
    return true
  } catch {
    return false
  }
}

async function relockAll(
  table: ReencryptTableResult['table'],
  stored: StoredValue[],
  keys: SecretKeys,
  dryRun: boolean,
): Promise<ReencryptTableResult> {
  const result: ReencryptTableResult = {
    table,
    checked: stored.length,
    alreadyCurrent: 0,
    relocked: 0,
    undecryptable: [],
    changedMeanwhile: [],
  }
  for (const row of stored) {
    if (await opensWith(row.value, keys.encryptWith)) {
      result.alreadyCurrent++
      continue
    }
    let plaintext: string
    try {
      plaintext = await decryptSecret(row.value, keys)
    } catch {
      result.undecryptable.push(row.name)
      continue
    }
    const relocked = await encryptSecret(plaintext, keys)
    // Refuse to write anything the lock key cannot read back to the same value.
    if ((await decryptSecret(relocked, keys.encryptWith)) !== plaintext) {
      throw new Error(`re-locked value for ${row.name} did not read back`)
    }
    if (dryRun) {
      result.relocked++
      continue
    }
    const changed = await row.write(relocked)
    if (changed === 1) result.relocked++
    else result.changedMeanwhile.push(row.name)
  }
  return result
}

function checkRead<T>(table: string, res: { data: T[] | null; error: { message: string } | null }): T[] {
  if (res.error) throw new Error(`reading ${table} failed: ${res.error.message}`)
  const rows = res.data ?? []
  if (rows.length >= ROW_CAP) throw new Error(`reading ${table} returned ${rows.length} rows, the cap, so some may be missing`)
  return rows
}

/**
 * How many rows a conditional write changed. Matching no row is expected (the
 * value changed since it was read) and answers 0; a real database error throws,
 * so it can never read as a row changed meanwhile.
 */
function rowsChanged(target: string, result: Awaited<ReturnType<typeof requireRowsAffected>>): number {
  if (result.error && result.error.code !== NO_ROW_MATCHED_CODE) {
    throw new Error(`writing ${target} failed: ${result.error.message}`)
  }
  return result.rows.length
}

export async function reencryptSecrets(
  supabase: SupabaseClient,
  keys: SecretKeys,
  /** `actorId`: the signed in user running it, named on the service_connections audit row. */
  opts: { dryRun: boolean; actorId?: string },
): Promise<ReencryptResult> {
  const envRows = checkRead(
    'environment_variables',
    (await supabase.from('environment_variables').select('id, key, value').eq('is_secret', true)) as {
      data: { id: string; key: string; value: string | null }[] | null
      error: { message: string } | null
    },
  )
  const envStored: StoredValue[] = envRows
    .filter((r) => r.value)
    .map((r) => ({
      name: r.key,
      value: r.value as string,
      write: async (next) =>
        rowsChanged(
          'environment_variables.value',
          await requireRowsAffected(
            'environment_variables.value',
            () =>
              supabase
                .from('environment_variables')
                .update({ value: next })
                .eq('id', r.id)
                .eq('value', r.value as string)
                .select('id'),
            { onMiss: 'silent' },
          ),
        ),
    }))

  const settingRows = checkRead(
    'app_settings',
    (await supabase.from('app_settings').select('organization_id, key, value_encrypted')) as {
      data: { organization_id: string; key: string; value_encrypted: string | null }[] | null
      error: { message: string } | null
    },
  )
  const settingStored: StoredValue[] = settingRows
    .filter((r) => r.value_encrypted)
    .map((r) => ({
      name: r.key,
      value: r.value_encrypted as string,
      write: async (next) =>
        rowsChanged(
          'app_settings.value_encrypted',
          await requireRowsAffected(
            'app_settings.value_encrypted',
            () =>
              supabase
                .from('app_settings')
                .update({ value_encrypted: next })
                .eq('organization_id', r.organization_id)
                .eq('key', r.key)
                .eq('value_encrypted', r.value_encrypted as string)
                .select('key'),
            { onMiss: 'silent' },
          ),
        ),
    }))

  // The failed writes held for replay (#1993). Each encrypted column is its own
  // stored value, written only while that column still holds what was read, so a
  // replay updating the row meanwhile is never overwritten with an older value.
  const WRITEBACK_COLUMNS = ['body_encrypted', 'error_encrypted', 'last_error_encrypted'] as const
  type WritebackColumn = (typeof WRITEBACK_COLUMNS)[number]
  // PAGED, unlike the two tables above: an outage can leave thousands of failed
  // writes here, and refusing at the row cap would stall the rotation with the
  // old key still needed. maxPages makes a read that cannot finish throw rather
  // than re-lock a part and report the rest current.
  const writebackRows = await fetchAllPaged<{ id: string } & Record<WritebackColumn, string | null>>(
    (from, to) =>
      supabase
        .from('outcome_writeback_deadletters')
        .select('id, body_encrypted, error_encrypted, last_error_encrypted')
        .order('id')
        .range(from, to),
    'reading outcome_writeback_deadletters',
    { maxPages: 200 },
  )
  const writebackStored: StoredValue[] = writebackRows.flatMap((r) =>
    WRITEBACK_COLUMNS.filter((col) => r[col]).map((col) => ({
      name: `${r.id}.${col}`,
      value: r[col] as string,
      write: async (next: string) =>
        rowsChanged(
          `outcome_writeback_deadletters.${col}`,
          await requireRowsAffected(
            `outcome_writeback_deadletters.${col}`,
            () =>
              supabase
                .from('outcome_writeback_deadletters')
                .update({ [col]: next })
                .eq('id', r.id)
                .eq(col, r[col] as string)
                .select('id'),
            { onMiss: 'silent' },
          ),
        ),
    })),
  )

  // The sealed Slack bot token (#2331). Only bidding_ring rows, stated in the
  // read and again in the write's WHERE, so an ops_key row is never touched.
  const connectionRows = checkRead(
    'service_connections',
    (await supabase.from('service_connections').select('id, credential_enc').eq('sealed_for', 'bidding_ring')) as {
      data: { id: string; credential_enc: string | null }[] | null
      error: { message: string } | null
    },
  )
  const connectionStored: StoredValue[] = connectionRows
    .filter((r) => r.credential_enc)
    .map((r) => ({
      name: r.id,
      value: r.credential_enc as string,
      write: async (next) =>
        rowsChanged(
          'service_connections.credential_enc',
          await requireRowsAffected(
            'service_connections.credential_enc',
            () =>
              supabase
                .from('service_connections')
                .update({ credential_enc: next, ...(opts.actorId ? { updated_by: opts.actorId } : {}) })
                .eq('id', r.id)
                .eq('sealed_for', 'bidding_ring')
                .eq('credential_enc', r.credential_enc as string)
                .select('id'),
            { onMiss: 'silent' },
          ),
        ),
    }))

  const tables = [
    await relockAll('environment_variables', envStored, keys, opts.dryRun),
    await relockAll('app_settings', settingStored, keys, opts.dryRun),
    await relockAll('outcome_writeback_deadletters', writebackStored, keys, opts.dryRun),
    await relockAll('service_connections', connectionStored, keys, opts.dryRun),
  ]
  const ok = tables.every((t) => t.undecryptable.length === 0 && t.changedMeanwhile.length === 0)
  return { dryRun: opts.dryRun, ok, tables }
}
