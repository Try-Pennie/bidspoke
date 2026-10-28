/**
 * What an ops workflow version serves of the environment variables kept with
 * it (#2702, Dan's decisions of 2026-10-28).
 *
 * WHAT IS KEPT. When an ops lane version is written, the database copies into
 * workflow_versions.env_capture every saved row that version's runs could
 * read whose name the definition mentions (the trigger
 * capture_version_env_variables): each organization row, and each row saved
 * for the workflow itself, with a secret's value left out. So a version holds
 * the values as they were at its save, a change to a variable takes effect at
 * the next save, and a run never reads the bidding database for them.
 *
 * WHAT IS SERVED. Only the variables the definition reads (envReferences, the
 * same reading the ops run refuses by), each resolved by the env loader's own
 * rules (rowReach): the organization's value with the workflow's own laid over
 * it, the later saved of two organization rows winning, a row saved for
 * another workflow or a workflow's own value of an organization only key never
 * reaching it. A plain variable is served by its value, a secret one by its
 * name alone (decision 1: an ops run never receives a secret), and one with no
 * row is left out, so the run names it as missing. A version saved before
 * variables were kept serves null.
 */
import { envReferences, ENV_KEY } from './definition-env-references'
import { rowReach } from './env-loader'
import type { ServedOpsVariables } from './ops-gateway-contract'

interface CapturedRow {
  key: string
  value: string | null
  is_secret: boolean
  scope: string
  workflow_id: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function capturedRow(raw: unknown): CapturedRow | null {
  if (!isRecord(raw)) return null
  const { key, value, is_secret, scope, workflow_id } = raw
  if (typeof key !== 'string' || !ENV_KEY.test(key) || typeof is_secret !== 'boolean' || typeof scope !== 'string') return null
  if (!(workflow_id === null || typeof workflow_id === 'string')) return null
  // A secret's value is never kept; a plain one always is.
  if (is_secret ? value !== null : typeof value !== 'string') return null
  return { key, value: value as string | null, is_secret, scope, workflow_id }
}

/**
 * The variables a version serves, or null for one saved before they were
 * kept. Throws, naming the version, on a capture it cannot read, rather than
 * serving a guess.
 */
export function servedVersionVariables(
  capture: unknown, workflowId: string, definition: Record<string, unknown>, versionName: string,
): ServedOpsVariables | null {
  if (capture === null || capture === undefined) return null
  if (!Array.isArray(capture)) throw new Error(`the variables kept with ${versionName} are not a list of saved variables`)
  const orgRows = new Map<string, CapturedRow>()
  const ownRows = new Map<string, CapturedRow>()
  for (const raw of capture) {
    const row = capturedRow(raw)
    if (row === null) throw new Error(`the variables kept with ${versionName} hold a row that is not a saved variable`)
    // An empty value is no value, as the env loader skips it, so the run names it missing rather than send a blank.
    if (row.value === '') continue
    const reach = rowReach(row)
    // Later rows win, as the env loader reads them in the order they were saved.
    if (reach === 'org') orgRows.set(row.key, row)
    else if (reach === 'workflow' && row.workflow_id === workflowId) ownRows.set(row.key, row)
  }
  const served: ServedOpsVariables = { values: {}, secret_keys: [] }
  for (const key of envReferences(definition)) {
    const row = ownRows.get(key) ?? orgRows.get(key)
    if (row === undefined) continue
    if (row.is_secret) served.secret_keys.push(key)
    else served.values[key] = row.value as string
  }
  return served
}
