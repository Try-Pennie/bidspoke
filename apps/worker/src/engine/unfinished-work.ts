/**
 * Whether work still out at a run's cut-off pages (#2024, phase F of #2015).
 *
 * A run that answered early keeps walking, and finalize stops waiting for that
 * walk 12 s after the answer (#1860). Until now every such run counted toward
 * `continuation_unfinished` and its alert said the work "may have finished". On
 * 2026-10-13, 8 of 18 such writes had not. Since #2022 and #2023 a post-answer
 * Salesforce write still out after 2 s is recorded in KV and the Salesforce
 * read-back settles it: it confirms it by its own marker, resends it, or pages
 * on its own. Such a write needs no second page here.
 *
 * So the run stays quiet only when BOTH hold:
 *
 *  - every step the walk was on at the cut-off is held by the read-back, decided
 *    by the read-back's own classifier on the at-risk record it reads
 *    (`readBackHolds`), never by the step's type. A write still inside its first
 *    2 s has no record yet, and pages;
 *  - nothing the walk may still reach can do anything outside the run: every
 *    node reachable from those steps (edges, a fallback node, a parallel node's
 *    children) is one whose traits say it sends nothing (`shadowRun:
 *    'sends_nothing'`, the trait that also decides a shadow run). A step not yet
 *    walked has no record at the cut-off, so a write still to come pages too,
 *    even one the read-back would hold once it ran.
 *
 * Every doubt pages: no running step named, a step missing from the definition,
 * a type this build does not know, a record that cannot be read, or one that
 * does not answer within UNFINISHED_READ_DEADLINE_MS.
 */
import { NODE_TRAITS, isNodeType } from '@bidspoke/node-types'
import type { WorkflowDefinition, NodeDefinition } from '../types'
import type { RetryClock } from '../lib/post-response-budget'
import { formatErr } from '../lib/format-error'

/**
 * How long finalize waits for the at-risk records before it pages anyway. Two
 * KV reads and a decrypt per step; the dead letter behind it keeps its own 3 s
 * reserve at the end of the budget, which this stays well inside.
 */
export const UNFINISHED_READ_DEADLINE_MS = 1_000

export interface UnfinishedWorkDeps {
  /** True only when the Salesforce read-back holds this step's write as its own. */
  readBackHolds(stepNamespace: string): Promise<boolean>
  clock: Pick<RetryClock, 'timer'>
}

/** Every node the walk can still reach from these, by the ways the walk moves. */
function reachableFrom(definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>, from: NodeDefinition[]): NodeDefinition[] | null {
  const byId = new Map(definition.nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const queue = from.flatMap((n) => nextIds(definition, n))
  const out: NodeDefinition[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    // A step the walk can reach but this definition does not hold: unknowable.
    if (!node) return null
    out.push(node)
    queue.push(...nextIds(definition, node))
  }
  return out
}

function nextIds(definition: Pick<WorkflowDefinition, 'edges'>, node: NodeDefinition): string[] {
  const ids = definition.edges.filter((e) => e.source === node.id).map((e) => e.target)
  const fallback = node.config?.fallback_node
  if (typeof fallback === 'string' && fallback !== '') ids.push(fallback)
  if (Array.isArray(node.children)) ids.push(...node.children)
  return ids
}

const sendsNothing = (node: NodeDefinition): boolean =>
  isNodeType(node.type) && NODE_TRAITS[node.type].shadowRun.kind === 'sends_nothing'

async function holdsWithin(deps: UnfinishedWorkDeps, stepNamespace: string): Promise<boolean> {
  const stop = new AbortController()
  try {
    return await Promise.race([
      deps.readBackHolds(stepNamespace),
      deps.clock.timer(UNFINISHED_READ_DEADLINE_MS, stop.signal).then(() => {
        console.error(`[unfinished-work] the at-risk record of step ${stepNamespace} did not answer within ${UNFINISHED_READ_DEADLINE_MS} ms, so the run pages`)
        return false
      }),
    ])
  } catch (e) {
    console.error(`[unfinished-work] could not read the at-risk record of step ${stepNamespace}, so the run pages:`, formatErr(e))
    return false
  } finally {
    stop.abort()
  }
}

/** True when the run's unfinished work pages; false only when the read-back holds all of it. */
export async function unfinishedWorkPages(
  definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>,
  runningNamespaces: readonly string[],
  deps: UnfinishedWorkDeps,
): Promise<boolean> {
  if (runningNamespaces.length === 0) return true
  const running = runningNamespaces.map((ns) => definition.nodes.find((n) => n.namespace === ns))
  if (running.some((n) => n === undefined)) return true
  const ahead = reachableFrom(definition, running as NodeDefinition[])
  if (ahead === null || !ahead.every(sendsNothing)) return true
  const held = await Promise.all(runningNamespaces.map((ns) => holdsWithin(deps, ns)))
  return !held.every(Boolean)
}
