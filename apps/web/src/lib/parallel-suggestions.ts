// Detects sequentially-connected steps that have no data dependency on each
// other and could run in parallel for faster execution. Used by TestRunPanel
// to show post-run suggestions with estimated savings.
//
// Heuristic: for each edge A → B where both are non-branching nodes (no
// filter/branch/bid_evaluation/parallel/parallel_end on either side), check
// whether B's config references A's namespace (via any steps.A.X pattern
// in scripts, templates, or body fields). If B doesn't reference A, the
// two could run concurrently.

import type { Node, Edge } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import type { ExecutionStep } from '@/types/workflow'

const STRUCTURAL_TYPES = new Set([
  'filter',
  'branch',
  'bid_evaluation',
  'parallel',
  'parallel_end',
  'exit',
  'response',
  'trigger',
])

function isStructural(type: string | undefined): boolean {
  return type !== undefined && STRUCTURAL_TYPES.has(type)
}

/** Extract every "steps.NAMESPACE" reference found in a string (config, script, template). */
function findStepsReferences(haystack: string): Set<string> {
  const refs = new Set<string>()
  const re = /\bsteps\s*\.\s*([a-zA-Z_$][\w$]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(haystack)) !== null) refs.add(m[1])
  return refs
}

/** Serialize a node's config to a scannable string (scripts, templates, bodies, field refs). */
function scanNodeConfig(data: CanvasNodeData): Set<string> {
  const cfg = data.config ?? {}
  // Quickest scan: JSON.stringify the whole config and scan for steps.X patterns
  const serialized = JSON.stringify(cfg)
  return findStepsReferences(serialized)
}

export interface ParallelSuggestion {
  upstream: string  // namespace of the upstream step
  downstream: string  // namespace of the downstream step
  upstreamLabel: string
  downstreamLabel: string
  estimatedSavingsMs: number  // min(upstream.duration, downstream.duration) — the time spent running them serially that would overlap in parallel
}

export function findParallelSuggestions(
  nodes: Node[],
  edges: Edge[],
  testSteps: Array<{ step_namespace: string; duration_ms: number; parallel_group_id?: string | null }>
): ParallelSuggestion[] {
  const nodeByNs = new Map<string, Node>()
  for (const n of nodes) {
    const ns = (n.data as unknown as CanvasNodeData | undefined)?.namespace
    if (ns) nodeByNs.set(ns, n)
  }

  const durationByNs = new Map<string, number>()
  for (const s of testSteps) {
    // Skip parallel children — they're already in a parallel group
    if (s.parallel_group_id) continue
    durationByNs.set(s.step_namespace, s.duration_ms)
  }

  const suggestions: ParallelSuggestion[] = []
  const seen = new Set<string>()

  for (const edge of edges) {
    const sourceNode = nodes.find((n) => n.id === edge.source)
    const targetNode = nodes.find((n) => n.id === edge.target)
    if (!sourceNode || !targetNode) continue

    if (isStructural(sourceNode.type) || isStructural(targetNode.type)) continue

    const sourceNs = (sourceNode.data as unknown as CanvasNodeData | undefined)?.namespace
    const targetNs = (targetNode.data as unknown as CanvasNodeData | undefined)?.namespace
    if (!sourceNs || !targetNs) continue

    // Deduplicate suggestions
    const key = `${sourceNs}::${targetNs}`
    if (seen.has(key)) continue
    seen.add(key)

    // Does target reference source's namespace in its config?
    const targetRefs = scanNodeConfig(targetNode.data as unknown as CanvasNodeData)
    if (targetRefs.has(sourceNs)) continue  // real dependency — can't parallelize

    // Both steps need durations from the test run to estimate savings
    const srcDur = durationByNs.get(sourceNs)
    const tgtDur = durationByNs.get(targetNs)
    if (srcDur === undefined || tgtDur === undefined) continue

    // Skip if both are very fast — parallelizing adds overhead, not worth it for <50ms each
    if (srcDur < 50 && tgtDur < 50) continue

    const estimatedSavingsMs = Math.min(srcDur, tgtDur)

    suggestions.push({
      upstream: sourceNs,
      downstream: targetNs,
      upstreamLabel: (sourceNode.data as unknown as CanvasNodeData | undefined)?.label || sourceNs,
      downstreamLabel: (targetNode.data as unknown as CanvasNodeData | undefined)?.label || targetNs,
      estimatedSavingsMs,
    })
  }

  // Biggest savings first
  suggestions.sort((a, b) => b.estimatedSavingsMs - a.estimatedSavingsMs)
  return suggestions
}

export function mapStepToExecution(step: ExecutionStep): ExecutionStep {
  return step
}
