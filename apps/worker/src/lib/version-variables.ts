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
 * same reading the ops run refuses by), each resolved by the one resolver
 * (resolve-variables.ts, #2997): the organization's value with the workflow's own laid over
 * it, the later saved of two organization rows winning, a row saved for
 * another workflow or a workflow's own value of an organization only key never
 * reaching it. A plain variable is served by its value, a secret one by its
 * name alone (decision 1: an ops run never receives a secret), and one with no
 * row is left out, so the run names it as missing. A version saved before
 * variables were kept serves null.
 */
import { envReferences, ENV_KEY } from './definition-env-references'
import { resolveVariables } from './resolve-variables'
import type { ServedOpsVariables } from './ops-gateway-contract'

interface CapturedRow {
  key: string
  value: string | null
  is_secret: boolean
  scope: string
  workflow_id: string | null
}

/** A kept secret's stand in value while resolving: present, and never text that could be served. */
const SECRET_KEPT_BY_NAME = Symbol('a secret kept by name')

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
  const rows = capture.map((raw) => {
    const row = capturedRow(raw)
    if (row === null) throw new Error(`the variables kept with ${versionName} hold a row that is not a saved variable`)
    // The capture keeps a secret by name, its value left out, so for the
    // resolver it stands in as present: a workflow's own secret still withholds
    // the organization's plain value of the same name. Never served.
    return row.is_secret ? { ...row, value: SECRET_KEPT_BY_NAME } : row
  })
  const served: ServedOpsVariables = { values: {}, secret_keys: [] }
  // The one resolver (resolve-variables.ts) applies the precedence rules; the
  // capture is in saved order, as the rules require.
  for (const [key, row] of resolveVariables(rows, workflowId, envReferences(definition))) {
    if (row.is_secret) served.secret_keys.push(key)
    else served.values[key] = row.value as string
  }
  return served
}
