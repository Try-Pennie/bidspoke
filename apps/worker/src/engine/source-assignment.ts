import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchUpTo } from '../lib/paginate'
import { CONFIG_LIST_BOUNDS } from '../lib/config-list-bounds'

export class SourceNotAuthorizedError extends Error {
  constructor(source: string, workflowId: string) {
    super(`API key (source "${source}") is not authorized for workflow ${workflowId}`)
  }
}

// Thrown when the assignment lookup itself fails (DB error), so the caller can
// fail CLOSED with a retryable status instead of treating the missing data as
// "no assignments → allow" (#65).
export class SourceAuthUnavailableError extends Error {
  constructor(source: string, cause: string) {
    super(`Could not verify source authorization for "${source}": ${cause}`)
  }
}

/**
 * Enforce source-to-workflow assignment on the generic /webhooks/:id path.
 *
 * Semantics:
 * - Empty assignments for this source in this org → unrestricted, allow.
 * - Any assignment row present → source is locked to the listed workflows only.
 * - Custom endpoints are self-granting and do not call this.
 *
 * Throws {@link SourceNotAuthorizedError} when the source is locked and the
 * current workflow is not in the allow-list.
 */
export async function enforceSourceAssignment(
  supabase: SupabaseClient,
  orgId: string,
  source: string,
  workflowId: string
): Promise<void> {
  // Fail CLOSED on a lookup error: a null `data` from a failed query is
  // indistinguishable from "no assignment rows", and treating it as the latter
  // would silently lift a source's workflow restriction during a DB blip (#65).
  // A list past its bound fails closed the same way (#1437): cut at the row cap
  // it could leave this workflow out, so it is not the allow list.
  let assignments: { workflow_id: string }[]
  try {
    assignments = await fetchUpTo<{ workflow_id: string }>((limit) => supabase
      .from('source_workflow_assignments')
      .select('workflow_id')
      .eq('organization_id', orgId)
      .eq('source_name', source)
      .limit(limit), CONFIG_LIST_BOUNDS.sourceAssignments, 'source_workflow_assignments')
  } catch (err) {
    throw new SourceAuthUnavailableError(source, err instanceof Error ? err.message : 'non Error thrown')
  }
  if (assignments.length === 0) return
  const allowed = assignments.some((a) => a.workflow_id === workflowId)
  if (!allowed) throw new SourceNotAuthorizedError(source, workflowId)
}
