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
