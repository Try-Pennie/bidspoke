'use client'

import { useEffect } from 'react'
import { Handle, Position, useStore, useUpdateNodeInternals } from '@xyflow/react'
import type { NodeProps, Node, Edge } from '@xyflow/react'
import type { CanvasNodeData } from '@/types/workflow'
import { GitMerge } from 'lucide-react'
import { getNodeClasses, getExecutionStyle } from './execution-status'
import { SuccessBadge } from './SuccessBadge'
import { NoteBadge } from './NoteBadge'
import { nodeWidth } from '@/lib/layout'

export function BranchEndNode({ id, data, selected }: NodeProps) {
  const { executionStep, hasError, isReachable, isSuccessNode, note } = data as unknown as CanvasNodeData
  const pairId = (data as { _pairId?: string })._pairId

  const startNode = useStore((s) => {
    if (!pairId) return null
    return (s.nodes as Node[]).find((n) => n.id === pairId) ?? null
  })
  // Real chains wired into this branch_end (anything other than the hidden
  // backbone from the paired branch). When there are none, render compact so
  // a backfilled-but-unused branch_end doesn't stack a wide grey region at
  // the bottom of the canvas.
  const hasRealIncoming = useStore((s) => {
    return (s.edges as Edge[]).some((e) => e.target === id && e.source !== pairId)
  })

  // Every chain from the paired branch terminates in an exit / response that
  // ends the workflow. There's no path for the user to wire into branch_end,
  // but the branch's job IS to converge here — we render it as if connected
  // so the visual still looks complete (full card under the cluster).
  const allChainsTerminate = useStore((s) => {
    if (!pairId) return false
    const allNodes = s.nodes as Node[]
    const allEdges = s.edges as Edge[]
    const seedTargets: string[] = []
    for (const e of allEdges) {
      if (e.source !== pairId) continue
      if (!e.sourceHandle || e.sourceHandle === 'output') continue
      seedTargets.push(e.target)
    }
    if (seedTargets.length === 0) return false
    const visited = new Set<string>()
    const queue = [...seedTargets]
    const leaves = new Set<string>()
    while (queue.length > 0) {
      const cur = queue.shift() as string
      if (visited.has(cur)) continue
      visited.add(cur)
      const outs = allEdges.filter((e) => e.source === cur && e.target !== id)
      if (outs.length === 0) {
        leaves.add(cur)
      } else {
        for (const o of outs) queue.push(o.target)
      }
    }
    if (leaves.size === 0) return false
    for (const leafId of leaves) {
      const leaf = allNodes.find((n) => n.id === leafId)
      if (!leaf) return false
      if (leaf.type === 'exit') continue
      if (leaf.type === 'response') {
        const cfg = (leaf.data as { config?: { continue_after_response?: boolean } } | undefined)?.config
        if (!cfg?.continue_after_response) continue
      }
      return false
    }
    return true
  })

  // The branch_end is "effectively connected" when there's a real wire into
  // it OR every chain ends in a workflow-terminating node — both states mean
  // the branch's convergence is meaningful, so we render it as the full card.
  const effectivelyConnected = hasRealIncoming || allChainsTerminate

  // The render shape (compact pill vs full card) changes the handle DOM
  // positions. Without re-registering, React Flow's handle position cache
  // stays stuck on the previous shape and a connection drag from the bottom
  // handle aims at the wrong screen point — which feels like "I can't
  // connect branch ends to each other anymore."
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, effectivelyConnected, updateNodeInternals])
  const startData = startNode?.data as CanvasNodeData | undefined
  const startLabel = startData?.label || startData?.namespace || 'branch'
  const derivedLabel = `${startLabel} End`
  const derivedNamespace = `${startData?.namespace ?? 'branch'}_end`

  if (!effectivelyConnected) {
    // Compact pill — present and wirable, but visually out of the way until
    // the user actually feeds a chain into it. Wrap in a NODE_W-wide flex
    // container that centers the pill so the visual matches the layout's
    // position math: layout writes `position.x = center - NODE_W/2` for an
    // unconnected branch_end, so the rendered DOM must also occupy that full
    // width or the auto-sized inline pill drifts left-of-center.
    return (
      <div className="flex justify-center" style={{ width: nodeWidth('branch_end', data) }}>
        <div
          className={`relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border bg-white px-3 py-1 text-xs ${
            selected ? 'border-purple-400 ring-2 ring-purple-200' : 'border-purple-100'
          } ${getNodeClasses(executionStep, hasError, isReachable)}`}
          style={getExecutionStyle(executionStep)}
        >
          <NoteBadge note={note} />
          <Handle type="target" position={Position.Top} id="input" />
          <GitMerge className="h-3 w-3 shrink-0 text-purple-400" />
          <span className="font-medium text-purple-500">{derivedLabel}</span>
          <Handle type="source" position={Position.Bottom} id="output" />
        </div>
      </div>
    )
  }

  // Match the paired branch's effective width so the join visually closes the
  // cluster instead of being a narrow box under a wide branch.
  const startSpanWidth = (startData as { _spanWidth?: number } | undefined)?._spanWidth
  const width = startSpanWidth ?? nodeWidth('branch_end', data)

  return (
    <div
      className={`relative rounded-lg border bg-white shadow-sm ${
        selected ? 'border-purple-400 ring-2 ring-purple-200' : hasError ? 'border-amber-400 ring-2 ring-amber-100' : 'border-gray-200'
      } ${getNodeClasses(executionStep, hasError, isReachable)}`}
      style={{ ...getExecutionStyle(executionStep), width }}
    >
      <SuccessBadge visible={isSuccessNode} />
      <NoteBadge note={note} />
      <Handle type="target" position={Position.Top} id="input" />

      <div className="flex items-center gap-2 rounded-t-lg bg-purple-50 border-b border-purple-100 px-3 py-2">
        <GitMerge className="h-4 w-4 text-purple-500" />
        <span className="text-xs font-semibold uppercase tracking-wide text-purple-700">Branch End</span>
      </div>

      <div className="px-3 py-2">
        <p className="truncate text-sm font-semibold text-graphite">{derivedLabel}</p>
        <p className="truncate font-mono text-xs text-slate-400">{derivedNamespace}</p>
        <p className="mt-0.5 truncate text-xs text-slate-400">(end)</p>
      </div>

      <Handle type="source" position={Position.Bottom} id="output" />
    </div>
  )
}
