import type { SupabaseClient } from '@supabase/supabase-js'

export class SourceNotAuthorizedError extends Error {
  constructor(source: string, workflowId: string) {
    super(`API key (source "${source}") is not authorized for workflow ${workflowId}`)
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
  const { data: assignments } = await supabase
    .from('source_workflow_assignments')
    .select('workflow_id')
    .eq('organization_id', orgId)
    .eq('source_name', source)

  if (!assignments || assignments.length === 0) return
  const allowed = assignments.some((a) => a.workflow_id === workflowId)
  if (!allowed) throw new SourceNotAuthorizedError(source, workflowId)
}
