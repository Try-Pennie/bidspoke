/**
 * Derive, per execution, whether a lead reached Salesforce without its email (#744).
 *
 * The Salesforce node blanks a rejected email and retries, so the run SUCCEEDS
 * (#723: a cosmetically broken address must not cost us someone we can still
 * phone) and marks its output with `_dropped_fields`. Because the run succeeds
 * there is no failed execution and no alert, so the incidence was observable only
 * by hand-reading step logs on a short retention window.
 *
 * This boolean is written onto `workflow_executions` at finalize, beside
 * `field_presence`, which makes the rate countable per source from ONE small
 * partition-pruned table. Aggregating `execution_steps` instead was measured on
 * production and is not viable: there is no index on `step_type`, and even a
 * 30 minute window timed out at 25 seconds.
 */
import type { NodeDefinition, StepOutput } from '../types'

/**
 * Is this Salesforce field an email ADDRESS?
 *
 * The names come from Salesforce's own error body, so they are real SObject API
 * names: `Email`, `PersonEmail`, `Email__c`, `Work_Email__c`.
 *
 * Simply ending in "email" is not enough, which the tests pin. `HasOptedOutOfEmail`
 * and `Email_Opt_Out__c` are flags ABOUT email, not addresses, and counting them
 * would inflate the rate with something harmless. A filter has to be checked
 * against what it must PRESERVE, not only what it must catch (LESSONS L104).
 *
 * So: strip the custom-field suffix, then accept only a name that IS `email`, ends
 * in `_email`, or is Salesforce's standard `PersonEmail`.
 */
function isEmailField(name: string): boolean {
  const bare = name.replace(/__c$/i, '')
  return /^(.*_)?email$/i.test(bare) || /^person_?email$/i.test(bare)
}

/**
 * True when at least one SALESFORCE step in this run dropped an email field.
 *
 * Gated on NODE TYPE rather than on the marker alone. A marker on a pass-through
 * node's output travels downstream and is re-emitted by every branch_end, which
 * in this codebase once wrote six rows per Achieve call (6c55259). Walking the
 * nodes and reading only the steps belonging to a `salesforce` node makes that
 * impossible rather than unlikely.
 *
 * Counted per EXECUTION, not per step: a workflow can write to Salesforce several
 * times, and a lead whose email was dropped on two of them is still one lead with
 * a missing address. A per-step count would push the rate above 100 percent on
 * exactly the workflows that write most.
 */
export function detectDroppedEmail(
  steps: Record<string, StepOutput>,
  nodes: NodeDefinition[],
): boolean {
  for (const n of nodes) {
    if (n.type !== 'salesforce') continue
    const s = steps[n.namespace]
    // A failed step wrote nothing to Salesforce, so there is no lead with a
    // missing address to count.
    if (!s || s.status !== 'completed') continue

    const out = s.output
    if (!out || typeof out !== 'object' || Array.isArray(out)) continue

    const marker = (out as Record<string, unknown>)._dropped_fields
    if (!Array.isArray(marker)) continue

    if (marker.some((f) => typeof f === 'string' && isEmailField(f))) return true
  }
  return false
}
