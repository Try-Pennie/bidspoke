/**
 * Deciding what the e2e teardown is allowed to delete.
 *
 * This is load-bearing safety code, not a helper. The e2e user shares an
 * organization with Main Flow, Engine Bidding Workflow and Lead Economy Bidding,
 * so row-level security does NOT prevent the suite from deleting a workflow that
 * moves real money. Until the test user gets its own org, this predicate is the
 * thing standing between a teardown bug and a deleted production workflow.
 *
 * It replaces a UI loop that clicked Delete on any row whose visible TEXT matched
 * /E2E-|e2e-test/. That was dangerous (one renamed column or changed selector from
 * matching a real workflow) and unreliable (it swallowed failures, which is how it
 * leaked rows into production).
 */

/** The name the app gives a freshly created workflow, which the create test leaves behind. */
export const TEST_WORKFLOW_NAME = 'Untitled Workflow'

/** Names the suite creates: `E2E-<timestamp>` and the app's default new-workflow name. */
const TEST_NAME = new RegExp(`^(E2E-|${TEST_WORKFLOW_NAME})`)

export interface WorkflowRow {
  id?: string
  name?: string
  updated_by_email?: string
}

/**
 * True only when BOTH the owner and the name look like a test artifact. Either
 * signal alone is unsafe: a human's scratch workflow can be called "Untitled
 * Workflow", and a test that opens and saves a real workflow flips its
 * updated_by_email to the e2e user. Anchored, so a name that merely CONTAINS a
 * marker ("Main Flow (Untitled Workflow backup)") is refused.
 */
export function isDeletableTestWorkflow(wf: WorkflowRow, e2eEmail: string): boolean {
  if (!wf.id) return false
  if (!wf.updated_by_email || wf.updated_by_email !== e2eEmail) return false
  return TEST_NAME.test(wf.name ?? '')
}

/** The workflows API, narrowed to what the sweep needs, so it can be tested without a network. */
export interface WorkflowApi {
  list: () => Promise<WorkflowRow[]>
  /** Resolves true when the workflow is gone. */
  remove: (id: string) => Promise<boolean>
}

/**
 * Delete every test workflow the API can see, and NOTHING else.
 *
 * Throws if the list fails or if any delete fails. That is the point: the cleanup
 * this replaces swallowed its errors, so runs went green while leaving rows in the
 * production org and nobody found out. A teardown that cannot clean up must say so.
 */
export async function sweepTestWorkflows(
  api: WorkflowApi,
  e2eEmail: string,
): Promise<{ deleted: number }> {
  const all = await api.list()
  const doomed = all.filter((w) => isDeletableTestWorkflow(w, e2eEmail))

  const failed: string[] = []
  for (const w of doomed) {
    const ok = await api.remove(w.id!)
    if (!ok) failed.push(w.name ?? w.id!)
  }

  if (failed.length > 0) {
    throw new Error(`E2E teardown could not delete ${failed.length} test workflow(s): ${failed.join(', ')}`)
  }
  return { deleted: doomed.length }
}
