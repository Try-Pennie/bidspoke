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

interface NodeLike { config?: Record<string, unknown> }
interface DefinitionLike { definition: { nodes: NodeLike[] } }

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
