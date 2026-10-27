/**
 * Replace (#2338, build PR 12; R20, D20): what POST /api/connections/:id/replace
 * reads from its body, how it rewrites one connection's id in a workflow
 * definition, and what each ticked workflow came to.
 *
 * The rewrite follows the database's one predicate of what names a connection,
 * definition_connection_ids (migration 20261020220000): every string VALUE of
 * the definition, at any depth and under any key, compared lower cased and
 * trimmed. So it replaces exactly the strings that predicate reads as the old
 * id, and after it connection_references finds the workflow no longer using
 * the old connection (L342: the same question, the same rule). A longer string
 * that merely holds the id (a script, a note) is not a reference by that
 * predicate and is left as it is.
 *
 * The writes themselves are the route's (routes/api/connections.ts), through
 * writeWorkflow, where the guards that read every definition writer can see
 * them.
 */

/**
 * The most workflows one Replace may name. An organization holds 36 workflows,
 * 11 not deleted (measured 2026-10-19, CONFIG_LIST_BOUNDS), and each costs the
 * request about eight calls (its read, the connection check, the save, the
 * stored copy and the audit row), so 100 keeps a whole Replace inside the
 * Worker's limit on calls per request with room to spare.
 */
export const REPLACE_WORKFLOWS_MAX = 100

/**
 * How many times one workflow's save is tried when someone else's save lands
 * between its read and its write. Each try reads the workflow again and makes
 * the change on top of theirs, so nothing they saved is lost; a workflow saved
 * that often while Replace runs is left as they saved it, and named.
 */
export const REPLACE_SAVE_ATTEMPTS = 3

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type ReplaceBody = { ok: true; with: string; workflows: string[] } | { ok: false; code: 'replace_body_invalid' | 'replace_too_many' }

const idOf = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const id = v.trim().toLowerCase()
  return UUID.test(id) ? id : null
}

/** { with, workflows }: the connection to use instead and the ticked workflows, by id. Nothing else may be named. */
export function readReplaceBody(raw: unknown): ReplaceBody {
  const invalid = { ok: false, code: 'replace_body_invalid' } as const
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid
  const body = raw as Record<string, unknown>
  if (Object.keys(body).some((k) => k !== 'with' && k !== 'workflows')) return invalid
  const replacement = idOf(body.with)
  if (!replacement || !Array.isArray(body.workflows) || body.workflows.length === 0) return invalid
  const ids = body.workflows.map(idOf)
  if (ids.some((id) => id === null)) return invalid
  const workflows = [...new Set(ids as string[])]
  if (workflows.length > REPLACE_WORKFLOWS_MAX) return { ok: false, code: 'replace_too_many' }
  return { ok: true, with: replacement, workflows }
}

/**
 * The definition with every string naming `from` (as definition_connection_ids
 * reads it) replaced by `to`, and how many were. Never changes its argument;
 * returns the argument itself when nothing names `from`.
 */
export function replaceConnectionId(definition: unknown, from: string, to: string): { definition: unknown; replaced: number } {
  const target = from.trim().toLowerCase()
  let replaced = 0
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v.trim().toLowerCase() !== target) return v
      replaced += 1
      return to
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  const next = walk(definition)
  return replaced === 0 ? { definition, replaced } : { definition: next, replaced }
}

/**
 * What one ticked workflow came to:
 * - replaced: it has a new version naming the replacement;
 * - not_using: it no longer names the connection (already replaced, taken out
 *   since, or never one of this organization's), so there was nothing to do;
 * - deleted: it is soft deleted, so it cannot get a new version (no route
 *   writes a deleted workflow);
 * - changed: someone else saved it on every try, so it is as they saved it;
 * - refused: nothing was written, `why` saying why;
 * - failed: the save did not answer in a way that says whether it was written.
 */
export const REPLACE_OUTCOMES = ['replaced', 'not_using', 'deleted', 'changed', 'refused', 'failed'] as const
export type ReplaceOutcome = (typeof REPLACE_OUTCOMES)[number]

/**
 * Why a workflow was not given a new version, nothing written:
 * - replacement_removed: the replacement was removed while Replace ran;
 * - names_removed_connection: the workflow also names a connection that was
 *   removed, so no new version of it can be saved until that step is fixed;
 * - check_failed: the connection check could not be made;
 * - unreadable: the workflow could not be read;
 * - write_refused: write_workflow refused the call as malformed, a fault in Bidspoke.
 */
export type ReplaceRefusal = 'replacement_removed' | 'names_removed_connection' | 'check_failed' | 'unreadable' | 'write_refused'

export interface ReplacedWorkflow {
  id: string
  /** Null for a workflow that does not name the connection, which is never read, so an id of another organization learns nothing. */
  name: string | null
  outcome: ReplaceOutcome
  /** The new version, for replaced. */
  version?: number
  /** For refused. */
  why?: ReplaceRefusal
}

/** Whether every ticked workflow names the replacement now, newly or already. */
export function replaceComplete(workflows: readonly ReplacedWorkflow[]): boolean {
  return workflows.every((w) => w.outcome === 'replaced' || w.outcome === 'not_using')
}
