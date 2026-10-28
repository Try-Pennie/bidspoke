/**
 * writeWorkflow (#1947): the Worker's one way to write a workflow.
 *
 * Every write of a workflow's definition, is_active or deleted_at, and every
 * version snapshot, goes through the write_workflow database function
 * (migration 20261023120000): create, duplicate, save, restore, patch (switch
 * on or off, move to a folder) and soft delete. Lane is written by none of its
 * ops: a create takes the money default and a duplicate the source's lane. The function locks the row,
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
 *
 * A write that writes a version snapshot (save, restore) is also pushed to
 * the GitHub backup from here (#2868, lib/workflow-backup.ts), in the
 * background through the caller's waitUntil, so no route can write a version
 * the backup never sees. `backup` is required of every call for that reason.
 */
import type { createSupabaseClient } from './supabase'
import type { Database, Json } from '../types/database'
import { stampAppActionBinders } from './app-action-binders'
import { connectionRefusalOfWriteError, type ConnectionCheckRefusal } from './workflow-connection-check'
import { backUpWrittenVersion, type WorkflowBackupContext } from './workflow-backup'

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
  /**
   * The definition stored now, which the written one replaces, or null when
   * there is none (a create, a duplicate's new row, or an op writing no
   * definition). Required, so no caller can leave it out: every definition
   * written has each app_action step's boundBy stamped against it (#2339,
   * lib/app-action-binders.ts), never taken from the client.
   */
  storedDefinition: unknown
  /**
   * Where the version this write makes is backed up from (#2868). Required of
   * every call, so a new definition writer cannot leave it out; used only by
   * the ops that write a version (VERSION_OPS).
   */
  backup: WorkflowBackupContext
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

/** The ops whose write is a new version snapshot, each pushed to the GitHub backup (#2868). */
export const VERSION_OPS: ReadonlySet<WriteWorkflowOp> = new Set(['save', 'restore'])

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
  // Who bound each app_action step is the server's stamp on every definition written (#2339).
  const fields = Object.hasOwn(call.fields, 'definition')
    ? { ...call.fields, definition: stampAppActionBinders(call.fields.definition, call.storedDefinition, call.actor.id) }
    : call.fields
  let answer: { data: unknown; error: unknown }
  try {
    answer = await supabase.rpc('write_workflow', {
      p_op: call.op,
      p_org: call.orgId,
      // The generated types read every argument as required text; null is what
      // the function is given for an absent workflow, version or save.
      p_id: call.workflowId as string,
      p_expected_version: call.expectedVersion as number,
      p_fields: fields as Json,
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
  const written = {
    kind: 'written' as const,
    workflow: workflow as WorkflowRow,
    versionId: stringOrNull(out.version_id),
    versionNumber: numberOrNull(out.version_number),
    restoredFrom: numberOrNull(out.restored_from),
    versionsCopied: numberOrNull(out.versions_copied),
  }
  if (VERSION_OPS.has(call.op)) {
    // What the write stored, not what the caller sent: the definition carries
    // the binder stamps above, and a save naming no definition snapshots the
    // stored one, which the row still holds.
    const name = written.workflow.name || written.workflow.id
    const message = typeof call.fields.message === 'string' && call.fields.message.trim()
      ? call.fields.message
      : call.op === 'restore' && written.restoredFrom !== null
        ? `chore: restore workflow "${name}" from v${written.restoredFrom}${written.versionNumber === null ? '' : ` as v${written.versionNumber}`}`
        : undefined
    backUpWrittenVersion(supabase, call.backup, {
      orgId: call.orgId,
      workflowId: written.workflow.id,
      workflowName: name,
      definition: written.workflow.definition,
      versionId: written.versionId,
      versionNumber: written.versionNumber,
      message,
    })
  }
  return written
}
