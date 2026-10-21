/**
 * The connection check every workflow definition writer asks before it writes
 * (#2338, build PR 7; R9): create, save, duplicate and version restore in
 * routes/api/workflows.ts, and the switch on (PATCH, #2576, build PR 9), which
 * writes no definition but makes the stored one live, so the trigger below
 * (which fires on a write of the definition) never judges it.
 *
 * A step names a connection by its id. Once a connection is removed (or when an
 * id is another organization's connection) a definition naming it would fail on
 * every run, so a write naming one is refused, by name, with what to do: give
 * the step a replacement connection.
 *
 * What counts as naming a connection is not decided here. The database holds
 * the one predicate (definition_connection_ids, which connection_references,
 * the Remove refusal's reader, also reads; L342, L370), and its
 * definition_connection_problems answers which ids are a problem. This module
 * only asks it and words the answer.
 *
 * The guarantee is the database trigger workflows_refuse_missing_connections,
 * which judges every write in its own transaction and holds the named
 * connections FOR KEY SHARE, so a save and a removal cannot pass each other's
 * check. Asking first is what lets a route refuse before it writes anything (a
 * save writes a version snapshot before the workflow row) and name the
 * connections; connectionRefusalOfWriteError reads the trigger's own refusal
 * for the save that lost the race to a removal.
 *
 * Never unchecked: a function that is missing (this code deployed before its
 * migration was applied, L640), a lookup that failed, or an answer this module
 * cannot read each refuse the save with their own named code, never pass it.
 */
import type { createSupabaseClient } from './supabase'
import { formatErr } from './format-error'

export const WORKFLOW_CONNECTION_REFUSAL_CODES = [
  /** The definition names a connection that was removed, or one of another organization. */
  'workflow_connection_missing',
  /** definition_connection_problems does not exist yet: its migration is not applied. */
  'workflow_connection_check_unavailable',
  /** The check was asked and did not answer in a form that can be trusted. */
  'workflow_connection_check_failed',
] as const
export type WorkflowConnectionRefusalCode = (typeof WORKFLOW_CONNECTION_REFUSAL_CODES)[number]

export interface MissingConnection {
  id: string
  /** removed: a tombstone of this organization and no live row. not_this_organization: another organization's, live or removed. */
  problem: 'removed' | 'not_this_organization'
  /** The removed connection's name as its removal recorded it; null when lost, and always for another organization's. */
  name: string | null
  /** The steps (node namespaces) whose config names it; empty when it sits outside every step. */
  steps: string[]
}

export interface ConnectionCheckRefusal {
  status: 409 | 503
  body: { error: string; code: WorkflowConnectionRefusalCode; missing_connections?: MissingConnection[] }
}

type Client = Pick<ReturnType<typeof createSupabaseClient>, 'rpc'>

/** "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function connectionPhrase(m: MissingConnection): string {
  if (m.problem === 'not_this_organization') return `a connection that is not one of this organization's (${m.id})`
  return m.name ? `the connection "${m.name}", which was removed` : `a connection that was removed (${m.id})`
}

function itemSentence(m: MissingConnection): string {
  if (m.steps.length === 0) return `This workflow names ${connectionPhrase(m)}.`
  if (m.steps.length === 1) return `The step ${m.steps[0]} names ${connectionPhrase(m)}.`
  return `The steps ${listed(m.steps)} name ${connectionPhrase(m)}.`
}

/** What the refused request was doing: a save of a definition (every writer), or switching a workflow on. */
export type ConnectionCheckedAction = 'save' | 'switch_on'

/** The refusal's first sentence, saying what did not happen. */
const NOT_DONE: Readonly<Record<ConnectionCheckedAction, string>> = {
  save: 'Nothing was saved.',
  switch_on: 'The workflow was not switched on.',
}

/** The refusal for the connections named: each one, where it is named, and what to do. */
export function missingConnectionsSentence(missing: readonly MissingConnection[], action: ConnectionCheckedAction = 'save'): string {
  const then = action === 'save' ? 'then save again' : 'then switch the workflow on'
  const give = action === 'save' ? 'a replacement connection' : 'a replacement connection and save it'
  if (missing.length === 0) {
    return `${NOT_DONE[action]} This workflow names a connection that was removed while it was being ${action === 'save' ? 'saved' : 'switched on'}. Give its step ${give}, ${then}.`
  }
  const steps = new Set(missing.flatMap((m) => m.steps))
  const todo = steps.size === 0
    ? `Replace ${missing.length === 1 ? 'it' : 'them'} with a connection of this organization${action === 'save' ? '' : ' and save'}, ${then}.`
    : steps.size === 1 ? `Give the step ${give}, ${then}.` : `Give each of those steps ${give}, ${then}.`
  return `${NOT_DONE[action]} ${missing.map(itemSentence).join(' ')} ${todo}`
}

const SENTENCES: { readonly [C in Exclude<WorkflowConnectionRefusalCode, 'workflow_connection_missing'>]: (action: ConnectionCheckedAction) => string } = {
  workflow_connection_check_unavailable: (action) =>
    `${NOT_DONE[action]} Bidspoke could not check that every connection this workflow names still exists, because the database does not have that check yet. Tell Dan, since ${action === 'save' ? 'saving' : 'switching on'} works again once the database update is applied.`,
  workflow_connection_check_failed: (action) =>
    `${NOT_DONE[action]} Bidspoke could not check that every connection this workflow names still exists, because the database did not answer. ${action === 'save' ? 'Save' : 'Switch it on'} again in a minute.`,
}

function refusal(code: Exclude<WorkflowConnectionRefusalCode, 'workflow_connection_missing'>, action: ConnectionCheckedAction): ConnectionCheckRefusal {
  return { status: 503, body: { error: SENTENCES[code](action), code } }
}

function missingRefusal(missing: MissingConnection[], action: ConnectionCheckedAction = 'save'): ConnectionCheckRefusal {
  return { status: 409, body: { error: missingConnectionsSentence(missing, action), code: 'workflow_connection_missing', missing_connections: missing } }
}

/** One answered row, or null when it is not of the shape the function returns. */
function readRow(row: unknown, idKey: 'connection_id' | 'id'): MissingConnection | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const id = r[idKey]
  if (typeof id !== 'string' || id === '') return null
  if (r.problem !== 'removed' && r.problem !== 'not_this_organization') return null
  if (r.name !== null && typeof r.name !== 'string') return null
  if (!Array.isArray(r.steps) || r.steps.some((s) => typeof s !== 'string')) return null
  return { id, problem: r.problem, name: r.problem === 'removed' ? r.name : null, steps: r.steps as string[] }
}

function readRows(data: unknown, idKey: 'connection_id' | 'id'): MissingConnection[] | null {
  if (!Array.isArray(data)) return null
  const rows = data.map((row) => readRow(row, idKey))
  return rows.every((r): r is MissingConnection => r !== null) ? rows : null
}

/** PostgREST's "no such function" (PGRST202), and Postgres's own (42883). */
function isMissingFunction(error: { code?: unknown }): boolean {
  return error.code === 'PGRST202' || error.code === '42883'
}

/**
 * Asks whether the definition about to be written (or, switching on, made live)
 * names a connection that is not a live one of the organization. null: it
 * names none, go ahead. Otherwise the refusal to answer, worded for the
 * action, and nothing may be written.
 */
export async function checkDefinitionConnections(supabase: Client, orgId: string, definition: unknown, action: ConnectionCheckedAction = 'save'): Promise<ConnectionCheckRefusal | null> {
  let answer: { data: unknown; error: unknown }
  try {
    answer = await supabase.rpc('definition_connection_problems', { p_organization_id: orgId, p_definition: definition as never })
  } catch (err) {
    console.error(JSON.stringify({ event: 'workflow_connection_check_failed', organization_id: orgId, error: formatErr(err) }))
    return refusal('workflow_connection_check_failed', action)
  }
  if (answer.error) {
    const error = answer.error as { code?: unknown }
    const code = isMissingFunction(error) ? 'workflow_connection_check_unavailable' : 'workflow_connection_check_failed'
    console.error(JSON.stringify({ event: code, organization_id: orgId, error: formatErr(answer.error) }))
    return refusal(code, action)
  }
  const missing = readRows(answer.data, 'connection_id')
  if (missing === null) {
    console.error(JSON.stringify({ event: 'workflow_connection_check_failed', organization_id: orgId, error: 'the check answered rows this route cannot read' }))
    return refusal('workflow_connection_check_failed', action)
  }
  if (missing.length === 0) return null
  console.warn(JSON.stringify({ event: 'workflow_connection_refused', organization_id: orgId, connections: missing.map((m) => ({ id: m.id, problem: m.problem })) }))
  return missingRefusal(missing, action)
}

/**
 * The trigger's refusal of a write (BP409 workflow_names_missing_connection,
 * the problems as JSON in its detail), or null for any other error. A write
 * reaches it only when a removal committed between the route's own check and
 * the write, so it is answered exactly as the check's refusal is; a detail that
 * cannot be read still refuses, without names.
 */
export function connectionRefusalOfWriteError(error: unknown): ConnectionCheckRefusal | null {
  const e = error as { code?: unknown; message?: unknown; details?: unknown } | null
  if (!e || e.code !== 'BP409' || e.message !== 'workflow_names_missing_connection') return null
  let parsed: unknown
  try {
    parsed = typeof e.details === 'string' ? JSON.parse(e.details) : null
  } catch {
    parsed = null
  }
  const missing = readRows(parsed, 'id') ?? []
  console.warn(JSON.stringify({ event: 'workflow_connection_refused_at_write', connections: missing.map((m) => ({ id: m.id, problem: m.problem })) }))
  return missingRefusal(missing)
}
