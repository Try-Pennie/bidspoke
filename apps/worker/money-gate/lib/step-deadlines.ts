/**
 * Step deadlines the replay cannot reach (#1796).
 *
 * A node's `timeout_ms` (and a bid group's `cascade_total_timeout_ms`) is a wall
 * clock timer, and nothing else reads it. Live definitions give code nodes 150 to
 * 250 ms, which a code dispatch into the gate's nested workerd can exceed on a busy
 * runner. The step then times out and retries on one side only, `retries_used` and
 * the dispatch count differ between base and head with nothing changed, and the
 * gate goes red at random. The easy way past that is an expected-changes entry,
 * which would also excuse a real retry change.
 *
 * The replay's clock is pinned and every answer is canned, so how long a step takes
 * says nothing about the engine under test. Every replayed definition therefore has
 * each timer it already sets raised to one deadline far above any real replay step,
 * on both sides alike. A timer a node does not set stays unset: a code node with a
 * custom timeout is kept out of a chain (isChainableCodeNode), so adding one would
 * change how the engine dispatches it.
 */

/** Far above any step in a real replay, and below the replay's own test timeout. */
export const GATE_STEP_DEADLINE_MS = 300_000

/** The timer fields a node's config can set, each read only as a duration. */
const TIMER_FIELDS = ['timeout_ms', 'cascade_total_timeout_ms'] as const

interface NodeLike { namespace?: string; type?: string; config?: Record<string, unknown> }
interface DefinitionLike { definition: { nodes: NodeLike[] } }

/**
 * A copy of `lifted` in which each step named in `namespaces` has its timers back
 * as `defined` sets them (#3138). A fixture names a step here to let one of its
 * attempts time out on the replay's time, so the retry production makes after a
 * timed out attempt can be replayed. The timer still runs under the engine timer
 * lift, so it never races the runner: only the replay's own advance can run it.
 * Refused by name: a step the definition lacks, one that sets no timer, and a code
 * step, whose dispatch into the nested workerd takes real time the replay's
 * advance would not wait for.
 */
export function keepStepDeadlines<T extends DefinitionLike>(lifted: T, defined: T, namespaces: readonly string[]): T {
  if (namespaces.length === 0) return lifted
  const nodes = lifted.definition.nodes.map((n, i) => {
    if (!n.namespace || !namespaces.includes(n.namespace)) return n
    const own = defined.definition.nodes[i]
    if (own?.namespace !== n.namespace) throw new Error(`money gate: the definitions disagree on the step at position ${i}, so ${n.namespace}'s deadline cannot be kept`)
    if (n.type === 'code') throw new Error(`money gate: ${n.namespace} is a code step, whose dispatch takes real time a kept deadline would race; only a step the engine itself sends can keep its deadline`)
    const config = { ...n.config }
    let kept = 0
    for (const field of TIMER_FIELDS) {
      if (typeof own.config?.[field] === 'number') {
        config[field] = own.config[field]
        kept++
      }
    }
    if (kept === 0) throw new Error(`money gate: ${n.namespace} sets no timeout_ms or cascade_total_timeout_ms, so there is no deadline of its own to keep`)
    return { ...n, config }
  })
  for (const name of namespaces) {
    if (!lifted.definition.nodes.some((n) => n.namespace === name)) throw new Error(`money gate: a fixture asked to keep the deadline of ${name}, which this definition has no step named`)
  }
  return { ...lifted, definition: { ...lifted.definition, nodes } }
}

/** A copy of `def` with every timer its nodes set raised to GATE_STEP_DEADLINE_MS. */
export function liftStepDeadlines<T extends DefinitionLike>(def: T): T {
  const nodes = def.definition.nodes.map((n) => {
    if (!n.config) return n
    const config = { ...n.config }
    for (const field of TIMER_FIELDS) {
      if (typeof config[field] === 'number') config[field] = GATE_STEP_DEADLINE_MS
    }
    return { ...n, config }
  })
  return { ...def, definition: { ...def.definition, nodes } }
}
