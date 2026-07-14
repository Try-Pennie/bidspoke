import { describe, it, expect } from 'vitest'
import { isDeletableTestWorkflow, TEST_WORKFLOW_NAME } from './cleanup'

/**
 * The e2e test user shares an organization with Main Flow, Engine Bidding and
 * Lead Economy Bidding, so RLS does NOT stop the suite from deleting a workflow
 * that moves real money. Until that changes, this predicate is the only thing
 * standing between a teardown bug and a deleted production workflow.
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
