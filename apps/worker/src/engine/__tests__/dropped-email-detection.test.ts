/**
 * Detect that a lead reached Salesforce without its email address (#744).
 *
 * The Salesforce node blanks a rejected email and retries, so the run SUCCEEDS
 * and marks its output with `_dropped_fields`. This derives a single per-execution
 * boolean from that, which finalize writes onto `workflow_executions` beside
 * `field_presence`, so the rate is countable per source long after the step logs
 * are purged.
 *
 * WHY IT IS GATED ON NODE TYPE, not on the marker alone. A marker on a
 * pass-through node's output travels downstream and is re-emitted by every
 * branch_end: keying off the marker alone once wrote six rows per Achieve call in
 * this codebase (6c55259). The Salesforce node is not pass-through, but the rule
 * is cheap to honour and the failure it prevents is silent, so the detection walks
 * the NODES and only reads the steps belonging to a `salesforce` node.
 *
 * WHY IT IS COUNTED PER EXECUTION, not per step. A workflow can write to
 * Salesforce more than once (the main flow has several), and a lead whose email
 * was dropped on two of them is still ONE lead with a missing address. Counting
 * steps would inflate the rate above 100 percent on exactly the workflows that
 * write most.
 */
import { describe, it, expect } from 'vitest'
import { detectDroppedEmail } from '../dropped-fields'
import type { NodeDefinition, StepOutput } from '../../types'

function node(namespace: string, type: string): NodeDefinition {
  return { id: namespace, namespace, type, config: {} } as unknown as NodeDefinition
}

function step(output: unknown, status: StepOutput['status'] = 'completed'): StepOutput {
  return { output, status }
}

describe('detectDroppedEmail: reads the marker only off a salesforce node (#744)', () => {
  it('is true when a salesforce step dropped the email', () => {
    const nodes = [node('create_prospect', 'salesforce')]
    const steps = { create_prospect: step({ status: 201, body: { id: 'a' }, _dropped_fields: ['email'] }) }
    expect(detectDroppedEmail(steps, nodes)).toBe(true)
  })

  it('is false when a salesforce step dropped a different field', () => {
    const nodes = [node('create_prospect', 'salesforce')]
    const steps = { create_prospect: step({ status: 201, _dropped_fields: ['phone'] }) }
    expect(detectDroppedEmail(steps, nodes)).toBe(false)
  })

  it('is false when the salesforce step carries no marker', () => {
    const nodes = [node('create_prospect', 'salesforce')]
    expect(detectDroppedEmail({ create_prospect: step({ status: 201, body: { id: 'a' } }) }, nodes)).toBe(false)
  })

  it('ignores the marker on a node that is not a salesforce node', () => {
    // The pass-through trap. A code node echoing an upstream Salesforce output,
    // or a branch_end re-emitting it, must not be counted a second time.
    const nodes = [node('create_prospect', 'salesforce'), node('echo', 'code'), node('tail', 'branch_end')]
    const steps = {
      create_prospect: step({ status: 201, body: { id: 'a' } }),
      echo: step({ _dropped_fields: ['email'] }),
      tail: step({ _dropped_fields: ['email'] }),
    }
    expect(detectDroppedEmail(steps, nodes)).toBe(false)
  })

  it('is true once when several salesforce steps each dropped the email', () => {
    // One lead with a missing address, not two. A per-step count would push the
    // rate above 100 percent on the workflows that write to Salesforce most.
    const nodes = [node('create_prospect', 'salesforce'), node('send_inquiry', 'salesforce')]
    const steps = {
      create_prospect: step({ _dropped_fields: ['email'] }),
      send_inquiry: step({ _dropped_fields: ['email'] }),
    }
    expect(detectDroppedEmail(steps, nodes)).toBe(true)
  })

  it('is true when only the second of several salesforce steps dropped it', () => {
    const nodes = [node('a', 'salesforce'), node('b', 'salesforce')]
    const steps = { a: step({ status: 201 }), b: step({ _dropped_fields: ['email'] }) }
    expect(detectDroppedEmail(steps, nodes)).toBe(true)
  })
})

describe('detectDroppedEmail: degenerate inputs (#744)', () => {
  it('is false with no nodes and no steps', () => {
    expect(detectDroppedEmail({}, [])).toBe(false)
  })

  it('is false when a node has no matching step, e.g. the branch was not taken', () => {
    expect(detectDroppedEmail({}, [node('create_prospect', 'salesforce')])).toBe(false)
  })

  it('is false when the step failed, since nothing was written to Salesforce', () => {
    const nodes = [node('create_prospect', 'salesforce')]
    expect(detectDroppedEmail({ create_prospect: step({ _dropped_fields: ['email'] }, 'failed') }, nodes)).toBe(false)
  })

  it('tolerates an output that is not an object', () => {
    const nodes = [node('create_prospect', 'salesforce')]
    for (const out of [null, undefined, 'text', 42, []]) {
      expect(detectDroppedEmail({ create_prospect: step(out) }, nodes)).toBe(false)
    }
  })

  it('tolerates a marker that is not an array of strings', () => {
    const nodes = [node('create_prospect', 'salesforce')]
    for (const marker of [true, 'email', 42, { email: true }, null]) {
      expect(detectDroppedEmail({ create_prospect: step({ _dropped_fields: marker }) }, nodes)).toBe(false)
    }
  })

  it('matches the real Salesforce field names, which is what the node reports', () => {
    // The names come from Salesforce's own error body, so they are SObject API
    // names rather than anything we chose.
    const nodes = [node('create_prospect', 'salesforce')]
    for (const f of ['Email', 'PersonEmail', 'Email__c', 'Work_Email__c', 'email']) {
      expect(detectDroppedEmail({ create_prospect: step({ _dropped_fields: [f] }) }, nodes), f).toBe(true)
    }
  })

  it('does not count a field that merely mentions email', () => {
    // The preserve direction (LESSONS L104). Email_Opt_Out__c is a picklist about
    // email, not an address, and counting it would inflate the rate with
    // something harmless.
    const nodes = [node('create_prospect', 'salesforce')]
    for (const f of ['Email_Opt_Out__c', 'EmailBouncedReason', 'HasOptedOutOfEmail']) {
      expect(detectDroppedEmail({ create_prospect: step({ _dropped_fields: [f] }) }, nodes), f).toBe(false)
    }
  })
})
