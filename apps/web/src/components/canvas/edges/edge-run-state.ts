import type { ExecutionStep } from '@/types/workflow'

/**
 * Which edges an execution took, for the canvas execution overlay (#1503).
 *
 * A node that chooses an exit records the choice as `_route`, and the engine
 * follows the outgoing edge whose source handle equals it
 * (apps/worker/src/engine/index.ts, "Follow the appropriate outgoing edge").
 * This mirrors that rule: when a matching exit exists, it is the only one
 * taken, whatever ran downstream of the others. Judging by "both ends ran"
 * alone called every exit taken whenever the exits converge, which Buyer
 * Select's always do.
 *
 * When no exit matches the route, or the node records none, the engine falls
 * back to edge conditions the canvas cannot evaluate, so the older both ends
 * ran rule stands.
 */

export type EdgeRunState = 'taken' | 'taken_failed' | 'not_taken' | 'unreached'

export interface RunStep {
  status: ExecutionStep['status']
  /** The chosen exit, as the execution summary reports it. */
  route?: string | null
  /** Full step output; test runs carry the route here instead. */
  output?: unknown
}

export interface RunEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
}

function routeOf(step: RunStep): string | null {
  if (typeof step.route === 'string' && step.route) return step.route
  const out = step.output
  if (out && typeof out === 'object') {
    const r = (out as Record<string, unknown>)._route
    if (typeof r === 'string' && r) return r
  }
  return null
}

const isFailed = (step: RunStep | undefined) =>
  step?.status === 'failed' || step?.status === 'failed_with_fallback'

export function edgeRunStates(
  edges: RunEdge[],
  stepFor: (nodeId: string) => RunStep | undefined,
): Map<string, EdgeRunState> {
  // The exit each routing node chose, only where an outgoing edge is wired to
  // it. Computed once per source so a large canvas is one pass over the edges.
  const chosenHandle = new Map<string, string>()
  const handlesBySource = new Map<string, Set<string>>()
  for (const e of edges) {
    if (!e.sourceHandle) continue
    let set = handlesBySource.get(e.source)
    if (!set) handlesBySource.set(e.source, (set = new Set()))
    set.add(e.sourceHandle)
  }
  for (const [source, handles] of handlesBySource) {
    const step = stepFor(source)
    const route = step ? routeOf(step) : null
    if (route && handles.has(route)) chosenHandle.set(source, route)
  }

  const states = new Map<string, EdgeRunState>()
  for (const e of edges) {
    const sourceStep = stepFor(e.source)
    const targetStep = stepFor(e.target)
    const sourceRan = e.source === 'trigger' || sourceStep != null
    if (!sourceRan) {
      states.set(e.id, 'unreached')
      continue
    }
    const chosen = chosenHandle.get(e.source)
    const taken = chosen !== undefined ? e.sourceHandle === chosen : targetStep != null
    if (!taken) {
      states.set(e.id, 'not_taken')
      continue
    }
    states.set(e.id, isFailed(sourceStep) || isFailed(targetStep) ? 'taken_failed' : 'taken')
  }
  return states
}
