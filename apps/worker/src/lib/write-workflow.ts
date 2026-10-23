/**
 * writeWorkflow (#1947): the Worker's one way to write a workflow.
 *
 * Every write of a workflow's definition, is_active, lane or deleted_at, and
 * every version snapshot, goes through the write_workflow database function
 * (migration 20261023120000): create, duplicate, save, restore, patch (switch
 * on or off, move to a folder) and soft delete. The function locks the row,
 * compares the version the caller read with the stored one and refuses a stale
 * write by name, writes a save's or restore's snapshot in the same
 * transaction, and decides a copied definition's stamp itself. A database
 * guard, not this module, is what keeps any other writer out (the contract
 * migration that follows revokes service_role's direct writes).
 *
 * Every answer of the function is one kind here, so a route handles each:
 * written, stale (409 with the current row), not_found (what was missing),
 * connection_refused (the #2338 trigger's refusal, by name), refused (a call
 * the function judged malformed) and failed (anything else, never thrown).
 */
import type { createSupabaseClient } from './supabase'
import type { Database, Json } from '../types/database'
import { connectionRefusalOfWriteError, type ConnectionCheckRefusal } from './workflow-connection-check'

type Supabase = ReturnType<typeof createSupabaseClient>
export type WorkflowRow = Database['public']['Tables']['workflows']['Row']

export type WriteWorkflowOp = 'create' | 'duplicate' | 'save' | 'restore' | 'patch' | 'delete'

export interface WriteWorkflowCall {
  op: WriteWorkflowOp
  orgId: string
  /** The workflow written; for duplicate, the source; null for create. */
  workflowId: string | null
  /** The version the write was made from; null only where the function allows none. */
  expectedVersion: number | null
  /** The op's fields, exactly the keys the function takes for it. */
  fields: Record<string, unknown>
  /** The save press, so a retried press can recognise its own landed save. */
  saveId: string | null
  actor: { id: string; email: string; name: string | null | undefined }
}

export type WriteWorkflowResult =
  | { kind: 'written'; workflow: WorkflowRow; versionId: string | null; versionNumber: number | null; restoredFrom: number | null; versionsCopied: number | null }
  | { kind: 'stale'; current: unknown; lastSaveId: string | null; changedByName: string | null; changedAt: string | null }
  | { kind: 'not_found'; what: 'workflow' | 'version' | 'folder' }
  | { kind: 'connection_refused'; refusal: ConnectionCheckRefusal }
  | { kind: 'refused'; reason: string; detail: string | null }
  | { kind: 'failed'; error: unknown }

const NOT_FOUND: Record<string, 'workflow' | 'version' | 'folder'> = {
  workflow_not_found: 'workflow',
  version_not_found: 'version',
  folder_not_found: 'folder',
}

const stringOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)

function staleOf(details: unknown): WriteWorkflowResult {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = typeof details === 'string' ? JSON.parse(details) : null
    if (value && typeof value === 'object') parsed = value as Record<string, unknown>
  } catch {
    parsed = {}
  }
  return {
    kind: 'stale',
    current: parsed.current ?? null,
    lastSaveId: stringOrNull(parsed.last_save_id),
    changedByName: stringOrNull(parsed.changed_by_name),
    changedAt: stringOrNull(parsed.changed_at),
  }
}

export async function writeWorkflow(supabase: Supabase, call: WriteWorkflowCall): Promise<WriteWorkflowResult> {
  let answer: { data: unknown; error: unknown }
  try {
    answer = await supabase.rpc('write_workflow', {
      p_op: call.op,
      p_org: call.orgId,
      // The generated types read every argument as required text; null is what
      // the function is given for an absent workflow, version or save.
      p_id: call.workflowId as string,
      p_expected_version: call.expectedVersion as number,
      p_fields: call.fields as Json,
      p_save_id: call.saveId as string,
      p_actor: call.actor.id,
      p_actor_email: call.actor.email,
      p_actor_name: call.actor.name ?? '',
    })
  } catch (error) {
    return { kind: 'failed', error }
  }
  const { data, error } = answer
  if (error) {
    const e = error as { code?: unknown; message?: unknown; details?: unknown }
    const connection = connectionRefusalOfWriteError(error)
    if (connection) return { kind: 'connection_refused', refusal: connection }
    if (e.code === 'BP409' && e.message === 'stale_version') return staleOf(e.details)
    if (e.code === 'P0002' && typeof e.message === 'string' && NOT_FOUND[e.message]) return { kind: 'not_found', what: NOT_FOUND[e.message] }
    if (e.code === 'BP422' && typeof e.message === 'string') return { kind: 'refused', reason: e.message, detail: stringOrNull(e.details) }
    return { kind: 'failed', error }
  }
  const out = (data ?? {}) as Record<string, unknown>
  const workflow = out.workflow
  if (!workflow || typeof workflow !== 'object') {
    return { kind: 'failed', error: new Error('write_workflow answered without the workflow it wrote') }
  }
  return {
    kind: 'written',
    workflow: workflow as WorkflowRow,
    versionId: stringOrNull(out.version_id),
    versionNumber: numberOrNull(out.version_number),
    restoredFrom: numberOrNull(out.restored_from),
    versionsCopied: numberOrNull(out.versions_copied),
  }
}
