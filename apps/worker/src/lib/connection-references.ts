/**
 * Which workflows use a connection (#2338, #2946): the one read of
 * connection_references, the database function that answers it by the one
 * predicate, definition_connection_ids (migration 20261020220000), which the
 * workflow write check and the Remove refusal read too. Every Worker question
 * "which workflows use this connection" asks it here, never by a match of its
 * own on a definition's text, so each place that names them names the same
 * ones:
 * - `routes/api/connections.ts`: the Connections page's Used by list, and
 *   which ticked workflows a Replace may rewrite;
 * - `lib/standing-connection-incidents.ts`: the workflows the daily owner
 *   check and the daily HTTP connection host check name in their pages.
 *
 * The answer is the function's: every workflow of the organization whose
 * current definition holds the id, soft deleted ones included and marked,
 * live ones first, then by name and id. `found: false` is the function's
 * connection_not_found, a connection not of that organization (or removed since
 * the caller read it). Any other failure throws, never an empty list (L10).
 *
 * Who may call it: the Worker as service_role (the function is service_role
 * only). Whose data: the organization passed, which the function filters on
 * and checks the connection against; the caller passes the organization it is
 * acting for, never one taken from a request body.
 *
 * DATA VOLUME (L24): one row per workflow of the organization naming the
 * connection, at most the organization's workflows (11 live on 2026-10-15).
 * The function is on the read only list, so an answer at the 1,000 row cap
 * fails inside a scheduled tick (row-cap.ts) rather than being taken as whole.
 */
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'

export interface ConnectionReference {
  /** The workflow's id. */
  id: string
  name: string
  /** Soft deleted: it cannot run, and it still holds the connection's id. */
  deleted: boolean
}

export type ConnectionReferences = { found: true; workflows: ConnectionReference[] } | { found: false }

export async function readConnectionReferences(supabase: SupabaseClient, organizationId: string, connectionId: string): Promise<ConnectionReferences> {
  const answer: { data: unknown; error: PostgrestError | null } = await supabase.rpc('connection_references', { p_organization_id: organizationId, p_connection_id: connectionId })
  const { data, error } = answer
  if (error) {
    if (error.code === 'P0002' && /connection_not_found/.test(error.message)) return { found: false }
    throw error
  }
  if (!Array.isArray(data)) throw new Error('connection_references answered no list of workflows')
  return {
    found: true,
    workflows: (data as Array<{ workflow_id: string; name: string; deleted: boolean }>).map((r) => ({ id: r.workflow_id, name: r.name, deleted: r.deleted === true })),
  }
}
