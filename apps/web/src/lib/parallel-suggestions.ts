// Detects sequentially-connected steps that have no data dependency on each
// other and could run in parallel for faster execution. Used by TestRunPanel
// to show post-run suggestions with estimated savings based on the actual
// measured durations.
//
// Heuristic: for each edge A → B where both are non-structural nodes,
// check whether B's config references A's namespace (scan serialized config
// for any `steps.A.X` pattern). If B doesn't reference A, the two could
// run concurrently.

import type { WorkflowDef, NodeDef, EdgeDef } from '@/types/workflow'

const STRUCTURAL_TYPES = new Set([
  'filter',
  'branch',
  'bid_evaluation',
  'parallel',
  'parallel_end',
  'exit',
  'response',
  'trigger',
  'constants',
])

function isStructural(type: string | undefined): boolean {
  return type !== undefined && STRUCTURAL_TYPES.has(type)
}

/** Any `steps.NAMESPACE` reference found in a serialized config string. */
function findStepsReferences(haystack: string): Set<string> {
  const refs = new Set<string>()
  const re = /\bsteps\s*\.\s*([a-zA-Z_$][\w$]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(haystack)) !== null) refs.add(m[1])
  return refs
}

export interface ParallelSuggestion {
  upstream: string
  downstream: string
  upstreamLabel: string
  downstreamLabel: string
  estimatedSavingsMs: number
}

export interface TestStepTiming {
  step_namespace: string
  duration_ms: number
  parallel_group_id?: string | null
}

export function findParallelSuggestions(
  definition: WorkflowDef,
  testSteps: TestStepTiming[]
): ParallelSuggestion[] {
  const nodeById = new Map<string, NodeDef>()
  for (const n of definition.nodes) nodeById.set(n.id, n)

  const durationByNs = new Map<string, number>()
  for (const s of testSteps) {
    if (s.parallel_group_id) continue  // skip parallel children
    durationByNs.set(s.step_namespace, s.duration_ms)
  }

  const suggestions: ParallelSuggestion[] = []
  const seen = new Set<string>()

  for (const edge of definition.edges as EdgeDef[]) {
    const src = nodeById.get(edge.source)
    const tgt = nodeById.get(edge.target)
    if (!src || !tgt) continue
    if (isStructural(src.type) || isStructural(tgt.type)) continue

    const key = `${src.namespace}::${tgt.namespace}`
    if (seen.has(key)) continue
    seen.add(key)

    // Does target reference source's namespace anywhere in its config?
    const tgtRefs = findStepsReferences(JSON.stringify(tgt.config ?? {}))
    if (tgtRefs.has(src.namespace)) continue  // real dependency

    const srcDur = durationByNs.get(src.namespace)
    const tgtDur = durationByNs.get(tgt.namespace)
    if (srcDur === undefined || tgtDur === undefined) continue
    // Not worth parallelizing if both are trivially fast
    if (srcDur < 50 && tgtDur < 50) continue

    suggestions.push({
      upstream: src.namespace,
      downstream: tgt.namespace,
      upstreamLabel: (src as unknown as { label?: string }).label || src.namespace,
      downstreamLabel: (tgt as unknown as { label?: string }).label || tgt.namespace,
      estimatedSavingsMs: Math.min(srcDur, tgtDur),
    })
  }

  suggestions.sort((a, b) => b.estimatedSavingsMs - a.estimatedSavingsMs)
  return suggestions
}
