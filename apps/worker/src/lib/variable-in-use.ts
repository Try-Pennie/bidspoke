/**
 * Which live workflows a change to one environment variable row would break
 * (#3001, phase 5 of #2982). Dan's decision of 2026-10-29: deleting a
 * variable, or emptying its value, is refused while any live workflow reads
 * it, naming each of them. Making it secret changes nothing for a workflow. A
 * rename is refused the same way as a delete until #2996 (references by id)
 * ships. Every lane, money and ops, since a money run reading a deleted
 * variable breaks too.
 *
 * LIVE means switched on and not soft deleted, read through the one scoped
 * workflows read (readOrgWorkflows, activeOnly). READS means the workflow's
 * definition names the key (envReferences). BREAKS means the workflow is given
 * a value for the key now and would be given none once this row stops giving
 * one, by the one resolver (resolveVariables, whose reach rule is rowReach):
 * an organization row reaches every workflow without its own row for the key,
 * a workflow's own row reaches that workflow alone, and a row with no value
 * gives nothing. Deleting, emptying and renaming each stop the row giving a
 * value under its key, so the one judgement serves all three.
 *
 * WHOSE DATA. One organization's: both reads filter on it and drop a row of any
 * other (org-workflows.ts, current-variables.ts). A failed read throws, so the
 * route answers an error and never lets the change through unchecked.
 *
 * A workflow switched on, or saved to read the key, between this check and the
 * write is not seen. The check is a refusal for the person at the page, not a
 * lock; an ops run still refuses a missing variable by name (ops/run-walk.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { readOrgWorkflows } from './org-workflows'
import { readCurrentVariableRows } from './current-variables'
import { envReferences } from './definition-env-references'
import { resolveVariables, type ResolvableRow } from './resolve-variables'

/** A saved row as the judgement reads it. The value is the stored one: text, ciphertext or none. */
export interface VariableRow extends ResolvableRow {
  id: string
}

/** A live workflow: its id, its name, and its definition as stored. */
export interface LiveWorkflow {
  id: string
  name: string
  definition: unknown
}

export interface WorkflowNamed {
  id: string
  name: string
}

/** The change a refusal is about, for its wording. */
export type VariableChange = 'delete' | 'empty' | 'rename'

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The live workflows that read `row.key` and would lose their value for it if
 * `row` stopped giving one, ordered by name. `rows` is every saved row of the
 * organization under that key, in the order saved, `row` among them.
 */
export function workflowsLosingVariable(
  row: VariableRow, rows: readonly VariableRow[], workflows: readonly LiveWorkflow[],
): WorkflowNamed[] {
  const without = rows.filter((r) => r.id !== row.id)
  const losing: WorkflowNamed[] = []
  for (const workflow of workflows) {
    // A definition that is not an object cannot run, so it reads nothing.
    if (!isRecord(workflow.definition)) continue
    if (!envReferences(workflow.definition).includes(row.key)) continue
    const givenNow = resolveVariables(rows, workflow.id, [row.key]).has(row.key)
    const givenAfter = resolveVariables(without, workflow.id, [row.key]).has(row.key)
    if (givenNow && !givenAfter) losing.push({ id: workflow.id, name: workflow.name })
  }
  return losing.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/**
 * The organization's live workflows that `row` stopping giving its value would
 * break. Reads the live workflows first, and the rows under the key only when
 * one of them reads it. Throws on a failed read, never answering an empty list.
 */
export async function liveWorkflowsLosingVariable(
  supabase: SupabaseClient, orgId: string, row: VariableRow,
): Promise<WorkflowNamed[]> {
  const workflows = await readOrgWorkflows(supabase, orgId, { activeOnly: true })
  const readers = workflows.filter((w) => isRecord(w.definition) && envReferences(w.definition).includes(row.key))
  if (readers.length === 0) return []
  const rows = await readCurrentVariableRows(supabase, orgId, [row.key], `the environment variables named ${row.key}`)
  return workflowsLosingVariable(row, rows, readers)
}

const REFUSED: Record<VariableChange, string> = {
  delete: 'Not deleted.',
  empty: 'Not saved.',
  rename: 'Not saved.',
}

const CANNOT: Record<VariableChange, string> = {
  delete: 'cannot be deleted',
  empty: 'cannot be emptied',
  rename: 'cannot be renamed',
}

/** The refusal's sentence: the variable and each live workflow reading it, by name, never a value. */
export function variableInUseMessage(change: VariableChange, key: string, workflows: readonly WorkflowNamed[]): string {
  const one = workflows.length === 1
  const names = workflows.map((w) => w.name).join(', ')
  return `${REFUSED[change]} ${key} ${CANNOT[change]} while ${one ? 'the live workflow' : 'these live workflows'} ${one ? 'reads' : 'read'} it: ${names}.`
}
