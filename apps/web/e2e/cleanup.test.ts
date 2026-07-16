import { describe, it, expect } from 'vitest'
import { isDeletableTestWorkflow, sweepTestWorkflows, TEST_WORKFLOW_NAME, type WorkflowRow } from './cleanup'

/**
 * Since #664 the e2e user has its own organization, so RLS keeps the suite away
 * from Main Flow, Engine Bidding and Lead Economy on its own. This predicate is
 * retained as defense-in-depth against a config regression that shares the org
 * again, so a teardown bug still cannot delete a workflow that moves real money.
 *
 * It is deliberately paranoid: BOTH the owner and the name must look like a test
 * artifact. The old cleanup was a UI loop that clicked Delete on any row whose
 * text matched /E2E-|e2e-test/, which is one selector change away from matching
 * a real workflow.
 */
const E2E = 'e2e-test@trypennie.com'

const wf = (over: Record<string, unknown> = {}) => ({
  id: 'id-1',
  name: 'E2E-123',
  updated_by_email: E2E,
  ...over,
})

describe('isDeletableTestWorkflow', () => {
  it('deletes a workflow the suite created', () => {
    expect(isDeletableTestWorkflow(wf(), E2E)).toBe(true)
    expect(isDeletableTestWorkflow(wf({ name: TEST_WORKFLOW_NAME }), E2E)).toBe(true)
    expect(isDeletableTestWorkflow(wf({ name: `${TEST_WORKFLOW_NAME} (copy)` }), E2E)).toBe(true)
  })

  it('REFUSES to delete a production workflow', () => {
    for (const name of [
      'Main Flow',
      'Engine Bidding Workflow',
      'Lead Economy - Bidding Workflow',
      'RML - Bidding Workflow (GigFi)',
    ]) {
      expect(isDeletableTestWorkflow(wf({ name, updated_by_email: 'dwright@trypennie.com' }), E2E)).toBe(false)
    }
  })

  it('REFUSES even a production workflow the test user last touched', () => {
    // A test that opens and saves a real workflow would flip updated_by_email to
    // the e2e user. Owner alone must not be enough to authorise a delete.
    expect(isDeletableTestWorkflow(wf({ name: 'Main Flow', updated_by_email: E2E }), E2E)).toBe(false)
  })

  it('REFUSES a test-looking name owned by a real person', () => {
    // A human's scratch workflow genuinely called "Untitled Workflow" is not ours
    // to delete. Name alone must not be enough either.
    expect(
      isDeletableTestWorkflow(wf({ name: TEST_WORKFLOW_NAME, updated_by_email: 'dwright@trypennie.com' }), E2E),
    ).toBe(false)
  })

  it('REFUSES a name that merely contains a test marker', () => {
    // Substring matching is what made the old UI cleanup dangerous.
    expect(isDeletableTestWorkflow(wf({ name: 'Production E2E-ish flow' }), E2E)).toBe(false)
    expect(isDeletableTestWorkflow(wf({ name: 'Main Flow (Untitled Workflow backup)' }), E2E)).toBe(false)
  })

  it('REFUSES a row with no id, so a malformed response cannot widen a delete', () => {
    expect(isDeletableTestWorkflow(wf({ id: undefined }), E2E)).toBe(false)
    expect(isDeletableTestWorkflow(wf({ id: '' }), E2E)).toBe(false)
  })
})

describe('sweepTestWorkflows', () => {
  const rows: WorkflowRow[] = [
    { id: 'w1', name: 'Main Flow', updated_by_email: 'dwright@trypennie.com' },
    { id: 'w2', name: 'E2E-123', updated_by_email: E2E },
    { id: 'w3', name: 'Untitled Workflow', updated_by_email: E2E },
  ]

  it('deletes only the test workflows, never a production one', async () => {
    const removed: string[] = []
    const res = await sweepTestWorkflows(
      { list: async () => rows, remove: async (id) => { removed.push(id); return true } },
      E2E,
    )
    expect(removed).toEqual(['w2', 'w3'])
    expect(removed).not.toContain('w1')
    expect(res.deleted).toBe(2)
  })

  it('does nothing when there is nothing to clean', async () => {
    const removed: string[] = []
    const res = await sweepTestWorkflows(
      { list: async () => [rows[0]], remove: async (id) => { removed.push(id); return true } },
      E2E,
    )
    expect(removed).toEqual([])
    expect(res.deleted).toBe(0)
  })

  it('THROWS when a delete fails, instead of leaking the row silently', async () => {
    // The old cleanup swallowed failures, so a run went green while leaving rows
    // in the production org. Silence is the bug; this must be loud.
    await expect(
      sweepTestWorkflows({ list: async () => rows, remove: async () => false }, E2E),
    ).rejects.toThrow(/could not delete/i)
  })

  it('THROWS when listing fails, rather than reporting a clean sweep', async () => {
    await expect(
      sweepTestWorkflows(
        { list: async () => { throw new Error('worker down') }, remove: async () => true },
        E2E,
      ),
    ).rejects.toThrow(/worker down/)
  })

  it('still reports the rows it could not delete', async () => {
    await expect(
      sweepTestWorkflows(
        { list: async () => rows, remove: async (id) => id !== 'w3' },
        E2E,
      ),
    ).rejects.toThrow(/Untitled Workflow/)
  })
})
