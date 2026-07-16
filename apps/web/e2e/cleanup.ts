/**
 * Deciding what the e2e teardown is allowed to delete.
 *
 * Since #664 the test user has its own organization, so the tenant model already
 * keeps the suite away from Main Flow, Engine Bidding and Lead Economy: it cannot
 * even see a production workflow to delete it. This predicate stays as
 * defense-in-depth, so a config regression that puts the user back in a shared org
 * (caught loudly by the isolation guard in global-setup) still cannot turn a
 * teardown bug into a deleted production workflow.
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

/**
 * Whether this run should skip the sweep entirely.
 *
 * The CI accessibility job (#673) runs only a11y.spec.ts, which creates nothing. A sweep
 * there would issue a DELETE against the production Worker on every PR and would make
 * Worker downtime fail an accessibility gate, so it opts out with E2E_SKIP_TEARDOWN.
 *
 * Only a deliberate opt-in counts. A suite that DOES create rows must never stop cleaning
 * up because a CI expression resolved to '0', 'false' or an empty string: silently leaking
 * rows into production is the exact failure the sweep exists to prevent.
 */
export function shouldSkipTeardown(env: Record<string, string | undefined>): boolean {
  const flag = env.E2E_SKIP_TEARDOWN?.toLowerCase()
  return flag === '1' || flag === 'true'
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
