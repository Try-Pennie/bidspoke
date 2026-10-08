/**
 * The steps a walk is running at this moment, as a person reads them (#1882).
 *
 * A run that answered early keeps walking after the answer, and finalize stops
 * waiting for that walk 12 s later. When it gave up, the reason and the alert
 * pointed at the Salesforce update by guesswork; on 2026-10-08 that update had
 * finished 87 ms after the answer and the step still out was the Achieve call
 * after it. The walk now records the step it is on, so the cut-off can name it.
 */
import type { NodeDefinition } from '../types'

/** A step by its label and namespace, or by its namespace alone when it has no other name. */
export function stepName(node: Pick<NodeDefinition, 'namespace' | 'label'>): string {
  const label = node.label?.trim()
  return label && label !== node.namespace ? `${label} (${node.namespace})` : node.namespace
}

/** Names as one phrase: "A", "A and B", "A, B and C". */
export function listSteps(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
