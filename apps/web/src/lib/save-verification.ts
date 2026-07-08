/**
 * Read-back verification for the canvas save (#569).
 *
 * A save that returns HTTP 200 does not, on its own, prove the definition
 * reached the database. A silent no-op, a concurrent overwrite, or a partial
 * write can all still report success. After a save the canvas re-fetches the
 * workflow and calls `definitionsMatch(sent, persisted)` to confirm the stored
 * definition is the one it just sent. A mismatch is surfaced as a loud error
 * instead of a false "Saved".
 *
 * The stored definition comes back as Postgres `jsonb`, which does NOT preserve
 * object key insertion order, so this compare canonicalizes by sorting object
 * keys recursively (array order is preserved, since node/edge order matters).
 */
export function definitionsMatch(sent: unknown, persisted: unknown): boolean {
  return stableStringify(sent) === stableStringify(persisted)
}

export type SaveVerdict = 'saved' | 'no_changes' | 'unverified'

/**
 * The pure post-save decision (#569). Turns the save response plus a read-back
 * fetch into one loud, distinct outcome:
 *  - 'no_changes'  the server short-circuited a no-op save (definition identical
 *                  to what's stored), so the edit never reached the payload.
 *  - 'unverified'  the read-back succeeded but returned a DIFFERENT definition
 *                  than we sent: the server did not persist our changes.
 *  - 'saved'       the read-back confirmed the persisted definition, OR the
 *                  read-back itself failed (inconclusive, so we don't reverse a
 *                  genuine 200 with a false failure).
 * `persisted` is null when the verification fetch could not be read back.
 */
export function classifySave(params: {
  noChanges: boolean
  sentDefinition: unknown
  persisted: { definition: unknown } | null
}): SaveVerdict {
  if (params.noChanges) return 'no_changes'
  if (params.persisted === null) return 'saved'
  return definitionsMatch(params.sentDefinition, params.persisted.definition) ? 'saved' : 'unverified'
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalize(obj[key])
    }
    return out
  }
  return value
}
