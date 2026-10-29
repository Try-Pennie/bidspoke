/**
 * The CURRENT values of the environment variables an ops workflow reads (#2982;
 * Dan's decisions of 2026-10-28, "It should always read the current version of
 * the variable", and 2026-10-29, "Yes, ops reads secrets"), read from the
 * bidding database and resolved by the one resolver (resolve-variables.ts).
 *
 * The one reading and decrypting code for both readers: the ops gateway's run
 * variables (ops-gateway.ts readOpsRunVariables, #2997) and the canvas's ops
 * step test (routes/api/ops-step-test.ts, #3002). Each derives the names it
 * asks for from a saved or tested definition (envReferences), never from what a
 * caller names.
 *
 * WHOSE DATA. One organization's rows alone: the query filters on it, and a
 * row of any other that comes back anyway is dropped and logged by name.
 *
 * SECRETS. Each secret row is decrypted through the key ring (secretKeys(env)),
 * at most once however many workflows read it. One that will not decrypt is
 * named in unreadable, never answered blank or as ciphertext. Nothing here
 * logs a value, only names.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPaged } from './paginate'
import { resolveVariables } from './resolve-variables'
import { decryptSecret, type SecretKeyInput } from './secret-crypto'

/** One saved environment variable row, as the readers need it. */
export interface CurrentVariableRow {
  id: string
  organization_id: string
  key: string
  value: string | null
  is_secret: boolean
  scope: string
  workflow_id: string | null
}

/** One workflow's current variables: plain values, decrypted secret values, and the secrets that would not decrypt. */
export interface ResolvedCurrentVariables {
  values: Record<string, string>
  secretValues: Record<string, string>
  unreadable: string[]
}

/** The most pages of rows one read takes, 1,000 a page: far above the 62 an organization holds today. */
const MAX_PAGES = 5

/**
 * The organization's saved rows of the names given, in the order they were
 * saved (created_at, then id), the order the resolver needs. Throws on a failed
 * read, never answering an empty set. No names reads nothing.
 */
export async function readCurrentVariableRows(
  supabase: SupabaseClient, organizationId: string, names: readonly string[], label: string,
): Promise<CurrentVariableRow[]> {
  if (names.length === 0) return []
  const rows = await fetchAllPaged<CurrentVariableRow>(
    (from, to) => supabase
      .from('environment_variables')
      .select('id, organization_id, key, value, is_secret, scope, workflow_id')
      .eq('organization_id', organizationId)
      .in('key', [...names])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
    label,
    { maxPages: MAX_PAGES },
  )
  return rows.filter((row) => {
    if (row.organization_id === organizationId) return true
    console.error(`[current-variables] ${label} returned ${row.key} of another organization; dropped, because the query's scoping did not hold`)
    return false
  })
}

/** Decrypts a secret row through the key ring, each row at most once; null when it will not decrypt. */
export function secretOpener(keys: SecretKeyInput): (row: CurrentVariableRow) => Promise<string | null> {
  const opened = new Map<string, Promise<string | null>>()
  return (row) => {
    let held = opened.get(row.id)
    if (held === undefined) {
      held = decryptSecret(row.value as string, keys).catch(() => null)
      opened.set(row.id, held)
    }
    return held
  }
}

/**
 * The current variables a run or test of `workflowId` reads, of the names
 * given, over rows from readCurrentVariableRows: each resolved by the one
 * resolver, a plain one under values, a secret one decrypted under
 * secretValues, and one that will not decrypt named in unreadable. A name with
 * no saved value is left out, so its reader names it missing.
 */
export async function resolveCurrentVariables(
  rows: readonly CurrentVariableRow[], workflowId: string, names: readonly string[], open: (row: CurrentVariableRow) => Promise<string | null>,
): Promise<ResolvedCurrentVariables> {
  const values: Record<string, string> = {}
  const secretValues: Record<string, string> = {}
  const unreadable: string[] = []
  for (const [name, row] of resolveVariables(rows, workflowId, names)) {
    if (!row.is_secret) {
      values[name] = row.value as string
      continue
    }
    const plain = await open(row)
    if (plain === null) unreadable.push(name)
    else secretValues[name] = plain
  }
  return { values, secretValues, unreadable }
}

/**
 * The same resolution as resolveCurrentVariables, with each secret by NAME
 * only (#3034, the ops copy refresh): no secret row is opened, so whether one
 * would decrypt is not known here, and its value never leaves the database row.
 */
export function resolveCurrentVariableNames(
  rows: readonly CurrentVariableRow[], workflowId: string, names: readonly string[],
): { values: Record<string, string>; secretKeys: string[] } {
  const values: Record<string, string> = {}
  const secretKeys: string[] = []
  for (const [name, row] of resolveVariables(rows, workflowId, names)) {
    if (row.is_secret) secretKeys.push(name)
    else values[name] = row.value as string
  }
  return { values, secretKeys }
}
