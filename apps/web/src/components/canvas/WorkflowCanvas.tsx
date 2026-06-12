'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  addEdge,
  useNodesState,
  useEdgesState,
  useNodesInitialized,
  useReactFlow,
  useUpdateNodeInternals,
  useViewport,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  type OnConnect,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { FilterNode } from './nodes/FilterNode'
import { BranchNode } from './nodes/BranchNode'
import { BranchEndNode } from './nodes/BranchEndNode'
import { CodeNode } from './nodes/CodeNode'
import { ResponseNode } from './nodes/ResponseNode'
import { ExitNode } from './nodes/ExitNode'
import { TriggerNode } from './nodes/TriggerNode'
import { GenericNode } from './nodes/GenericNode'
import { BidEvaluationNode } from './nodes/BidEvaluationNode'
import { BidGroupNode } from './nodes/BidGroupNode'
import { TransformNode } from './nodes/TransformNode'
import { IntegrationNode } from './nodes/IntegrationNode'
import { PartnerBidNode } from './nodes/PartnerBidNode'
import { ParallelNode } from './nodes/ParallelNode'
import { ParallelEndNode } from './nodes/ParallelEndNode'
import { ConstantsNode } from './nodes/ConstantsNode'
import { SalesforceNode } from './nodes/SalesforceNode'
import { DataStoreNode } from './nodes/DataStoreNode'
import { LatencyGateNode } from './nodes/LatencyGateNode'
import { AchieveOffersNode } from './nodes/AchieveOffersNode'
import { RegionNode } from './nodes/RegionNode'
import { TimeoutSuggestionsProvider } from './nodes/timeout-suggestions'
import { ConvergeEdge } from './edges/ConvergeEdge'
import { LateBendEdge } from './edges/LateBendEdge'
import NodePalette from './NodePalette'
import ConfigPanel from './ConfigPanel'
import { api } from '@/lib/api'
import { layoutWorkflow, findFreePosition, overlapsAny, NODE_W, nodeHeight, nodeWidth, configuredHandleIds, DISCONNECTED_GAP } from '@/lib/layout'
import type { Workflow, WorkflowDef, NodeType, NodeDef, EdgeDef, CanvasNodeData } from '@/types/workflow'
import { Save, Undo2, Redo2, Clock, Check, AlertCircle, AlertTriangle, Eye, X, Pencil, RotateCcw, Loader2, FlaskConical, ExternalLink, Trash2, CopyPlus } from 'lucide-react'
import { validateWorkflow, type ValidationError } from '@/lib/workflow-validation'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import TriggerExecutionPanel from './TriggerExecutionPanel'
import { reachableFromTrigger } from './reachability'
import ExecutionListPanel from './ExecutionListPanel'
import TestRunPanel from './TestRunPanel'
import TriggerConfigPanel from './TriggerConfigPanel'
import VersionHistoryPanel from './VersionHistoryPanel'
import type { ExecutionStep } from '@/types/workflow'
import { writeClipboard, readClipboard } from '@/lib/clipboard'
import { computeEdgesAfterDelete } from '@/lib/splice-edges'
import { onBeforeNodeDelete } from '@/lib/delete-routing'
import {
  renameStepReferences,
  countStepReferences,
  countBareNamespaceRefs,
  renameBareNamespaceFields,
  renameNamespaceInList,
} from '@/lib/rename-step-references'
import RenameConfirmDialog, { type PartnerFormulaImpact } from './RenameConfirmDialog'

// Defined outside component to prevent re-render on each render
const nodeTypes: NodeTypes = {
  trigger: TriggerNode,
  filter: FilterNode,
  branch: BranchNode,
  branch_end: BranchEndNode,
  code: CodeNode,
  response: ResponseNode,
  exit: ExitNode,
  webhook: IntegrationNode,
  partner_bid: PartnerBidNode,
  transform: TransformNode,
  parallel: ParallelNode,
  parallel_end: ParallelEndNode,
  bid_evaluation: BidEvaluationNode,
  bid_group: BidGroupNode,
  constants: ConstantsNode,
  salesforce: SalesforceNode,
  data_store: DataStoreNode,
  latency_gate: LatencyGateNode,
  achieve_offers: AchieveOffersNode,
  region: RegionNode,
}

const edgeTypes = {
  converge: ConvergeEdge,
  lateBend: LateBendEdge,
}


function makeTriggerNode(trigger: WorkflowDef['trigger']): Node {
  return {
    id: 'trigger',
    type: 'trigger',
    position: { x: 0, y: 0 },
    data: { trigger },
    deletable: false,
  }
}

const DEFAULT_TRIGGER: WorkflowDef['trigger'] = {
  type: 'http_webhook',
  config: { method: 'POST', auth_method: 'api_key' },
}

// ── Conversion helpers ────────────────────────────────────────────────────────

// Computes render-only convergence edges from each slot child's chain leaf
// to the paired parallel_end. Not added to canvas state — they don't get
// saved or fed to the engine — but they make the visual model match the
// engine's behavior (chains converge at parallel_end). One edge per slot.
function computeConvergenceEdges(
  nodes: Node[],
  edges: Edge[]
): Edge[] {
  const result: Edge[] = []
  const realEdgeKey = new Set(edges.map((e) => `${e.source}->${e.target}`))

  for (const parallel of nodes) {
    if (parallel.type !== 'parallel') continue
    const pairEdge = edges.find((e) => {
      if (e.source !== parallel.id) return false
      const target = nodes.find((n) => n.id === e.target)
      return target?.type === 'parallel_end'
    })
    if (!pairEdge) continue
    const pairId = pairEdge.target

    const slotEdges = edges.filter(
      (e) => e.source === parallel.id && (e.sourceHandle ?? '').startsWith('child-')
    )
    for (const slotEdge of slotEdges) {
      let current = slotEdge.target
      const visited = new Set<string>([parallel.id])
      while (!visited.has(current)) {
        visited.add(current)
        if (current === pairId) break
        const next = edges.find((e) => e.source === current && !visited.has(e.target))
        if (!next) break
        current = next.target
      }
      if (current === pairId) continue
      if (realEdgeKey.has(`${current}->${pairId}`)) continue
      result.push({
        id: `conv-${current}-${pairId}`,
        source: current,
        target: pairId,
        sourceHandle: 'output',
        // Late-bend routing: each chain leaf descends in its own column, then
        // turns horizontally near parallel_end to converge. Avoids the
        // mid-canvas horizontal segment that smoothstep produces.
        type: 'converge',
        style: { stroke: '#94a3b8', strokeDasharray: '4 4' },
      })
    }
  }

  return result
}

// Computes translucent region backdrops for each branch / parallel and the
// nodes downstream of it. Outer regions get lower zIndex (further behind)
// than inner regions; both stay behind real nodes (zIndex < 0). Region nodes
// are pointer-events-none so clicks/drags reach the real graph.
function computeRegionNodes(nodes: Node[], edges: Edge[]): Node[] {
  const moNodes = nodes.filter((n) => n.type === 'branch' || n.type === 'parallel')
  if (moNodes.length === 0) return []

  const adjOut = new Map<string, string[]>()
  for (const e of edges) {
    const arr = adjOut.get(e.source) ?? []
    arr.push(e.target)
    adjOut.set(e.source, arr)
  }

  type RegionInfo = { id: string; nodeIds: Set<string>; minX: number; minY: number; maxX: number; maxY: number; variant: 'branch' | 'parallel' }
  const regions: RegionInfo[] = []
  for (const mo of moNodes) {
    // For parallels, the BFS stops at the paired parallel_end — anything
    // past the join is downstream of the whole cluster, not inside it.
    // For branches, "convergence" is detected dynamically: any node that's
    // reachable from EVERY handle marks where both branch paths rejoin
    // (Pipedream-style "branch end"). Those convergence nodes and their
    // downstream are excluded from the branch's region.
    let pairId: string | null = null
    let stopAt: Set<string> | null = null
    if (mo.type === 'parallel') {
      const pairEdge = edges.find((e) => {
        if (e.source !== mo.id) return false
        const target = nodes.find((n) => n.id === e.target)
        return target?.type === 'parallel_end'
      })
      if (pairEdge) pairId = pairEdge.target
    } else {
      // Both signals can apply for branches:
      //  - Explicit branch_end paired via the hidden backbone edge — used as
      //    a hard join marker (BFS includes it but doesn't recurse past).
      //  - Dynamic convergence — any node reachable from EVERY handle, kept
      //    as a stopAt set so the region also closes at the natural rejoin
      //    point even when the backfilled branch_end isn't wired up yet.
      const pairData = mo.data as { _pairId?: string }
      const explicitEnd = pairData._pairId
        ? nodes.find((n) => n.id === pairData._pairId && n.type === 'branch_end')
        : null
      if (explicitEnd) pairId = explicitEnd.id

      const handles = configuredHandleIds(mo)
      if (handles && handles.length >= 2) {
        const perHandle = handles.map((h) => {
          const slotEdge = edges.find((e) => e.source === mo.id && e.sourceHandle === h)
          if (!slotEdge) return new Set<string>()
          const set = new Set<string>([slotEdge.target])
          const q = [slotEdge.target]
          while (q.length > 0) {
            const cur = q.shift() as string
            for (const next of adjOut.get(cur) ?? []) {
              if (set.has(next)) continue
              set.add(next)
              q.push(next)
            }
          }
          return set
        }).filter((s) => s.size > 0)
        if (perHandle.length >= 2) {
          // Convergence = nodes in *every* handle's reachable set.
          stopAt = new Set<string>()
          for (const id of perHandle[0]) {
            if (perHandle.every((s) => s.has(id))) stopAt.add(id)
          }
        }
      }
    }
    const reachable = new Set<string>([mo.id])
    const queue = [mo.id]
    while (queue.length > 0) {
      const cur = queue.shift() as string
      if (cur === pairId) continue // include the parallel_end but don't recurse past it
      for (const next of adjOut.get(cur) ?? []) {
        if (reachable.has(next)) continue
        if (stopAt && stopAt.has(next)) continue // skip converge-and-beyond entirely
        // Stop at an OUTER end: a branch_end/parallel_end whose paired START
        // lives outside this region means the flow has exited this container's
        // scope (e.g. a multi-output's `output` handle rejoining an ancestor's
        // end). Without this the BFS walks bid_race.output → the outer
        // branch_end → its downstream, and the grey backdrop balloons far past
        // the container's real content. This container's OWN end (pairId) and
        // any nested end (whose start was already visited) still pass.
        const nextNode = nodes.find((n) => n.id === next)
        if (
          next !== pairId &&
          (nextNode?.type === 'branch_end' || nextNode?.type === 'parallel_end')
        ) {
          const startId = (nextNode.data as { _pairId?: string })?._pairId
          if (startId && !reachable.has(startId)) continue
        }
        reachable.add(next)
        queue.push(next)
      }
    }
    if (reachable.size === 1) continue // no descendants — nothing to wrap
    // Identify the paired end node (parallel_end / branch_end via backbone),
    // if any. The start node and the paired end "cradle" the region —
    // region top sits at the start node's vertical center and region
    // bottom sits at the end node's vertical center, so each appears half
    // inside / half outside the cluster (Pipedream-style).
    let pairedEndId: string | null = null
    for (const e of edges) {
      if (e.source !== mo.id) continue
      const tgt = nodes.find((n) => n.id === e.target)
      if (mo.type === 'parallel' && tgt?.type === 'parallel_end') { pairedEndId = e.target; break }
      if (mo.type === 'branch' && tgt?.type === 'branch_end') { pairedEndId = e.target; break }
    }
    // The paired end is a convergence node, so the `stopAt` step above excludes
    // it from `reachable`. Add it back so it cradles the region — otherwise the
    // backdrop stops at the bottom of the branch bodies and never reaches the
    // branch_end's vertical center (the "half inside the end node" look).
    if (pairedEndId) reachable.add(pairedEndId)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of nodes) {
      if (!reachable.has(n.id)) continue
      const w = nodeWidth(n.type, n.data)
      const h = nodeHeight(n.type)
      minX = Math.min(minX, n.position.x)
      maxX = Math.max(maxX, n.position.x + w)
      // For the start node: only its bottom half contributes to vertical
      // bbox. For the paired end: only its top half contributes. Other
      // reachable nodes contribute their full extent.
      const top = n.id === mo.id ? n.position.y + h / 2 : n.position.y
      const bottom = n.id === pairedEndId ? n.position.y + h / 2 : n.position.y + h
      minY = Math.min(minY, top)
      maxY = Math.max(maxY, bottom)
    }
    // Extend the region to cover all configured handle columns, even unused
    // ones. Without this, an unfilled branch handle (e.g. `trades_missing`
    // with no children) leaves no visual trace, and the connected chain
    // appears to occupy the whole branch's territory. With the extension,
    // the region's right (or left) edge stretches into the empty column,
    // making it clear at a glance that one side has nothing on it.
    const handles = configuredHandleIds(mo)
    if (handles && handles.length >= 2) {
      const moW = nodeWidth(mo.type, mo.data)
      const moCenterX = mo.position.x + moW / 2
      const SIBLING_SPACING_PX = NODE_W + 48
      const halfSpan = ((handles.length - 1) / 2) * SIBLING_SPACING_PX
      const fullColumnLeft = moCenterX - halfSpan - NODE_W / 2
      const fullColumnRight = moCenterX + halfSpan + NODE_W / 2
      minX = Math.min(minX, fullColumnLeft)
      maxX = Math.max(maxX, fullColumnRight)
    }
    regions.push({
      id: mo.id,
      nodeIds: reachable,
      minX, minY, maxX, maxY,
      variant: mo.type as 'branch' | 'parallel',
    })
  }

  // Defensive: parent regions must always encompass nested child regions.
  // BFS bboxes can go slightly out of sync when nested multi-output nodes
  // have wider effective widths than their parent's BFS measured (e.g., a
  // Tripoint Creation branch with 3 phantom slot widths inside a Send To
  // Winner branch with 2 narrower slots). Without this, the inner region's
  // backdrop can poke outside the outer region's backdrop.
  for (const a of regions) {
    for (const b of regions) {
      if (a === b) continue
      // a contains b iff every node in b's reachable is in a's reachable
      // AND b's start is in a's reachable (the cheap check first).
      if (!a.nodeIds.has(b.id)) continue
      let containsAll = true
      for (const id of b.nodeIds) {
        if (!a.nodeIds.has(id)) { containsAll = false; break }
      }
      if (!containsAll) continue
      if (b.minX < a.minX) a.minX = b.minX
      if (b.minY < a.minY) a.minY = b.minY
      if (b.maxX > a.maxX) a.maxX = b.maxX
      if (b.maxY > a.maxY) a.maxY = b.maxY
    }
  }

  // Inner padding (around content) is what makes the backdrop feel like a
  // container; gap subtracted on each side keeps sibling region edges from
  // touching, so two adjacent branches read as separate clusters even though
  // their subtrees sit 48px apart (NODESEP_PRE) at the layout level.
  // Vertical PAD is zero — minY/maxY are already the start/end nodes' vertical
  // centers, so the region's top and bottom sit exactly halfway through them.
  const PAD = 24
  const SIBLING_GAP = 16
  return regions.map((r) => {
    const depth = regions.filter((other) => other.id !== r.id && other.nodeIds.has(r.id)).length
    const inset = SIBLING_GAP / 2
    const width = r.maxX - r.minX + PAD * 2 - inset * 2
    const height = r.maxY - r.minY
    return {
      id: `region-${r.id}`,
      type: 'region',
      position: { x: r.minX - PAD + inset, y: r.minY },
      // width / height at the top level so React Flow skips its measurement
      // step. Without these, React Flow's ResizeObserver would write back
      // measured dimensions on every render → setNodes → recompute regions →
      // measure again → infinite loop.
      width,
      height,
      data: { width, height, depth, variant: r.variant },
      draggable: false,
      selectable: false,
      // Make the wrapper itself pass-through. The inner div is also
      // pointer-events:none, but React Flow's outer node wrapper still
      // captures clicks/drags otherwise — so nodes sitting on top of a
      // region (e.g., webhook inside parallel cluster) become unclickable.
      style: { pointerEvents: 'none' as const },
      // Regions must sit BEHIND real nodes so their translucent grey doesn't
      // darken node text. Real nodes use React Flow's default zIndex (0), so a
      // non-negative region zIndex (e.g. a nested region at depth >= 1) would
      // stack ON TOP of the node it wraps. Push regions to a deep negative
      // band; deeper regions still get a larger value so they stack atop their
      // containing region, but the whole band stays below 0 (real nodes).
      zIndex: -1000 + depth,
    } as Node
  })
}

function migrateParallelEdges(nodes: NodeDef[], edges: EdgeDef[]): EdgeDef[] {
  const parallelNodes = nodes.filter((n) => n.type === 'parallel' && (n.children?.length ?? 0) > 0)
  if (parallelNodes.length === 0) return edges

  let result = [...edges]

  for (const pNode of parallelNodes) {
    const childIds = new Set(pNode.children ?? [])
    // Already has fan-out edges — skip migration
    if (result.some((e) => e.source === pNode.id && (e.source_handle ?? '').startsWith('child-'))) continue

    // Remove sequential edges between children
    result = result.filter((e) => !(childIds.has(e.source) && childIds.has(e.target)))
    // Remove the old single sequential edge from parallel to its first child
    result = result.filter((e) => !(e.source === pNode.id && childIds.has(e.target)))

    // Add fan-out edges from parallel to each child
    const children = pNode.children ?? []
    for (let i = 0; i < children.length; i++) {
      result.push({
        id: `${pNode.id}-child-${i}`,
        source: pNode.id,
        target: children[i],
        source_handle: `child-${i}`,
      })
    }
  }

  return result
}

// Backfill branch_end nodes for any branch that doesn't already have one.
// Mirrors the parallel start/end pattern. The synthesized backbone edge is
// hidden but persists through save → load round-trips so the pairing
// sticks; the engine never traverses backbone edges (branch routing requires
// a `_route`-matched named handle), so this is safe for live workflows.
function backfillBranchEnds(nodes: NodeDef[], edges: EdgeDef[]): { nodes: NodeDef[]; edges: EdgeDef[] } {
  const branchesNeedingEnd = nodes.filter((n) => {
    if (n.type !== 'branch') return false
    const incomingToEnds = edges
      .filter((e) => e.source === n.id)
      .map((e) => nodes.find((x) => x.id === e.target))
    return !incomingToEnds.some((t) => t?.type === 'branch_end')
  })
  if (branchesNeedingEnd.length === 0) return { nodes, edges }

  const usedNamespaces = new Set(nodes.map((n) => n.namespace))
  const newNodes: NodeDef[] = []
  const newEdges: EdgeDef[] = []
  for (const branch of branchesNeedingEnd) {
    const baseNs = `${branch.namespace}_end`
    let ns = baseNs
    let i = 2
    while (usedNamespaces.has(ns)) ns = `${baseNs}_${i++}`
    usedNamespaces.add(ns)
    const endId = crypto.randomUUID()
    newNodes.push({
      id: endId,
      namespace: ns,
      type: 'branch_end',
      position: { x: 0, y: 0 }, // dagre will place it on the next layout pass
      config: {},
      variables: {},
    })
    newEdges.push({
      id: crypto.randomUUID(),
      source: branch.id,
      target: endId,
      source_handle: 'output',
    })
  }
  return { nodes: [...nodes, ...newNodes], edges: [...edges, ...newEdges] }
}

// Push any nodes that are no longer reachable from the trigger off to the right
// of the main flow, keeping them at their current Y and marking manualPosition
// so dagre won't re-align them. Used by every code path that can orphan nodes
// (single delete, multi-delete, removeFromChain, disconnect, deleteEdge).
function shiftOrphansRight(allNodes: Node[], newEdges: Edge[]): Node[] {
  const reachable = reachableFromTrigger(allNodes, newEdges)
  const orphanIds = new Set(allNodes.filter((n) => !reachable.has(n.id) && n.id !== 'trigger').map((n) => n.id))
  if (orphanIds.size === 0) return allNodes

  const mainMaxX = Math.max(
    0,
    ...allNodes.filter((n) => !orphanIds.has(n.id)).map((n) => n.position.x + NODE_W)
  )
  const orphansMinX = Math.min(
    Infinity,
    ...allNodes.filter((n) => orphanIds.has(n.id)).map((n) => n.position.x)
  )
  const shift = Math.max(0, mainMaxX + DISCONNECTED_GAP - orphansMinX)

  return allNodes.map((n) => {
    if (!orphanIds.has(n.id)) return n
    const d = n.data as unknown as CanvasNodeData
    return {
      ...n,
      position: { x: n.position.x + shift, y: n.position.y },
      data: d.manualPosition === true ? n.data : { ...(n.data as object), manualPosition: true },
    }
  })
}

function defToNodes(nodes: NodeDef[], edges: EdgeDef[], trigger?: WorkflowDef['trigger']): Node[] {
  const migratedEdges = migrateParallelEdges(nodes, edges)
  // Detect if any parallel_end carries the old (pre-2026-04-30) wait_for/timeout
  // config so we can copy it onto the matching start node before the canvas reads it.
  const endConfigByPairStart = new Map<string, Record<string, unknown>>()
  for (const n of nodes) {
    if (n.type !== 'parallel_end') continue
    const incoming = migratedEdges.filter((e) => e.target === n.id)
    const start = incoming.map((e) => nodes.find((x) => x.id === e.source))
      .find((x) => x?.type === 'parallel')
    if (!start) continue
    if (n.config && Object.keys(n.config).length > 0) endConfigByPairStart.set(start.id, n.config)
  }

  // Re-derive `_pairId` for every parallel_end / branch_end pair so end nodes
  // can look up their start to render the derived label after reload.
  // Pair = the start node with a direct (often hidden) edge into the end node.
  const pairByEnd = new Map<string, string>()
  const pairByStart = new Map<string, string>()
  for (const n of nodes) {
    if (n.type !== 'parallel_end' && n.type !== 'branch_end') continue
    const startType = n.type === 'parallel_end' ? 'parallel' : 'branch'
    const incoming = migratedEdges.filter((e) => e.target === n.id)
    const start = incoming
      .map((e) => nodes.find((x) => x.id === e.source))
      .find((x) => x?.type === startType)
    if (!start) continue
    pairByEnd.set(n.id, start.id)
    pairByStart.set(start.id, n.id)
  }

  const workflowNodes = nodes.map((n) => {
    let config = n.config
    if (n.type === 'parallel') {
      // Normalize legacy `NodeDef.children: string[]` and `config.children: string[]`
      // into the new slot shape `{ id, label }[]`. Slot ids reuse the legacy
      // child-N positional convention so existing edges continue to match.
      const rawChildren = (n.config?.children ?? n.children) as unknown
      let slots: { id: string; label: string }[] = []
      if (Array.isArray(rawChildren) && rawChildren.length > 0) {
        if (typeof rawChildren[0] === 'string') {
          slots = (rawChildren as string[]).map((_, i) => ({ id: `child-${i}`, label: `child_${i + 1}` }))
        } else {
          slots = rawChildren as { id: string; label: string }[]
        }
      }
      config = {
        ...n.config,
        children: slots,
        // Backfill the wait_for/timeout config that used to live on the end node.
        ...(endConfigByPairStart.has(n.id) ? endConfigByPairStart.get(n.id) : {}),
      }
    }
    if (n.type === 'parallel_end') {
      // Strip end-node config — moved to start. Keep an empty object so editors can write to it.
      config = {}
    }
    const pairId = pairByEnd.get(n.id) ?? pairByStart.get(n.id)
    return {
      id: n.id,
      type: n.type,
      position: n.position ?? { x: 0, y: 0 },
      data: {
        namespace: n.namespace,
        label: n.label,
        note: n.note,
        config,
        variables: n.variables ?? {},
        ...(pairId ? { _pairId: pairId } : {}),
      } satisfies CanvasNodeData,
    }
  })
  const allNodes = [makeTriggerNode(trigger ?? DEFAULT_TRIGGER), ...workflowNodes]
  const flowEdges = defToEdges(migratedEdges)
  // Mark unreachable-from-trigger nodes as manualPosition so layoutWorkflow
  // preserves their stored positions — otherwise dagre re-aligns disconnected
  // subgraphs to the top on every page load.
  const reachable = reachableFromTrigger(allNodes, flowEdges)
  const withManual = allNodes.map((n) => {
    if (n.id === 'trigger' || reachable.has(n.id)) return n
    return { ...n, data: { ...(n.data as object), manualPosition: true } }
  })
  return layoutWorkflow(withManual, flowEdges)
}

function defToEdges(edges: EdgeDef[]): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.source_handle ?? null,
    data: { condition: e.condition },
    ...(e.hidden ? { hidden: true } : {}),
  }))
}

function flowToDef(
  nodes: Node[],
  edges: Edge[],
  trigger: WorkflowDef['trigger']
): WorkflowDef {
  return {
    trigger,
    nodes: nodes.filter((n) => n.id !== 'trigger').map((n) => {
      const d = n.data as unknown as CanvasNodeData
      return {
        id: n.id,
        namespace: d.namespace,
        label: d.label || undefined,
        note: d.note || undefined,
        type: n.type as NodeType,
        position: n.position,
        config: d.config,
        variables: d.variables,
      }
    }),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      source_handle: e.sourceHandle ?? undefined,
      condition: (e.data as { condition?: EdgeDef['condition'] })?.condition,
      ...(e.hidden ? { hidden: true } : {}),
    })),
  }
}

function uid() {
  return crypto.randomUUID()
}

function defaultNamespace(type: NodeType, existing: string[]): string {
  const base = type.replace('_', '_')
  let i = 1
  while (existing.includes(`${base}_${i}`)) i++
  return `${base}_${i}`
}

/** Return `suggested` if free, else `suggested_2`, `suggested_3`, ... */
function dedupNamespace(suggested: string, existing: string[]): string {
  if (!existing.includes(suggested)) return suggested
  let i = 2
  while (existing.includes(`${suggested}_${i}`)) i++
  return `${suggested}_${i}`
}

/**
 * Name for a duplicated node: strip any trailing number off the original
 * (so repeated copies increment rather than stack `_copy_copy`), then append
 * the smallest free counter — `_1` / ` 1`, bumping to `_2`/` 2`, `_3`/` 3`, …
 * until the namespace is free. Namespace drives the counter; the label reuses
 * the same number so the two stay in sync.
 */
function nextCopyName(namespace: string, label: string, existing: string[]): { namespace: string; label: string } {
  const baseNs = namespace.replace(/_\d+$/, '')
  const baseLabel = (label && label.length > 0 ? label : namespace).replace(/\s+\d+$/, '')
  let n = 1
  while (existing.includes(`${baseNs}_${n}`)) n++
  return { namespace: `${baseNs}_${n}`, label: `${baseLabel} ${n}` }
}

function defaultNodeConfig(type: NodeType): Record<string, unknown> {
  // parallel_end / branch_end are passive join markers — retry/error config sits on the start
  const base: Record<string, unknown> = type === 'parallel_end' || type === 'branch_end' ? {} : { retries: 2 }
  if (type === 'branch') {
    return {
      ...base,
      branches: [{ label: 'branch_1', condition: { groups: [{ conditions: [], logic: 'AND' }], logic: 'AND' } }],
      use_else: true,
    }
  }
  if (type === 'constants') {
    return { ...base, data: {} }
  }
  if (type === 'achieve_offers') {
    // wait_for_offers holds the request up to 10s, so the timeout needs
    // headroom; retries 0 because retrying a transport failure risks
    // double-submitting the lead to Achieve.
    return { ...base, targeted_products: ['fdr'], wait_for_offers: true, timeout_ms: 15000, retries: 0 }
  }
  if (type === 'bid_group') {
    return {
      ...base,
      mode: 'highest_bid',
      partner_ids: [],
      no_winner_behavior: 'route',
    }
  }
  return base
}

// ── Auto-connect helpers ─────────────────────────────────────────────────────

// Picks the bottom source handle on `source` whose horizontal position is
// closest to `dropX` (a flow-coordinate x). Returns null for terminal nodes
// and for parallel (which uses a separate child-picker UI).
function chooseSourceHandle(
  source: Node,
  dropX: number
): string | null {
  const type = source.type ?? ''
  const config = (source.data as { config?: Record<string, unknown> } | undefined)?.config
  if (type === 'exit') return null
  if (type === 'response') return config?.continue_after_response ? 'output' : null

  if (type === 'parallel') {
    const slots = (config?.children as Array<{ id: string }> | string[] | undefined) ?? []
    if (!Array.isArray(slots) || slots.length === 0) return null
    const ids: string[] = typeof slots[0] === 'string'
      ? (slots as string[]).map((_, i) => `child-${i}`)
      : (slots as Array<{ id: string }>).map((s) => s.id)
    const w = nodeWidth('parallel', source.data)
    return nearestHandleId(
      ids.map((id, i) => ({ id, x: source.position.x + (w * (i + 0.5)) / ids.length })),
      dropX
    )
  }

  if (type === 'branch') {
    const branches = (config?.branches as { label: string }[] | undefined) ?? []
    const elseBehavior =
      (config?.else_behavior as 'output' | 'none' | 'error' | undefined) ??
      ((config?.use_else as boolean | undefined) === false ? 'none' : 'output')
    const ids = [
      ...branches.map((b) => b.label),
      ...(elseBehavior === 'output' ? ['else'] : []),
    ]
    if (ids.length === 0) return null
    const w = nodeWidth('branch', source.data)
    return nearestHandleId(
      ids.map((id, i) => ({ id, x: source.position.x + (w * (i + 0.5)) / ids.length })),
      dropX
    )
  }

  if (type === 'filter') {
    return nearestHandleId(
      [
        { id: 'pass', x: source.position.x + NODE_W * 0.3 },
        { id: 'exit', x: source.position.x + NODE_W * 0.7 },
      ],
      dropX
    )
  }

  if (type === 'bid_evaluation' || type === 'bid_group') {
    return nearestHandleId(
      [
        { id: 'winner', x: source.position.x + NODE_W * 0.3 },
        { id: 'no_winner', x: source.position.x + NODE_W * 0.7 },
      ],
      dropX
    )
  }

  if (type === 'latency_gate') {
    const op = (config?.operation as string | undefined) ?? 'mark'
    if (op !== 'check') return 'output'
    return nearestHandleId(
      [
        { id: 'within', x: source.position.x + NODE_W * 0.3 },
        { id: 'exceeded', x: source.position.x + NODE_W * 0.7 },
      ],
      dropX
    )
  }

  return 'output'
}

function nearestHandleId(handles: { id: string; x: number }[], dropX: number): string {
  return handles.reduce((best, h) =>
    Math.abs(h.x - dropX) < Math.abs(best.x - dropX) ? h : best
  ).id
}

// Find the best candidate to auto-connect FROM given a drop position.
// First preference: a multi-output source whose unfilled slot aligns
// horizontally with the drop. Otherwise, the node whose bottom edge is
// highest above the drop point, within a generous horizontal tolerance.
function findDropSource(nodes: Node[], edges: Edge[], dropPos: { x: number; y: number }): Node | null {
  const H_TOLERANCE = 160 // px — drop doesn't need to be pixel-perfect
  const SLOT_TOLERANCE = 90 // px — how close the drop X must be to a slot's center

  const candidates = nodes.filter((n) => {
    const nh = nodeHeight(n.type)
    const w = nodeWidth(n.type, n.data)
    const centerX = n.position.x + w / 2
    return (
      dropPos.y > n.position.y + nh / 2 &&     // drop is below the node center
      Math.abs(dropPos.x - centerX) <= w / 2 + H_TOLERANCE
    )
  })

  // Multi-output preference: if the drop X aligns with an unfilled slot on
  // any candidate, that node wins regardless of stacking order. Lets the user
  // drop past an interposing node (e.g. a parallel_end sitting between the
  // parallel start and the drop point) and still attach to the slot.
  for (const candidate of candidates) {
    const handles = configuredHandleIds(candidate)
    if (!handles || handles.length === 0) continue
    const w = nodeWidth(candidate.type, candidate.data)
    for (let i = 0; i < handles.length; i++) {
      const handleX = candidate.position.x + (w * (i + 0.5)) / handles.length
      if (Math.abs(dropPos.x - handleX) > SLOT_TOLERANCE) continue
      const occupied = edges.some((e) => e.source === candidate.id && e.sourceHandle === handles[i])
      if (!occupied) return candidate
    }
  }

  // Drop terminal nodes (exit, response without continue_after_response, etc.)
  // before picking the deepest candidate — if we don't, a terminal sitting
  // below the user's intended source steals the auto-connect and the drop
  // lands free-floating.
  const connectable = candidates.filter((n) => chooseSourceHandle(n, dropPos.x) !== null)
  if (connectable.length === 0) return null

  // Pick the candidate with the deepest bottom edge above the drop. Break ties
  // (parallel chains end at the same y) by horizontal proximity to dropX so a
  // drop near one column doesn't get stolen by an adjacent column whose node
  // happens to come first in the nodes array.
  const best = connectable.reduce((best, n) => {
    const nBottom = n.position.y + nodeHeight(n.type)
    const bBottom = best.position.y + nodeHeight(best.type)
    if (nBottom !== bBottom) return nBottom > bBottom ? n : best
    const nDx = Math.abs(dropPos.x - (n.position.x + nodeWidth(n.type, n.data) / 2))
    const bDx = Math.abs(dropPos.x - (best.position.x + nodeWidth(best.type, best.data) / 2))
    return nDx < bDx ? n : best
  })

  // If the drop is more than one rank below the deepest candidate's bottom,
  // the user is dropping past the cluster — typically because they want a
  // free-floating placement (e.g. a manual convergence node below a branch's
  // grey region). Bail out so the drop lands free-floating rather than getting
  // soaked up into one of the branch chains.
  const FAR_DROP_GAP = nodeHeight(best.type) + 48 // ~ranksep + node height
  if (dropPos.y > best.position.y + nodeHeight(best.type) + FAR_DROP_GAP) {
    return null
  }
  return best
}

function findRunningNamespace(
  nodes: Node[],
  edges: Edge[],
  liveSteps: Record<string, ExecutionStep>
): string | null {
  // Walk the graph from the trigger's successor
  let currentId = edges.find((e) => e.source === 'trigger')?.target
  while (currentId) {
    const node = nodes.find((n) => n.id === currentId)
    if (!node) break
    const ns = (node.data as unknown as CanvasNodeData).namespace
    const step = liveSteps[ns]
    if (!step) return ns  // hasn't completed yet — probably running now
    if (step.status !== 'completed') return null  // terminal, stop here
    // Follow the edge the step took
    const outEdges = edges.filter((e) => e.source === currentId)
    const route = (step.output as Record<string, unknown> | null)?._route as string | undefined
    const nextEdge = (route ? outEdges.find((e) => e.sourceHandle === route) : null) ?? outEdges[0]
    currentId = nextEdge?.target
  }
  return null
}

// ── Inner canvas (needs ReactFlowProvider context) ───────────────────────────

function CanvasInner({ workflow, mode, onModeChange, executionId, executionSteps, executionPayload, executionSource, executionTraceId, executionStartedAt, executionParentId, executionChildren, onLoadStepDetail, onClearExecution, onSelectExecution, focusNodeId }: {
  workflow: Workflow
  mode: 'edit' | 'view'
  onModeChange?: (mode: 'edit' | 'view') => void
  executionId?: string
  executionSteps?: Record<string, ExecutionStep>
  executionPayload?: unknown
  executionSource?: string | null
  executionTraceId?: string | null
  executionStartedAt?: string | null
  executionParentId?: string | null
  executionChildren?: Array<{ id: string; started_at: string; status: string }>
  onLoadStepDetail?: (namespace: string) => void
  onClearExecution?: () => void
  onSelectExecution?: (execId: string) => void
  focusNodeId?: string
}) {
  const router = useRouter()
  const { screenToFlowPosition, fitView, getViewport, setViewport } = useReactFlow()

  // Switch view↔edit. Prefer the parent's local-state mode setter (instant —
  // avoids the App Router transition lag); fall back to a URL push if no
  // handler was passed.
  const switchMode = useCallback((next: 'edit' | 'view') => {
    if (onModeChange) onModeChange(next)
    else router.push(`/workflows/${workflow.id}?mode=${next}`)
  }, [onModeChange, router, workflow.id])

  // Selecting a new execution. Mirrors switchMode: prefer the parent's
  // optimistic local-state setter, fall back to router.push if not wired.
  const selectExecution = useCallback((execId: string) => {
    if (onSelectExecution) onSelectExecution(execId)
    else router.push(`/workflows/${workflow.id}?execution=${execId}`)
  }, [onSelectExecution, router, workflow.id])

  // After a layout pass that may have shifted existing nodes (e.g. dropping a
  // new node and re-running dagre), keep the user's view stable by translating
  // the viewport by the same delta the anchor node moved. Without this, adding
  // a node when zoomed-in makes the canvas appear to jump.
  const layoutPreservingViewport = useCallback(
    (anchorId: string, prevNodes: Node[], nextNodes: Node[]) => {
      const before = prevNodes.find((n) => n.id === anchorId)?.position
      const after = nextNodes.find((n) => n.id === anchorId)?.position
      if (!before || !after) return
      const dx = after.x - before.x
      const dy = after.y - before.y
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
      const vp = getViewport()
      setViewport({ x: vp.x - dx * vp.zoom, y: vp.y - dy * vp.zoom, zoom: vp.zoom })
    },
    [getViewport, setViewport]
  )
  const viewport = useViewport()
  const nodesInitialized = useNodesInitialized()
  const updateNodeInternals = useUpdateNodeInternals()
  const initialFitDoneRef = useRef(false)
  // Once React Flow has measured every node, re-run layoutWorkflow so dagre
  // can use real DOM heights instead of the per-type declared maxima. Until
  // that pass completes, the canvas is hidden behind a loader so the user
  // never sees the layout shift between declared-height and measured-height.
  const [layoutSettled, setLayoutSettled] = useState(false)
  const layoutSettleDoneRef = useRef(false)

  // Backfill any legacy branches with a paired branch_end + hidden backbone
  // BEFORE both nodes and edges are computed so the synthesized edges land
  // in the React Flow edge state, not just the node state.
  const backfilled = backfillBranchEnds(
    workflow.definition?.nodes ?? [],
    workflow.definition?.edges ?? []
  )
  const initEdges = defToEdges(migrateParallelEdges(backfilled.nodes, backfilled.edges))
  const [nodes, setNodes, onNodesChange] = useNodesState(
    defToNodes(backfilled.nodes, backfilled.edges, workflow.definition?.trigger)
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState(initEdges)
  const [name, setName] = useState(workflow.name)
  const [isDirty, setIsDirty] = useState(false)
  const [triggerVersion, setTriggerVersion] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedOk, setSavedOk] = useState(false)
  const [showCommitMenu, setShowCommitMenu] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [draftLoading, setDraftLoading] = useState(false)
  const aiDraftKeyRef = useRef<string | null>(null)
  const draftReqIdRef = useRef(0)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [slackChannel, setSlackChannel] = useState(workflow.slack_channel ?? '')
  const [envKeys, setEnvKeys] = useState<string[]>([])
  const [replaying, setReplaying] = useState(false)
  const [refreshSignal, setRefreshSignal] = useState(0)
  const [showTest, setShowTest] = useState(false)
  const [testInitialPayload, setTestInitialPayload] = useState<string | undefined>(undefined)
  const [savedPayloads, setSavedPayloads] = useState(workflow.test_payloads ?? [])
  const [showVersions, setShowVersions] = useState(false)
  const [liveSteps, setLiveSteps] = useState<Record<string, ExecutionStep>>({})
  const [testRunning, setTestRunning] = useState(false)
  const [lastTestExecId, setLastTestExecId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const [edgeContextMenu, setEdgeContextMenu] = useState<{ edgeId: string; x: number; y: number } | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)
  // Step ID rename — prompt state + queued partner-formula rewrites that get
  // applied to the DB after the next successful workflow save.
  const [renamePrompt, setRenamePrompt] = useState<{
    oldNs: string
    newNs: string
    canvasReferenceCount: number
    partnerFormulas: PartnerFormulaImpact[]
    resolve: (committed: boolean) => void
  } | null>(null)
  const pendingFormulaRenamesRef = useRef<Array<{ oldNs: string; newNs: string; partner_ids: string[] }>>([])
  // Grace period before hiding the edge X button — gives the cursor time to
  // bridge the gap between the thin wire hover region and the button itself.
  // Cleared whenever the user re-enters the wire or the button.
  const edgeHoverHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelEdgeHoverHide = useCallback(() => {
    if (edgeHoverHideTimerRef.current) {
      clearTimeout(edgeHoverHideTimerRef.current)
      edgeHoverHideTimerRef.current = null
    }
  }, [])
  const scheduleEdgeHoverHide = useCallback(() => {
    cancelEdgeHoverHide()
    edgeHoverHideTimerRef.current = setTimeout(() => {
      setHoveredEdgeId(null)
      edgeHoverHideTimerRef.current = null
    }, 150)
  }, [cancelEdgeHoverHide])
  const [sidePanelWidth, setSidePanelWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 320
    const saved = Number.parseInt(window.localStorage.getItem('bidspoke.sidePanelWidth') ?? '', 10)
    if (Number.isFinite(saved) && saved >= 280 && saved <= 800) return saved
    return 320
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('bidspoke.sidePanelWidth', String(sidePanelWidth))
  }, [sidePanelWidth])
  const sidePanelRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  // Undo/redo
  const [history, setHistory] = useState<{ nodes: Node[]; edges: Edge[] }[]>([])
  const [future, setFuture] = useState<{ nodes: Node[]; edges: Edge[] }[]>([])
  // Copy/paste clipboard — persisted to localStorage so it works across workflows
  function copyNode(node: Node) {
    const d = node.data as unknown as CanvasNodeData
    writeClipboard({ type: node.type as NodeType, config: d.config ?? {}, variables: d.variables ?? {}, position: node.position })
  }

  const triggerRef = useRef<WorkflowDef['trigger']>(
    workflow.definition?.trigger ?? DEFAULT_TRIGGER
  )
  const prevErrorIdsRef = useRef<string>('')

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null

  // Whether the selected node's namespace is referenced by any OTHER node's
  // config / variables / fallback. Drives ConfigPanel's auto-derive guard so
  // label edits stop touching the Step ID once it's actually referenced.
  const selectedNamespaceReferenced = useMemo(() => {
    if (!selectedNode) return false
    const ns = (selectedNode.data as unknown as CanvasNodeData).namespace
    if (!ns) return false
    if ((triggerRef.current.config.success_node_namespaces ?? []).includes(ns)) return true
    return nodes.some((n) => {
      if (n.id === selectedNode.id) return false
      const data = n.data as unknown as CanvasNodeData
      if (countBareNamespaceRefs(data?.config, ns) > 0) return true
      return countStepReferences(data?.config, ns) > 0 || countStepReferences(data?.variables, ns) > 0
    })
  }, [selectedNode, nodes])

  // Lazy-load step detail (input/output/logs) for the selected node in view
  // mode. The summary fetch in the parent page only ships status/duration, so
  // we pull the heavy payload here on demand.
  useEffect(() => {
    if (mode !== 'view' || !executionId || !selectedNode || selectedNode.id === 'trigger') return
    const namespace = (selectedNode.data as unknown as CanvasNodeData).namespace
    const step = executionSteps?.[namespace]
    if (!step || step.detail_loaded || !step.step_id) return
    onLoadStepDetail?.(namespace)
  }, [mode, executionId, selectedNode, executionSteps, onLoadStepDetail])
  const nodeNamespaces = nodes.map((n) => (n.data as unknown as CanvasNodeData).namespace)
  // Namespaces in graph order — BFS from trigger following edges in their
  // current array order. Disconnected nodes are appended at the end so they
  // remain selectable. Used by the trigger config's success-node picker so
  // the list mirrors the visual flow instead of node-creation order.
  const orderedNamespaces = (() => {
    const result: string[] = []
    const seen = new Set<string>()
    const adj = new Map<string, string[]>()
    for (const e of edges) {
      const list = adj.get(e.source) ?? []
      list.push(e.target)
      adj.set(e.source, list)
    }
    const queue = ['trigger']
    while (queue.length > 0) {
      const id = queue.shift() as string
      if (seen.has(id)) continue
      seen.add(id)
      const node = nodes.find((n) => n.id === id)
      if (node) {
        const ns = (node.data as unknown as CanvasNodeData).namespace
        if (typeof ns === 'string' && ns.length > 0 && ns !== 'trigger') result.push(ns)
      }
      for (const next of adj.get(id) ?? []) queue.push(next)
    }
    for (const n of nodes) {
      if (seen.has(n.id)) continue
      const ns = (n.data as unknown as CanvasNodeData).namespace
      if (typeof ns === 'string' && ns.length > 0 && ns !== 'trigger') result.push(ns)
    }
    return result
  })()
  const nodeOptions = nodes
    .filter((n) => n.id !== 'trigger' && n.type !== 'parallel_end')
    .map((n) => {
      const d = n.data as unknown as CanvasNodeData
      return { id: n.id, namespace: d.namespace, label: d.label }
    })

  // Compute validation errors for all attached, unconfigured nodes (edit mode only)
  const validationErrors: Map<string, ValidationError> = useMemo(
    () => (mode === 'edit' ? validateWorkflow(nodes, edges) : new Map()),
    [mode, nodes, edges]
  )

  // Translucent backdrops behind each branch / parallel cluster. Recomputed
  // whenever nodes or edges change so they track positions / membership in
  // real time. Merged into the rendered list ahead of real nodes; their
  // negative zIndex pushes them to the back.
  const renderedNodes = useMemo(
    () => [...computeRegionNodes(nodes, edges), ...nodes],
    [nodes, edges]
  )

  // Convergence edges from each parallel slot's chain leaf to parallel_end.
  // Render-only (not in state, not saved, not seen by the engine). Smoothstep
  // routing + a light dashed stroke makes them read as "implicit" — they
  // aren't always perfectly clean when chains have unequal depth, but having
  // *no* edge is worse than slightly imperfect routing.
  const renderedEdges = useMemo(
    () => {
      // Drop edges that point at a sourceHandle the source node no longer has.
      // These can survive in the definition when a node's type changes (e.g.,
      // a single-output node turned into a branch) and React Flow logs a
      // "Couldn't create edge" warning on every render — which on Main Flow
      // produced thousands of console writes per load and visibly froze the
      // canvas. Drop them silently here; the underlying data isn't touched.
      const nodeMap = new Map(nodes.map((n) => [n.id, n]))
      const validEdges = edges.filter((e) => {
        if (!e.sourceHandle) return true
        const src = nodeMap.get(e.source)
        if (!src) return true
        const handles = configuredHandleIds(src)
        if (!handles) return e.sourceHandle === null || e.sourceHandle === 'output'
        return handles.includes(e.sourceHandle)
      })
      return [...validEdges, ...computeConvergenceEdges(nodes, validEdges)]
    },
    [nodes, edges]
  )

  // Inject hasError into node data so nodes can show the amber ring.
  // Auto-focus + select the name input for brand-new workflows so the first action is naming it
  useEffect(() => {
    if (mode === 'edit' && workflow.name === 'Untitled Workflow') {
      requestAnimationFrame(() => {
        nameRef.current?.focus()
        nameRef.current?.select()
      })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Guard with a ref so setNodes is only called when the error set actually changes —
  // otherwise the useMemo above creates a new Map reference on every render, causing
  // setNodes → new nodes → new Map → setNodes → infinite loop.
  useEffect(() => {
    const errorIds = [...validationErrors.keys()].sort().join(',')
    if (errorIds === prevErrorIdsRef.current) return
    prevErrorIdsRef.current = errorIds
    setNodes((ns) =>
      ns.map((n) => {
        const hasError = validationErrors.has(n.id)
        const current = (n.data as unknown as CanvasNodeData).hasError
        if (current === hasError) return n
        return { ...n, data: { ...(n.data as object), hasError } }
      })
    )
  }, [validationErrors, setNodes])

  useEffect(() => {
    api.env.list().then((vars) => setEnvKeys(vars.map((v) => v.key))).catch(() => {})
  }, [])

  // Warn on browser close / refresh when there are unsaved changes
  useEffect(() => {
    if (!isDirty) return
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isDirty])

  // Sync node.data.executionStep with the current execution. When executionSteps
  // is cleared (e.g. user clicked Clear), this also strips executionStep from
  // every node so colors revert to default.
  //
  // Reference-equality skip: only touch nodes whose ExecutionStep reference
  // actually changed. The page builds a fresh object per namespace on summary
  // load (= all nodes update once, expected), then on lazy step-detail load
  // only the one updated namespace gets a new reference. Without this skip,
  // a single step click would re-render all 15-20 nodes and call
  // updateNodeInternals on every one — visibly slow on engine bidding.
  const hadExecutionRef = useRef(false)
  useEffect(() => {
    const touchedIds: string[] = []
    setNodes((ns) => {
      let changed = false
      const next = ns.map((n) => {
        if (n.id === 'trigger') return n
        const data = n.data as unknown as CanvasNodeData & { executionStep?: ExecutionStep | null }
        const namespace = data.namespace
        const step = executionSteps ? (executionSteps[namespace] ?? null) : undefined
        if (data.executionStep === step) return n
        changed = true
        touchedIds.push(n.id)
        return { ...n, data: { ...(n.data as object), executionStep: step } }
      })
      return changed ? next : ns
    })
    const hasExecution = !!executionSteps
    const wasFirstSelection = !hadExecutionRef.current && hasExecution
    hadExecutionRef.current = hasExecution
    if (touchedIds.length === 0) return
    // When clearing the execution view (executionSteps undefined), nodes only
    // shrink (pill disappears) or lose opacity. React Flow's ResizeObserver
    // catches shrink-only changes without an explicit re-measure, and skipping
    // updateNodeInternals on every node here is the difference between
    // Clear-feels-instant and Clear-takes-a-second on 15-20 node workflows.
    if (!executionSteps) return
    // Several node types (Branch, Filter, Code, etc.) render an output-preview
    // pill when executionStep is set, which grows the node's height. React
    // Flow caches handle positions on initial mount, so without a re-measure
    // wires anchor to the old (smaller) bbox.
    //
    // Two cases need the explicit re-measure:
    //   1) First selection (no exec → exec): nodes grow from default to with-pill.
    //   2) Lazy step-detail load (≤ a few touched ids): one node's pill content
    //      arrived, may have changed width; cheap to re-measure a couple.
    // Skip on exec → exec swaps (many touched ids, pill already present):
    // ResizeObserver catches any width delta from changed output text, and
    // touching all N nodes was the multi-second freeze users reported.
    const isExecSwap = !wasFirstSelection && touchedIds.length > 3
    if (isExecSwap) return
    // Defer to next frame so the new DOM has rendered before measuring.
    const raf = requestAnimationFrame(() => {
      // Pass the whole array in one call — useUpdateNodeInternals accepts
      // string | string[] and batches internally.
      updateNodeInternals(touchedIds)
    })
    return () => cancelAnimationFrame(raf)
  }, [executionSteps, setNodes, updateNodeInternals])

  // Sync data.isSuccessNode based on the trigger's success_node_namespaces so
  // the node renderers can draw a badge. Runs whenever the trigger config
  // changes or the node set changes.
  useEffect(() => {
    const successSet = new Set(triggerRef.current.config.success_node_namespaces ?? [])
    setNodes((ns) => {
      let changed = false
      const next = ns.map((n) => {
        if (n.id === 'trigger') return n
        const d = n.data as unknown as CanvasNodeData
        const isSuccessNode = successSet.has(d.namespace)
        if (d.isSuccessNode === isSuccessNode) return n
        changed = true
        return { ...n, data: { ...(n.data as object), isSuccessNode } }
      })
      return changed ? next : ns
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerVersion, nodes.length])

  // Mark nodes that aren't reachable from the trigger so the renderers + minimap
  // can dim them. Also clears manualPosition once a node becomes reachable
  // again and re-runs layoutWorkflow so wires line up cleanly — auto-layout
  // takes back over. Runs whenever the edge graph changes.
  useEffect(() => {
    const reachable = reachableFromTrigger(nodes, edges)
    const clearManualIds = new Set<string>()
    let dataNeedsUpdate = false
    for (const n of nodes) {
      const d = n.data as unknown as CanvasNodeData
      const isReachable = reachable.has(n.id)
      if (d.isReachable !== isReachable) dataNeedsUpdate = true
      if (isReachable && d.manualPosition === true) {
        clearManualIds.add(n.id)
        dataNeedsUpdate = true
      }
    }
    if (!dataNeedsUpdate) return
    setNodes((ns) => {
      const updated = ns.map((n) => {
        const d = n.data as unknown as CanvasNodeData
        const isReachable = reachable.has(n.id)
        const shouldClear = clearManualIds.has(n.id)
        if (d.isReachable === isReachable && !shouldClear) return n
        const nextData = { ...(n.data as object), isReachable } as Record<string, unknown>
        if (shouldClear) nextData.manualPosition = undefined
        return { ...n, data: nextData }
      })
      return clearManualIds.size > 0 ? layoutWorkflow(updated, edges) : updated
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edges, nodes.length])

  // First measurement pass: re-run layoutWorkflow with real DOM heights so the
  // gap between adjacent ranks is uniform regardless of how tall a given node
  // ended up. Runs once when `useNodesInitialized` first flips true.
  useEffect(() => {
    if (!nodesInitialized) return
    if (layoutSettleDoneRef.current) return
    layoutSettleDoneRef.current = true
    setNodes((prev) => layoutWorkflow(prev, edges))
    requestAnimationFrame(() => setLayoutSettled(true))
  }, [nodesInitialized, edges, setNodes])

  // Safety net: if `useNodesInitialized` never flips (e.g. ResizeObserver
  // stuck on a node off-screen), reveal the canvas anyway after 2s so the
  // user isn't permanently stuck staring at the loader.
  useEffect(() => {
    if (layoutSettled) return
    const t = setTimeout(() => {
      if (!layoutSettleDoneRef.current) {
        layoutSettleDoneRef.current = true
        setNodes((prev) => layoutWorkflow(prev, edges))
      }
      setLayoutSettled(true)
    }, 2000)
    return () => clearTimeout(t)
  }, [layoutSettled, edges, setNodes])

  // Re-fit the viewport once layout has settled with measured heights. The
  // default `fitView` prop fires on first render, before React Flow has
  // measured node dimensions, so the bounding box is computed from positions
  // only and the bottom of the workflow can fall outside the viewport. Refit
  // after measurement so the entire graph is framed. Only includes nodes
  // reachable from the trigger so far-flung orphans don't pull the bbox wide
  // and leave dead space on one side.
  useEffect(() => {
    if (!layoutSettled) return
    if (initialFitDoneRef.current) return
    initialFitDoneRef.current = true
    const reachable = reachableFromTrigger(nodes, edges)
    const fitNodes = nodes
      .filter((n) => reachable.has(n.id))
      .map((n) => ({ id: n.id }))
    fitView({ padding: 0.4, maxZoom: 0.5, nodes: fitNodes.length > 0 ? fitNodes : undefined })
  }, [layoutSettled, fitView, nodes, edges])

  // Deep link: ?node=<id> (e.g. from a config-warning) selects the node and
  // frames it. Runs after the broad fit above so it wins the viewport. Guarded
  // so it only fires once per mount.
  const focusDoneRef = useRef(false)
  useEffect(() => {
    if (!layoutSettled || !focusNodeId || focusDoneRef.current) return
    if (!nodes.some((n) => n.id === focusNodeId)) return
    focusDoneRef.current = true
    setSelectedNodeId(focusNodeId)
    fitView({ padding: 0.6, maxZoom: 1.2, duration: 600, nodes: [{ id: focusNodeId }] })
  }, [layoutSettled, focusNodeId, nodes, fitView])

  // Compensate the viewport for the left-sidebar width delta when toggling
  // edit ↔ view. NodePalette is w-48 (192px), ExecutionListPanel is w-72
  // (288px) — a 96px difference. Without this, saving (which flips to view
  // mode) widens the left rail and visually shoves every node 96px to the
  // right relative to the screen.
  const prevModeRef = useRef(mode)
  useEffect(() => {
    if (prevModeRef.current === mode) return
    const NODE_PALETTE_W = 192
    const EXEC_LIST_W = 288
    const delta = (mode === 'view' ? EXEC_LIST_W : NODE_PALETTE_W)
      - (prevModeRef.current === 'view' ? EXEC_LIST_W : NODE_PALETTE_W)
    prevModeRef.current = mode
    if (delta === 0) return
    const vp = getViewport()
    setViewport({ x: vp.x - delta, y: vp.y, zoom: vp.zoom })
  }, [mode, getViewport, setViewport])

  const handleTestStart = useCallback((_execId: string) => {
    setLiveSteps({})
    setTestRunning(true)
  }, [])

  const handleLiveStep = useCallback((namespace: string, step: ExecutionStep) => {
    setLiveSteps((prev) => ({ ...prev, [namespace]: step }))
  }, [])

  const handleTestEnd = useCallback(() => {
    setTestRunning(false)
  }, [])

  const handleTestStepsLoaded = useCallback((steps: Record<string, ExecutionStep>, execId: string) => {
    setLiveSteps(steps)
    setLastTestExecId(execId)
  }, [])

  const handleNodeRerun = useCallback(async (namespace: string) => {
    if (!lastTestExecId) return
    const definition = flowToDef(nodes, edges, triggerRef.current)
    try {
      const result = await api.workflows.testNode(workflow.id, { namespace, execution_id: lastTestExecId, definition })
      setLiveSteps((prev) => ({
        ...prev,
        [namespace]: {
          status: result.status as ExecutionStep['status'],
          output: result.output,
          input: null,
          error_message: result.error_message,
          error_type: null,
          duration_ms: result.duration_ms,
          retries_used: 0,
        },
      }))
    } catch (e) {
      // Surface the failure in the step display instead of silently console-logging.
      // Common cause: the code-node deploy failed (CF upload error) — without this,
      // the user clicks Re-run, sees nothing happen, and has no clue the upload
      // never landed.
      const msg = e instanceof Error ? e.message : String(e)
      console.error('Re-run failed:', e)
      setLiveSteps((prev) => ({
        ...prev,
        [namespace]: {
          status: 'failed' as ExecutionStep['status'],
          output: null,
          input: null,
          error_message: `Re-run failed: ${msg}`,
          error_type: null,
          duration_ms: 0,
          retries_used: 0,
        },
      }))
    }
  }, [lastTestExecId, nodes, edges, workflow.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Test a single node. "Build from run" passes a prior execution so upstream
  // step outputs + that run's trigger payload seed the context; "cold start"
  // omits it and runs with just the supplied trigger payload (works for nodes
  // that don't read steps.*). Result is written to liveSteps so the node's
  // StepResults panel renders it, same as a full test run.
  const handleNodeTest = useCallback(async (namespace: string, opts: { triggerPayload: unknown; useLastRun: boolean }) => {
    const definition = flowToDef(nodes, edges, triggerRef.current)
    const buildFromExecId = opts.useLastRun ? (lastTestExecId ?? executionId ?? undefined) : undefined
    try {
      const result = await api.workflows.testNode(workflow.id, {
        namespace,
        definition,
        execution_id: buildFromExecId,
        trigger_payload: opts.triggerPayload,
      })
      setLiveSteps((prev) => ({
        ...prev,
        [namespace]: {
          status: result.status as ExecutionStep['status'],
          output: result.output,
          input: null,
          error_message: result.error_message,
          error_type: null,
          duration_ms: result.duration_ms,
          retries_used: 0,
        },
      }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('Node test failed:', e)
      setLiveSteps((prev) => ({
        ...prev,
        [namespace]: {
          status: 'failed' as ExecutionStep['status'],
          output: null,
          input: null,
          error_message: `Test failed: ${msg}`,
          error_type: null,
          duration_ms: 0,
          retries_used: 0,
        },
      }))
    }
  }, [lastTestExecId, executionId, nodes, edges, workflow.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Apply live step data to nodes during a test run
  useEffect(() => {
    const hasLive = Object.keys(liveSteps).length > 0 || testRunning
    if (!hasLive) return

    // Infer which node is currently running by walking the graph
    const runningNs = testRunning ? findRunningNamespace(nodes, edges, liveSteps) : null

    setNodes((ns) =>
      ns.map((n) => {
        if (n.id === 'trigger') return n
        const namespace = (n.data as unknown as CanvasNodeData).namespace
        const step = liveSteps[namespace]

        if (step) {
          return { ...n, data: { ...(n.data as object), executionStep: step } }
        }
        if (namespace === runningNs) {
          // Show as currently running
          return { ...n, data: { ...(n.data as object), executionStep: { status: 'running' as const, input: null, output: null, error_message: null, error_type: null, duration_ms: 0, retries_used: 0 } } }
        }
        // Clear any previous execution step
        return { ...n, data: { ...(n.data as object), executionStep: undefined } }
      })
    )
  }, [liveSteps, testRunning]) // eslint-disable-line react-hooks/exhaustive-deps

  // Color edges based on which nodes ran (view mode uses executionSteps; test mode uses liveSteps)
  useEffect(() => {
    const stepsToUse = executionSteps ?? (Object.keys(liveSteps).length > 0 ? liveSteps : undefined)
    if (!stepsToUse) {
      setEdges((es) => es.map((e) => ({ ...e, animated: false, style: undefined })))
      return
    }
    // Build nodeId → namespace map
    const idToNs = new Map<string, string>()
    for (const n of nodes) {
      if (n.id !== 'trigger') {
        idToNs.set(n.id, (n.data as unknown as CanvasNodeData).namespace)
      }
    }
    setEdges((es) =>
      es.map((edge) => {
        const sourceNs = idToNs.get(edge.source)
        const targetNs = idToNs.get(edge.target)
        const sourceStep = sourceNs !== undefined ? stepsToUse[sourceNs] : undefined
        const targetStep = targetNs !== undefined ? stepsToUse[targetNs] : undefined
        const sourceRan = edge.source === 'trigger' || sourceStep != null
        const targetRan = targetStep != null
        const sourceFailed = sourceStep?.status === 'failed' || sourceStep?.status === 'failed_with_fallback'
        const targetFailed = targetStep?.status === 'failed' || targetStep?.status === 'failed_with_fallback'

        if (sourceRan && targetRan) {
          // Path was taken — red if either endpoint failed, green otherwise
          if (sourceFailed || targetFailed) {
            return { ...edge, animated: true, style: { stroke: '#ef4444', strokeWidth: 2 } }
          }
          return { ...edge, animated: true, style: { stroke: '#22c55e', strokeWidth: 2 } }
        } else if (sourceRan) {
          // Source ran but this branch wasn't taken (e.g. filter pass when exit fired)
          return { ...edge, animated: false, style: { stroke: '#d1d5db', strokeWidth: 1.5 } }
        } else {
          // Not yet reached — show as default gray so edges stay visible
          return { ...edge, animated: false, style: undefined }
        }
      })
    )
  }, [executionSteps, liveSteps]) // eslint-disable-line react-hooks/exhaustive-deps

  // Walk a plain-object/array value to produce dotted suggestion paths up to
  // a bounded depth. Used to enumerate nested fields on step outputs / the
  // trigger payload so autocomplete offers paths like
  // steps.foo.output.body.lead_id, not just steps.foo.
  const walkPaths = useCallback((value: unknown, prefix: string, sink: string[], depth: number) => {
    if (depth <= 0 || value === null || value === undefined) return
    if (typeof value !== 'object') return
    if (Array.isArray(value)) return // don't enumerate array indices — noisy
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = `${prefix}.${key}`
      sink.push(next)
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        walkPaths(child, next, sink, depth - 1)
      }
    }
  }, [])

  const nestedRefs = useMemo(() => {
    const out: string[] = []
    // Trigger payload fields from the current/most-recent execution payload.
    if (executionPayload && typeof executionPayload === 'object') {
      walkPaths(executionPayload, 'trigger.payload', out, 5)
    }
    // Step outputs — prefer live test-run steps, fall back to the viewed execution.
    const source = Object.keys(liveSteps).length > 0
      ? liveSteps
      : (executionSteps ?? {})
    for (const [ns, step] of Object.entries(source)) {
      const output = (step as { output?: unknown }).output
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        walkPaths(output, `steps.${ns}.output`, out, 5)
      }
    }
    return out
  }, [executionPayload, liveSteps, executionSteps, walkPaths])

  const refs = [
    'trigger.payload',
    'trigger.source',
    'execution.bidspoke_link',
    'execution.workflow_id',
    'execution.execution_id',
    'execution.trace_id',
    ...nodeNamespaces.map((ns) => `steps.${ns}`),
    ...nestedRefs,
    ...envKeys.map((k) => `env.${k}`),
  ]

  // ── History helpers ─────────────────────────────────────────────────────────

  const snapshot = useCallback(() => {
    setHistory((h) => [...h.slice(-30), { nodes, edges }])
    setFuture([])
  }, [nodes, edges])

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h
      const prev = h[h.length - 1]
      setFuture((f) => [{ nodes, edges }, ...f])
      setNodes(prev.nodes)
      setEdges(prev.edges)
      return h.slice(0, -1)
    })
  }, [nodes, edges, setNodes, setEdges])

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f
      const next = f[0]
      setHistory((h) => [...h, { nodes, edges }])
      setNodes(next.nodes)
      setEdges(next.edges)
      return f.slice(1)
    })
  }, [nodes, edges, setNodes, setEdges])

  // Given an edge set that leaves some nodes orphaned, BFS from any node that
  // lost all incoming edges and shift the resulting subgraph right of the
  // main flow. Marks each shifted node manualPosition so layout keeps them
  // in place (no auto-re-alignment to the trigger row).
  const shiftDisconnectedRight = useCallback((newEdges: Edge[]): Node[] => shiftOrphansRight(nodes, newEdges), [nodes])

  const removeFromChain = useCallback((nodeId: string) => {
    snapshot()
    const inEdges = edges.filter((e) => e.target === nodeId)
    const outEdges = edges.filter((e) => e.source === nodeId && e.sourceHandle === 'output')
    const connectedIds = new Set([...inEdges.map((e) => e.id), ...outEdges.map((e) => e.id)])
    const remaining = edges.filter((e) => !connectedIds.has(e.id))
    const bridgeEdges: Edge[] = []
    if (inEdges.length === 1 && outEdges.length === 1) {
      bridgeEdges.push({
        id: uid(),
        source: inEdges[0].source,
        target: outEdges[0].target,
        sourceHandle: inEdges[0].sourceHandle ?? 'output',
      })
    }
    const newEdges = [...remaining, ...bridgeEdges]
    const shifted = shiftDisconnectedRight(newEdges)
    const next = layoutWorkflow(shifted, newEdges)
    // Keep the user's spot: anchor the viewport to the upstream node that
    // survives the operation (near where they clicked), so the canvas doesn't
    // jump when layout reflows.
    layoutPreservingViewport(inEdges[0]?.source ?? outEdges[0]?.target ?? 'trigger', nodes, next)
    setEdges(newEdges)
    setNodes(next)
    setIsDirty(true)
    setContextMenu(null)
  }, [snapshot, edges, nodes, shiftDisconnectedRight, setEdges, setNodes, layoutPreservingViewport])

  // Disconnect: cut only the node's incoming edges. The node and its entire
  // downstream subgraph float away as a disconnected cluster (still internally
  // connected), dimmed by the reachability effect and shifted right of the
  // main flow while keeping its current Y.
  const disconnectNode = useCallback((nodeId: string) => {
    snapshot()
    const cutEdges = edges.filter((e) => e.target === nodeId)
    const newEdges = edges.filter((e) => e.target !== nodeId)
    const shifted = shiftDisconnectedRight(newEdges)
    const next = layoutWorkflow(shifted, newEdges)
    // Anchor to the upstream node the edge was cut from — it stays in the main
    // flow, so the viewport holds steady instead of jumping.
    layoutPreservingViewport(cutEdges[0]?.source ?? 'trigger', nodes, next)
    setEdges(newEdges)
    setNodes(next)
    setIsDirty(true)
    setContextMenu(null)
  }, [snapshot, edges, nodes, shiftDisconnectedRight, setEdges, setNodes, layoutPreservingViewport])

  // Disconnect a single edge — used by the right-click menu on edges.
  const deleteEdge = useCallback((edgeId: string) => {
    snapshot()
    const edge = edges.find((e) => e.id === edgeId)
    const newEdges = edges.filter((e) => e.id !== edgeId)
    const shifted = shiftDisconnectedRight(newEdges)
    const next = layoutWorkflow(shifted, newEdges)
    // Anchor to the edge's source — it stays put, so the canvas holds steady.
    layoutPreservingViewport(edge?.source ?? 'trigger', nodes, next)
    setEdges(newEdges)
    setNodes(next)
    setIsDirty(true)
    setEdgeContextMenu(null)
  }, [snapshot, edges, nodes, shiftDisconnectedRight, setEdges, setNodes, layoutPreservingViewport])


  // ── Keyboard shortcuts ──────────────────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey
      // Save and Escape stay active everywhere, including inside text fields —
      // Cmd+S has no useful native behavior here and Escape only closes menus.
      if (meta && e.key === 's') { e.preventDefault(); openSaveMenu() }
      if (e.key === 'Escape') { setContextMenu(null); setEdgeContextMenu(null) }

      // Focus guard: when the user is editing text — any input/textarea/
      // contenteditable, or anywhere inside a side panel (config/test/trigger,
      // incl. Monaco) — let the BROWSER own the keyboard. Otherwise the
      // canvas-level Cmd+Z would undo the last node-add instead of the text the
      // user just typed. This guards undo/redo and copy/paste/duplicate alike.
      const target = e.target instanceof Node ? e.target : null
      if (target && sidePanelRef.current?.contains(target)) return
      const inInput = e.composedPath().some(
        (el) => el instanceof HTMLInputElement
          || el instanceof HTMLTextAreaElement
          || (el instanceof HTMLElement && el.isContentEditable)
      )
      if (inInput) return

      // Canvas-level undo/redo — only reached when NOT editing text.
      if (meta && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      if (meta && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo() }

      // Cmd+C — copy selected node (not the trigger) to localStorage
      if (meta && e.key === 'c' && selectedNodeId && selectedNodeId !== 'trigger') {
        const node = nodes.find((n) => n.id === selectedNodeId)
        if (node) copyNode(node)
      }

      // Cmd+V — paste from localStorage clipboard
      if (meta && e.key === 'v') {
        const cb = readClipboard()
        if (cb) {
          e.preventDefault()
          pasteNode(cb)
        }
      }

      // Cmd+D — duplicate selected node in place
      if (meta && e.key === 'd' && selectedNodeId && selectedNodeId !== 'trigger') {
        e.preventDefault()
        const node = nodes.find((n) => n.id === selectedNodeId)
        if (node) duplicateNode(node)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // ── Connection validation ────────────────────────────────────────────────────

  // The trigger node has a single output — it can only connect to one downstream node.
  // All other nodes are unrestricted (filter/branch already split via separate handles).
  // Tracks the edge id currently being reconnected so isValidConnection can
  // ignore it (otherwise it sees the still-attached original edge and rejects
  // the reconnect as a "source handle already in use" conflict). Set by
  // React Flow's onReconnectStart when the user grabs an edge endpoint, and
  // by our onConnectStart shim when the user starts a drag from a source
  // handle that already has a wire (intuitive "grab where the wire comes
  // out" gesture — we promote that to a reconnect).
  const reconnectingEdgeIdRef = useRef<string | null>(null)
  // When a drag starts from an already-wired source handle, this holds the
  // edge being implicitly reconnected. onConnect drops it and adds the new
  // edge in its place; onConnectEnd clears it if the drop failed.
  const implicitReconnectEdgeRef = useRef<Edge | null>(null)

  const isValidConnection = useCallback(
    (connection: { source: string | null; sourceHandle?: string | null; target?: string | null }) => {
      const reconnectingId = reconnectingEdgeIdRef.current
      const relevantEdges = reconnectingId ? edges.filter((e) => e.id !== reconnectingId) : edges
      let result: boolean
      if (connection.source === 'trigger') {
        result = !relevantEdges.some((e) => e.source === 'trigger')
      } else if (connection.source && connection.sourceHandle) {
        result = !relevantEdges.some(
          (e) => e.source === connection.source && e.sourceHandle === connection.sourceHandle
        )
      } else {
        result = true
      }
      console.log('[canvas] isValidConnection', { connection, reconnectingId, result })
      return result
    },
    [edges]
  )

  // ── Connect ─────────────────────────────────────────────────────────────────

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      snapshot()
      let next = edges
      const implicit = implicitReconnectEdgeRef.current
      const oldTarget = implicit?.target ?? null

      if (implicit) {
        console.log('[canvas] implicit reconnect: dropping old edge', implicit.id)
        next = next.filter((e) => e.id !== implicit.id)
        implicitReconnectEdgeRef.current = null
        reconnectingEdgeIdRef.current = null
      }

      // Reject a connection that duplicates an existing source→target pair —
      // even if the sourceHandle differs (e.g. a legacy null-handle edge from
      // an unstyled node + a new properly-handled edge after the renderer was
      // added). The duplicate breaks applyLinearChain alignment and offers no
      // engine value (the second edge fires the same downstream).
      const isDuplicate = next.some(
        (e) => e.source === connection.source && e.target === connection.target,
      )
      if (isDuplicate) {
        console.log('[canvas] onConnect: dropping duplicate edge', connection.source, '->', connection.target)
        return
      }
      next = addEdge({ ...connection, id: uid() }, next)

      // Heuristics on top of the replace-edge default:
      //
      // Splice-IN: drop onto a disconnected leaf (no outgoing edges) →
      //   also bridge that node to the old target so the chain stays wired.
      //   (Drop Return Response onto Prospect Trades → Patch Prospect Body.)
      //
      // Splice-OUT: the old target is now orphaned AND had an outgoing edge
      //   to the new target → remove it. Matches "drag the wire past a
      //   currently-connected node to bypass it." Without this, the bypassed
      //   node's leftover edge creates a diamond (two parents pointing to
      //   the new target) and dagre fans the layout into two columns.
      if (implicit && oldTarget && connection.target && connection.target !== oldTarget) {
        const reachableBefore = reachableFromTrigger(nodes, edges)
        const dropTargetWasDisconnected = !reachableBefore.has(connection.target)
        const dropTargetHasOutgoing = next.some((e) => e.source === connection.target)
        if (dropTargetWasDisconnected && !dropTargetHasOutgoing) {
          console.log('[canvas] splice-in: bridging', connection.target, '->', oldTarget)
          next = [
            ...next,
            { id: uid(), source: connection.target, target: oldTarget, sourceHandle: 'output' } as Edge,
          ]
        } else {
          const oldTargetHasIncoming = next.some((e) => e.target === oldTarget)
          const bypassEdge = next.find((e) => e.source === oldTarget && e.target === connection.target)
          if (!oldTargetHasIncoming && bypassEdge) {
            console.log('[canvas] splice-out: removing bypass edge', bypassEdge.id)
            next = next.filter((e) => e.id !== bypassEdge.id)
          }
        }
      }

      const shifted = shiftDisconnectedRight(next)
      const nextNodes = layoutWorkflow(shifted, next)
      // Anchor the viewport to the connection's source so that bringing a
      // disconnected node into the main flow doesn't shift the user's focus —
      // the connection's source is what Dan was looking at when dragging the
      // wire. Without this, layoutWorkflow recomputing every node's position
      // can yank the whole graph left or right on screen.
      if (connection.source) layoutPreservingViewport(connection.source, nodes, nextNodes)
      setEdges(next)
      setNodes(nextNodes)
      setIsDirty(true)
    },
    [snapshot, edges, nodes, shiftDisconnectedRight, setEdges, setNodes, layoutPreservingViewport]
  )

  // Start a drag from a source handle that already has a wire → treat as
  // reconnect of that wire. Clears the implicit-reconnect ref if the drop
  // misses everything, so the original wire stays put.
  const onConnectStart = useCallback(
    (_: unknown, params: { nodeId: string | null; handleId: string | null; handleType: 'source' | 'target' | null }) => {
      if (params.handleType !== 'source' || !params.nodeId) {
        implicitReconnectEdgeRef.current = null
        return
      }
      const existing = edges.find(
        (e) => e.source === params.nodeId && (e.sourceHandle ?? null) === (params.handleId ?? null)
      )
      if (existing) {
        console.log('[canvas] implicit reconnect start', existing.id)
        implicitReconnectEdgeRef.current = existing
        reconnectingEdgeIdRef.current = existing.id
      } else {
        implicitReconnectEdgeRef.current = null
      }
    },
    [edges]
  )

  const onConnectEnd = useCallback(() => {
    // Drag ended. If onConnect fired, the refs were already cleared. If the
    // user dropped on empty space, clear them here so the original wire stays.
    implicitReconnectEdgeRef.current = null
    reconnectingEdgeIdRef.current = null
  }, [])

  // Edge reconnect: drag an existing edge's endpoint to a different handle.
  // Typical use: drop the target end onto a disconnected node to slot it in.
  // If the reconnect orphans a node (its old target loses all incoming), the
  // shiftDisconnectedRight helper pushes the orphan to a free column so the
  // Y of each remaining chain is preserved.
  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      console.log('[canvas] onReconnect fired', { oldEdge: oldEdge.id, from: `${oldEdge.source}->${oldEdge.target}`, newConnection })
      snapshot()
      let next = edges.filter((e) => e.id !== oldEdge.id)
      next = addEdge({ ...newConnection, id: uid() }, next)
      const shifted = shiftDisconnectedRight(next)
      const nextNodes = layoutWorkflow(shifted, next)
      layoutPreservingViewport(newConnection.source ?? oldEdge.source ?? 'trigger', nodes, nextNodes)
      setEdges(next)
      setNodes(nextNodes)
      setIsDirty(true)
    },
    [snapshot, edges, nodes, shiftDisconnectedRight, setEdges, setNodes, layoutPreservingViewport]
  )


  // ── Drag-drop from palette ──────────────────────────────────────────────────

  const onDragStart = useCallback((e: React.DragEvent, type: NodeType) => {
    e.dataTransfer.setData('nodeType', type)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const type = e.dataTransfer.getData('nodeType') as NodeType
      if (!type) return
      const namespace = defaultNamespace(type, nodeNamespaces)
      snapshot()

      const newId = uid()
      // Auto-connect: find the nearest node above the drop point and wire it up
      const rawPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const snapTo = (v: number) => Math.round(v / 20) * 20
      const dropPos = { x: snapTo(rawPos.x), y: snapTo(rawPos.y) }
      const sourceNode = findDropSource(nodes, edges, dropPos)
      const sourceHandle = sourceNode ? chooseSourceHandle(sourceNode, dropPos.x) : null
      const existingOutEdge = (sourceNode && sourceHandle)
        ? edges.find((e) => e.source === sourceNode.id && e.sourceHandle === sourceHandle)
        : null
      // True when we can simply append after sourceNode (handle is free)
      const autoConnected = !!(sourceNode && sourceHandle && !existingOutEdge)
      // True when we need to INSERT between sourceNode and its current target
      const insertBetween = !!(sourceNode && sourceHandle && existingOutEdge)

      // Branch drops create a start+end pair. The end node is a passive
      // convergence marker — chains from each branch handle terminate either
      // by exiting or by feeding into branch_end. Mirrors the parallel
      // start/end pattern but the end's input is fan-in from any subset of
      // the branch's handles, not a hard join.
      if (type === 'branch') {
        const endId = uid()
        const endNamespace = defaultNamespace('branch_end', [...nodeNamespaces, namespace])
        const startNode = {
          id: newId,
          type: 'branch' as NodeType,
          position: { x: 0, y: 0 },
          data: {
            namespace,
            config: defaultNodeConfig('branch'),
            variables: {},
            _pairId: endId,
          } satisfies CanvasNodeData,
        }
        const endNode = {
          id: endId,
          type: 'branch_end' as NodeType,
          position: { x: 0, y: 0 },
          data: { namespace: endNamespace, config: {}, variables: {}, _pairId: newId } satisfies CanvasNodeData,
        }
        // Hidden backbone edge so Dagre ranks end below start before any handle is wired
        const backboneEdge = { id: uid(), source: newId, target: endId, sourceHandle: 'output', hidden: true }
        let newEdges = [...edges, backboneEdge]
        if (autoConnected) {
          newEdges = [...newEdges, { id: uid(), source: sourceNode!.id, target: newId, sourceHandle: sourceHandle! }]
        } else if (insertBetween) {
          newEdges = [
            ...edges.filter((e) => e.id !== existingOutEdge!.id),
            backboneEdge,
            { id: uid(), source: sourceNode!.id, target: newId, sourceHandle: sourceHandle! },
            { id: uid(), source: endId, target: existingOutEdge!.target, sourceHandle: 'output' },
          ]
        }
        const nextNodes = layoutWorkflow([...nodes, startNode, endNode], newEdges)
        if (sourceNode) layoutPreservingViewport(sourceNode.id, nodes, nextNodes)
        setEdges(newEdges)
        setNodes(nextNodes)
        setSelectedNodeId(newId)
        setIsDirty(true)
        return
      }

      // Parallel drops create a start+end pair with a placeholder edge between them
      if (type === 'parallel') {
        const endId = uid()
        const endNamespace = defaultNamespace('parallel_end', [...nodeNamespaces, namespace])
        const startNode = {
          id: newId,
          type: 'parallel' as NodeType,
          position: { x: 0, y: 0 },
          data: {
            namespace,
            config: { wait_for: 'all', timeout_ms: 15000, on_timeout: 'partial', on_child_error: 'fail', children: [], retries: 2 },
            variables: {},
            _pairId: endId,
          } satisfies CanvasNodeData,
        }
        const endNode = {
          id: endId,
          type: 'parallel_end' as NodeType,
          position: { x: 0, y: 0 },
          data: { namespace: endNamespace, config: {}, variables: {}, _pairId: newId } satisfies CanvasNodeData,
        }
        // Hidden backbone edge so Dagre ranks end below start even before children are wired
        const backboneEdge = { id: uid(), source: newId, target: endId, sourceHandle: 'output', hidden: true }
        let newEdges = [...edges, backboneEdge]
        if (autoConnected) {
          newEdges = [...newEdges, { id: uid(), source: sourceNode!.id, target: newId, sourceHandle: sourceHandle! }]
        } else if (insertBetween) {
          newEdges = [
            ...edges.filter((e) => e.id !== existingOutEdge!.id),
            backboneEdge,
            { id: uid(), source: sourceNode!.id, target: newId, sourceHandle: sourceHandle! },
            { id: uid(), source: endId, target: existingOutEdge!.target, sourceHandle: 'output' },
          ]
        }
        const nextNodes = layoutWorkflow([...nodes, startNode, endNode], newEdges)
        if (sourceNode) layoutPreservingViewport(sourceNode.id, nodes, nextNodes)
        setEdges(newEdges)
        setNodes(nextNodes)
        setSelectedNodeId(newId)
        setIsDirty(true)
        return
      }

      const newNode = {
        id: newId,
        type,
        position: { x: 0, y: 0 }, // dagre will position it
        data: { namespace, config: defaultNodeConfig(type), variables: {} } satisfies CanvasNodeData,
      }

      let newEdges = edges
      if (autoConnected) {
        newEdges = [...edges, { id: uid(), source: sourceNode!.id, target: newId, sourceHandle: sourceHandle! }]
      } else if (insertBetween) {
        newEdges = [
          ...edges.filter((e) => e.id !== existingOutEdge!.id),
          { id: uid(), source: sourceNode!.id, target: newId, sourceHandle: sourceHandle! },
          { id: uid(), source: newId, target: existingOutEdge!.target, sourceHandle: 'output' },
        ]
      }

      if (autoConnected || insertBetween) {
        const nextNodes = layoutWorkflow([...nodes, newNode], newEdges)
        if (sourceNode) layoutPreservingViewport(sourceNode.id, nodes, nextNodes)
        setEdges(newEdges)
        setNodes(nextNodes)
      } else {
        // No suitable source found — drop free-floating at the cursor position
        setEdges(newEdges)
        setNodes((ns) => [...ns, { ...newNode, position: dropPos, draggable: true }])
      }
      setSelectedNodeId(newId)
      setIsDirty(true)
    },
    [nodeNamespaces, snapshot, setNodes, setEdges, edges, nodes, screenToFlowPosition, layoutPreservingViewport]
  )

  // ── Node update / delete ────────────────────────────────────────────────────

  // Rewrite `steps.OLD.…` → `steps.NEW.…` in every node's config + variables,
  // and rewrite a `fallback_node: 'OLD'` field to `'NEW'`. Single setNodes call
  // so undo treats the rename and reference updates as one atomic step.
  const applyCanvasRename = useCallback(
    (renamingNodeId: string, oldNs: string, newNs: string) => {
      setNodes((ns) =>
        ns.map((n) => {
          const nextData: Record<string, unknown> = { ...(n.data as object) }
          let changed = false
          // The node being renamed gets its namespace updated.
          if (n.id === renamingNodeId) {
            nextData.namespace = newNs
            changed = true
          } else {
            // Other nodes: rewrite steps.X references plus the bare-namespace
            // fields (fallback_node, parallel_source) inside config + variables.
            const config = (nextData.config ?? {}) as Record<string, unknown>
            let newConfig = renameStepReferences(config, oldNs, newNs) as Record<string, unknown>
            newConfig = renameBareNamespaceFields(newConfig, oldNs, newNs) as Record<string, unknown>
            if (newConfig !== config) {
              nextData.config = newConfig
              changed = true
            }
            const variables = nextData.variables as Record<string, string> | undefined
            if (variables) {
              const newVars = renameStepReferences(variables, oldNs, newNs) as Record<string, string>
              if (newVars !== variables) {
                nextData.variables = newVars
                changed = true
              }
            }
          }
          return changed ? { ...n, data: nextData } : n
        })
      )
      // The trigger's success_node_namespaces is a bare-namespace list that
      // lives on the trigger ref, not on a node config, so rewrite it here too.
      const successList = triggerRef.current.config.success_node_namespaces
      const renamedSuccess = renameNamespaceInList(successList, oldNs, newNs)
      if (renamedSuccess !== successList) {
        triggerRef.current = {
          ...triggerRef.current,
          config: { ...triggerRef.current.config, success_node_namespaces: renamedSuccess as string[] },
        }
        setTriggerVersion((v) => v + 1)
      }
      setIsDirty(true)
    },
    [setNodes, setTriggerVersion]
  )

  const handleRenameRequest = useCallback(
    async (oldNs: string, newNs: string): Promise<boolean> => {
      // Count references in OTHER nodes' configs and variables.
      let canvasRefs = 0
      for (const n of nodes) {
        const data = n.data as unknown as CanvasNodeData
        if (data?.namespace === oldNs) continue
        canvasRefs += countStepReferences(data?.config, oldNs)
        canvasRefs += countStepReferences(data?.variables, oldNs)
        // Bare-namespace fields: fallback_node + parallel_source.
        canvasRefs += countBareNamespaceRefs(data?.config, oldNs)
      }
      // The trigger's success_node_namespaces references nodes by bare namespace.
      if ((triggerRef.current.config.success_node_namespaces ?? []).includes(oldNs)) {
        canvasRefs += 1
      }
      // Partner formula impact (workflow + cross-workflow analysis).
      let partnerFormulas: PartnerFormulaImpact[] = []
      try {
        const impact = await api.workflows.renameImpact(workflow.id, oldNs, newNs)
        partnerFormulas = impact.partner_formulas
      } catch {
        // If impact fetch fails we fall through with no formula data — canvas
        // rewrites still happen. The user gets to see what's at least
        // discoverable client-side.
      }

      // Find this node id (the node whose namespace is being renamed) so the
      // canvas rewrite can stamp the new value on the right node.
      const renamingNode = nodes.find((n) => (n.data as unknown as CanvasNodeData)?.namespace === oldNs)
      if (!renamingNode) return false

      if (canvasRefs === 0 && partnerFormulas.length === 0) {
        // Silent path — no references anywhere. Just rename the node itself.
        applyCanvasRename(renamingNode.id, oldNs, newNs)
        return true
      }

      // Prompt the user.
      return new Promise<boolean>((resolve) => {
        setRenamePrompt({
          oldNs,
          newNs,
          canvasReferenceCount: canvasRefs,
          partnerFormulas,
          resolve: (committed) => {
            setRenamePrompt(null)
            if (committed) {
              applyCanvasRename(renamingNode.id, oldNs, newNs)
              const safeIds = partnerFormulas.filter((p) => p.can_rewrite).map((p) => p.partner_id)
              if (safeIds.length > 0) {
                pendingFormulaRenamesRef.current.push({ oldNs, newNs, partner_ids: safeIds })
              }
            }
            resolve(committed)
          },
        })
      })
    },
    [nodes, workflow.id, applyCanvasRename]
  )

  const handleNodeUpdate = useCallback(
    (id: string, patch: Partial<CanvasNodeData>) => {
      // A branch arm's handle id IS its label (configuredHandleIds), so
      // renaming an arm changes the handle and would orphan any edge wired to
      // it. Detect same-position label renames and carry the connected edges
      // over to the new handle so wires stay attached.
      const oldNode = nodes.find((n) => n.id === id)
      if (oldNode?.type === 'branch' && (patch.config as Record<string, unknown> | undefined)?.branches) {
        const oldBranches = ((oldNode.data as unknown as CanvasNodeData).config?.branches as { label: string }[] | undefined) ?? []
        const newBranches = ((patch.config as Record<string, unknown>).branches as { label: string }[] | undefined) ?? []
        if (oldBranches.length === newBranches.length) {
          const renames = new Map<string, string>()
          oldBranches.forEach((b, i) => {
            const nl = newBranches[i]?.label
            if (nl && nl !== b.label) renames.set(b.label, nl)
          })
          if (renames.size > 0) {
            setEdges((es) =>
              es.map((e) =>
                e.source === id && e.sourceHandle && renames.has(e.sourceHandle)
                  ? { ...e, sourceHandle: renames.get(e.sourceHandle) as string }
                  : e
              )
            )
          }
        }
      }
      setNodes((ns) => {
        // First, write the patched data into the matching node.
        const patched = ns.map((n) => {
          if (n.id !== id) return n
          const nextData = { ...(n.data as object), ...patch }
          // Branch and parallel widths depend on their footer labels. When the
          // labels change, keep the node's horizontal center fixed so upstream
          // edges stay aligned with the top input handle.
          if (n.type === 'branch' || n.type === 'parallel') {
            const oldW = nodeWidth(n.type, n.data)
            const newW = nodeWidth(n.type, nextData)
            if (oldW !== newW) {
              return {
                ...n,
                data: nextData,
                position: { x: n.position.x + (oldW - newW) / 2, y: n.position.y },
              }
            }
          }
          return { ...n, data: nextData }
        })
        // Re-run layout only when the multi-output's handle COUNT changes
        // (an arm added/removed) — that's what makes `_spanWidth` /
        // `_handleOffsets` stale and would otherwise stack new labels on old
        // offsets. A pure RENAME keeps the same number of handles and the same
        // slot/subtree widths, so the offsets are still valid; re-laying-out on
        // a rename needlessly re-flows the whole graph (longer label → wider
        // node → everything shifts). The width-recenter above already keeps the
        // node visually stable, so a rename moves nothing.
        const target = ns.find((n) => n.id === id)
        if (target && (target.type === 'branch' || target.type === 'parallel')) {
          const beforeCount = configuredHandleIds(target)?.length ?? 0
          const after = patched.find((n) => n.id === id)
          const afterCount = after ? configuredHandleIds(after)?.length ?? 0 : 0
          if (beforeCount !== afterCount) return layoutWorkflow(patched, edges)
        }
        return patched
      })
      setIsDirty(true)
    },
    [setNodes, setEdges, edges, nodes]
  )

  // Resolves the matching end/start id for a parallel or branch container node.
  // Returns undefined for nodes that aren't half of a container pair.
  const resolvePairId = useCallback(
    (node: Node): string | undefined => {
      const explicit = (node.data as unknown as CanvasNodeData)?._pairId
      if (explicit) return explicit
      if (node.type === 'parallel' || node.type === 'branch') {
        const endType = node.type === 'parallel' ? 'parallel_end' : 'branch_end'
        const visited = new Set<string>([node.id])
        const queue = [node.id]
        while (queue.length > 0) {
          const cur = queue.shift()!
          for (const e of edges) {
            if (e.source !== cur || visited.has(e.target)) continue
            visited.add(e.target)
            const target = nodes.find((n) => n.id === e.target)
            if (target?.type === endType) return target.id
            queue.push(e.target)
          }
        }
      } else if (node.type === 'parallel_end' || node.type === 'branch_end') {
        const startType = node.type === 'parallel_end' ? 'parallel' : 'branch'
        const visited = new Set<string>([node.id])
        const queue = [node.id]
        while (queue.length > 0) {
          const cur = queue.shift()!
          for (const e of edges) {
            if (e.target !== cur || visited.has(e.source)) continue
            visited.add(e.source)
            const source = nodes.find((n) => n.id === e.source)
            if (source?.type === startType) return source.id
            queue.push(e.source)
          }
        }
      }
      return undefined
    },
    [nodes, edges]
  )

  // Returns the set of node ids strictly between a container's start and end —
  // everything on a path from startId forward that reaches endId, excluding
  // start, end, and anything past end.
  const collectInnerIds = useCallback(
    (startId: string, endId: string): Set<string> => {
      const inner = new Set<string>()
      const visited = new Set<string>([startId, endId])
      const queue = [startId]
      while (queue.length > 0) {
        const cur = queue.shift()!
        for (const e of edges) {
          if (e.source !== cur) continue
          if (e.target === endId || visited.has(e.target)) continue
          visited.add(e.target)
          inner.add(e.target)
          queue.push(e.target)
        }
      }
      return inner
    },
    [edges]
  )

  // Confirmation state for deleting a container (parallel / branch) that has
  // nodes inside it. Stays null when no prompt is needed.
  const [pendingContainerDelete, setPendingContainerDelete] = useState<{
    outerIds: string[]
    innerIds: string[]
    containerLabel: string
  } | null>(null)

  const executeNodesDelete = useCallback(
    (ids: string[]) => {
      const idsToRemove = new Set(ids.filter((id) => id !== 'trigger'))
      if (idsToRemove.size === 0) return
      snapshot()

      // Splice surviving upstream → downstream across the gap, preserving the
      // upstream edge's sourceHandle so deleting a node on a branch/filter arm
      // doesn't dead-end that arm at runtime. See computeEdgesAfterDelete.
      const newEdges = computeEdgesAfterDelete(edges, idsToRemove)
      const newNodes = nodes.filter((n) => !idsToRemove.has(n.id))
      // Any node that lost all paths back to the trigger gets pushed off to the
      // right of the surviving flow so the visible chain isn't muddled by an
      // orphaned subtree sitting in its column.
      const shifted = shiftOrphansRight(newNodes, newEdges)
      setEdges(newEdges)
      setNodes(layoutWorkflow(shifted, newEdges))
      setSelectedNodeId(null)
      setIsDirty(true)
    },
    [snapshot, nodes, edges, setNodes, setEdges]
  )

  const handleNodesDelete = useCallback(
    (ids: string[]) => {
      const seedIds = ids.filter((id) => id !== 'trigger')
      if (seedIds.length === 0) return

      // Expand container starts/ends so parallel and branch pairs are always
      // deleted together. Separately track the nodes that sit inside each
      // container; if any have content we'll ask before deleting them.
      const outerIds = new Set<string>(seedIds)
      const innerIds = new Set<string>()
      let containerLabel = ''
      for (const id of seedIds) {
        const node = nodes.find((n) => n.id === id)
        if (!node) continue
        const pairId = resolvePairId(node)
        if (!pairId) continue
        outerIds.add(pairId)
        const startId = node.type === 'parallel' || node.type === 'branch' ? id : pairId
        const endId = startId === id ? pairId : id
        for (const innerId of collectInnerIds(startId, endId)) {
          if (!outerIds.has(innerId)) innerIds.add(innerId)
        }
        if (!containerLabel) {
          const startNode = nodes.find((n) => n.id === startId)
          const d = startNode?.data as unknown as CanvasNodeData | undefined
          containerLabel = d?.label || d?.namespace || (startNode?.type === 'branch' ? 'branch' : 'parallel')
        }
      }

      // Inner ids that are also being explicitly deleted (e.g. user multi-selected
      // them along with the container) don't count toward the prompt.
      for (const id of seedIds) innerIds.delete(id)

      if (innerIds.size === 0) {
        executeNodesDelete([...outerIds])
        return
      }

      setPendingContainerDelete({
        outerIds: [...outerIds],
        innerIds: [...innerIds],
        containerLabel,
      })
    },
    [nodes, resolvePairId, collectInnerIds, executeNodesDelete]
  )

  const handleNodeDelete = useCallback((id: string) => handleNodesDelete([id]), [handleNodesDelete])

  // Shared logic for paste and duplicate
  function pasteNode(cb: {
    type: NodeType
    config: Record<string, unknown>
    variables: Record<string, unknown>
    position: { x: number; y: number }
    /** Preferred namespace (e.g. "return_response_copy"); falls back to type default if collision-unrecoverable. */
    namespace?: string
    /** Preferred label (e.g. "Return Response (copy)"). */
    label?: string
  }) {
    const ns = cb.namespace
      ? dedupNamespace(cb.namespace, nodeNamespaces)
      : defaultNamespace(cb.type, nodeNamespaces)
    const newId = uid()
    snapshot()
    setNodes((prev) => {
      const position = findFreePosition(cb.position.x + NODE_W + 24, cb.position.y, cb.type, prev)
      return [
      ...prev,
      {
        id: newId,
        type: cb.type,
        position,
        data: {
          namespace: ns,
          ...(cb.label ? { label: cb.label } : {}),
          config: JSON.parse(JSON.stringify(cb.config)),
          variables: JSON.parse(JSON.stringify(cb.variables)),
        } satisfies CanvasNodeData,
      },
    ]})
    setSelectedNodeId(newId)
    setIsDirty(true)
  }

  function duplicateNode(node: Node) {
    const d = node.data as unknown as CanvasNodeData
    const origLabel = d.label && d.label.length > 0 ? d.label : d.namespace
    const { namespace, label } = nextCopyName(d.namespace, origLabel, nodeNamespaces)
    pasteNode({
      type: node.type as NodeType,
      config: d.config ?? {},
      variables: d.variables ?? {},
      position: node.position,
      namespace,
      label,
    })
  }

  // All nodes enclosed by a container start (branch/parallel): the start, every
  // node reachable from it up to AND including its paired *_end, but nothing
  // downstream of that end. Nested containers' ends are interior, so they're
  // walked through. Non-container nodes resolve to just themselves. This is what
  // makes "duplicate a branch start" pull the whole branch + end + insides.
  function collectNodeScope(startId: string): string[] {
    const start = nodes.find((n) => n.id === startId)
    if (!start) return []
    if (start.type !== 'branch' && start.type !== 'parallel') return [startId]
    const endType = start.type === 'branch' ? 'branch_end' : 'parallel_end'
    const pairedEnd = edges.find(
      (e) => e.source === startId && nodes.find((n) => n.id === e.target)?.type === endType
    )?.target
    const scope = new Set<string>([startId])
    // Parallel slots can be referenced by `children` rather than only by edges.
    const seedChildren = (start as { children?: string[] }).children ?? []
    const queue = [startId, ...seedChildren.filter((c) => { scope.add(c); return true })]
    while (queue.length > 0) {
      const cur = queue.shift() as string
      if (cur === pairedEnd) continue // include the end, but don't escape past it
      for (const e of edges) {
        if (e.source === cur && !scope.has(e.target)) {
          scope.add(e.target)
          queue.push(e.target)
        }
      }
    }
    return [...scope]
  }

  const handleNodeDuplicate = useCallback(
    (id: string) => { duplicateNodes([id]) },
    [nodes, edges, nodeNamespaces, snapshot, setNodes, setEdges] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Duplicate one or more nodes as a group, preserving the edges that run
  // BETWEEN them (so a cloned subtree — e.g. a branch + its branch_end + the
  // nodes in between — comes out fully wired internally). Selecting a branch/
  // parallel start auto-expands to its whole scope. Edges that cross the
  // selection boundary are dropped: the copy lands disconnected from the rest
  // of the flow for the user to wire in. New nodes get fresh ids, numbered
  // `_N` namespaces, and become the active selection.
  function duplicateNodes(ids: string[]) {
    const idSet = new Set<string>()
    for (const id of ids) {
      if (id === 'trigger') continue
      for (const scoped of collectNodeScope(id)) idSet.add(scoped)
    }
    const selNodes = nodes.filter((n) => idSet.has(n.id))
    if (selNodes.length === 0) return
    if (selNodes.length === 1) { duplicateNode(selNodes[0]); return }

    snapshot()
    // Drop the whole group into clear space to the right of the existing graph
    // (same convention as a disconnected subgraph) so it never lands on top of
    // other nodes, keeping its internal relative layout intact. Once the user
    // wires it in, auto-layout takes over and slots it into the flow.
    const selMinX = Math.min(...selNodes.map((n) => n.position.x))
    const others = nodes.filter((n) => !idSet.has(n.id) && n.id !== 'trigger')
    const graphRight = others.length > 0 ? Math.max(...others.map((n) => n.position.x + NODE_W)) : selMinX
    const OFFSET = { x: graphRight + DISCONNECTED_GAP - selMinX, y: 0 }
    // First pass: assign every cloned node its new id + numbered namespace, and
    // build old→new id and namespace maps. Both maps must be complete before we
    // build any node, because each cloned config gets its intra-cluster `steps.*`
    // and child/pair references remapped against the FULL maps.
    const working = [...nodeNamespaces]
    const idMap = new Map<string, string>()
    const nsMap = new Map<string, string>()
    const meta = selNodes.map((n) => {
      const d = n.data as unknown as CanvasNodeData
      idMap.set(n.id, uid())
      const origLabel = d.label && d.label.length > 0 ? d.label : d.namespace
      const { namespace: ns, label } = nextCopyName(d.namespace, origLabel, working)
      working.push(ns)
      nsMap.set(d.namespace, ns)
      return { n, d, ns, label }
    })

    const builtNodes = meta.map(({ n, d, ns, label }) => {
      // Remap any intra-selection child references (parallel groups); ids
      // outside the selection pass through unchanged.
      const remapChildren = (raw: unknown): unknown =>
        Array.isArray(raw)
          ? raw.map((c) =>
              typeof c === 'string'
                ? idMap.get(c) ?? c
                : c && typeof c === 'object' && 'id' in (c as Record<string, unknown>)
                  ? { ...(c as Record<string, unknown>), id: idMap.get((c as { id: string }).id) ?? (c as { id: string }).id }
                  : c
            )
          : raw
      let config = JSON.parse(JSON.stringify(d.config ?? {})) as Record<string, unknown>
      let variables = JSON.parse(JSON.stringify(d.variables ?? {})) as Record<string, string>
      // Rewrite `steps.<oldNs>` → `steps.<newNs>` for every namespace inside the
      // clone, so the copies read each other's output instead of the originals'.
      // References to nodes OUTSIDE the selection (shared upstream nodes like
      // constants / gen_vantage_score) aren't in nsMap, so they're left alone.
      for (const [oldNs, newNs] of nsMap) {
        config = renameStepReferences(config, oldNs, newNs) as Record<string, unknown>
        variables = renameStepReferences(variables, oldNs, newNs) as Record<string, string>
      }
      if (config.children !== undefined) config.children = remapChildren(config.children)
      // Remap the branch/parallel ↔ end pairing onto the cloned ids. Without
      // this the cloned end loses its `_pairId`, and layout's end-placement
      // post-process skips it — leaving the end at a raw, often overlapping
      // position. (`_pairId` is otherwise only re-derived on load.)
      const origPairId = (d as { _pairId?: string })._pairId
      const newPairId = origPairId ? idMap.get(origPairId) : undefined
      return {
        id: idMap.get(n.id) as string,
        type: n.type,
        position: { x: n.position.x + OFFSET.x, y: n.position.y + OFFSET.y },
        selected: true,
        ...((n as { children?: string[] }).children
          ? { children: ((n as { children?: string[] }).children as string[]).map((c) => idMap.get(c) ?? c) }
          : {}),
        data: {
          namespace: ns,
          label,
          ...(d.note ? { note: d.note } : {}),
          config,
          variables,
          ...(newPairId ? { _pairId: newPairId } : {}),
        } satisfies CanvasNodeData,
      } as Node
    })

    // Only edges with BOTH endpoints inside the selection are cloned.
    const newEdges = edges
      .filter((e) => idSet.has(e.source) && idSet.has(e.target))
      .map((e) => ({
        ...e,
        id: uid(),
        source: idMap.get(e.source) as string,
        target: idMap.get(e.target) as string,
      }))

    setNodes((prev) => [...prev.map((n) => ({ ...n, selected: false })), ...builtNodes])
    setEdges((prev) => [...prev, ...newEdges])
    setSelectedNodeId(null)
    setIsDirty(true)
  }

  const handleParallelEdgesChange = useCallback(
    (
      add: { id: string; source: string; target: string; sourceHandle: string }[],
      removeIds: string[]
    ) => {
      snapshot()
      setEdges((prev) => {
        const filtered = prev.filter((e) => !removeIds.includes(e.id))
        const newEdges = add.map((a) => ({
          id: a.id,
          source: a.source,
          target: a.target,
          sourceHandle: a.sourceHandle,
          data: {},
        }))
        return [...filtered, ...newEdges]
      })
      setIsDirty(true)
    },
    [snapshot, setEdges] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // ── Save ────────────────────────────────────────────────────────────────────

  async function openSaveMenu() {
    if (!isDirty || saving) return
    if (workflow.is_active && validationErrors.size > 0) {
      const names = Array.from(validationErrors.values())
        .map((e) => e.label || e.namespace)
        .join(', ')
      setSaveError(`Can't save a live workflow with unconfigured nodes: ${names}. Fix them or disable the workflow first.`)
      return
    }
    setSaveError(null)
    setShowCommitMenu(true)

    const def = flowToDef(nodes, edges, triggerRef.current)
    const defKey = JSON.stringify(def)

    // Skip the draft fetch if the textarea already has the right content.
    // - AI draft for this exact definition → leave it.
    // - User-typed message (aiDraftKeyRef cleared, commitMessage non-empty) → leave it.
    if (aiDraftKeyRef.current === defKey && commitMessage) return
    if (aiDraftKeyRef.current === null && commitMessage) return

    const reqId = ++draftReqIdRef.current
    setDraftLoading(true)
    try {
      const { draft } = await api.workflows.draftChangelog(workflow.id, def)
      if (reqId !== draftReqIdRef.current) return
      if (draft) {
        setCommitMessage(draft)
        aiDraftKeyRef.current = defKey
      } else {
        aiDraftKeyRef.current = null
      }
    } catch {
      // Silent fail — user can still type their own message.
      if (reqId === draftReqIdRef.current) aiDraftKeyRef.current = null
    } finally {
      if (reqId === draftReqIdRef.current) setDraftLoading(false)
    }
  }

  async function handleSave(message?: string) {
    // Block saving when two nodes share a Step ID — the engine keys
    // ctx.steps + step logs by namespace, and downstream references can't
    // distinguish duplicates. Always block (regardless of is_active) since
    // the workflow is always broken at runtime.
    const nsCount = new Map<string, number>()
    for (const n of nodes) {
      if (n.id === 'trigger') continue
      const ns = (n.data as unknown as CanvasNodeData).namespace
      if (ns) nsCount.set(ns, (nsCount.get(ns) ?? 0) + 1)
    }
    const duplicates = Array.from(nsCount.entries()).filter(([, c]) => c > 1).map(([ns]) => ns)
    if (duplicates.length > 0) {
      setSaveError(`Step IDs must be unique. Used by multiple nodes: ${duplicates.join(', ')}.`)
      return
    }
    // Block saving a live workflow that has unconfigured nodes
    if (workflow.is_active && validationErrors.size > 0) {
      const names = Array.from(validationErrors.values())
        .map((e) => e.label || e.namespace)
        .join(', ')
      setSaveError(`Can't save a live workflow with unconfigured nodes: ${names}. Fix them or disable the workflow first.`)
      return
    }
    setSaving(true)
    setSaveError(null)
    setSavedOk(false)
    setShowCommitMenu(false)
    try {
      const definition = flowToDef(nodes, edges, triggerRef.current)
      const trimmed = message?.trim()
      const result = await api.workflows.save(workflow.id, {
        name,
        definition,
        slack_channel: slackChannel || null,
        ...(trimmed ? { message: trimmed } : {}),
      })
      setIsDirty(false)
      setCommitMessage('')
      aiDraftKeyRef.current = null
      // Apply any queued partner-formula rewrites from Step ID renames during
      // this edit session. Runs AFTER the workflow save so the canvas
      // definition + partner formulas stay consistent (e.g. if save had
      // failed, the formulas wouldn't be rewritten).
      const queuedRenames = pendingFormulaRenamesRef.current
      pendingFormulaRenamesRef.current = []
      for (const rn of queuedRenames) {
        try {
          await api.workflows.renameApply(workflow.id, rn.oldNs, rn.newNs, rn.partner_ids)
        } catch (e) {
          // Don't block save UX — surface as a non-fatal banner.
          const msg = e instanceof Error ? e.message : 'Formula rewrite failed'
          setSaveError(`Saved, but failed to rewrite partner formulas for ${rn.oldNs}→${rn.newNs}: ${msg}`)
        }
      }
      if (result.deploy_errors?.length) {
        const msg = result.deploy_errors
          .map((e) => `${e.namespace}: ${e.error}`)
          .join('\n')
        setSaveError(`Saved, but ${result.deploy_errors.length === 1 ? 'one code node' : `${result.deploy_errors.length} code nodes`} failed to deploy:\n${msg}`)
      } else {
        setSavedOk(true)
        setTimeout(() => setSavedOk(false), 2500)
        switchMode('view')
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // ── Version restore ─────────────────────────────────────────────────────────

  async function handleVersionRestore(versionId: string) {
    await api.versions.restore(workflow.id, versionId)
    const updated = await api.workflows.get(workflow.id)
    const newNodes = defToNodes(
      updated.definition?.nodes ?? [],
      updated.definition?.edges ?? [],
      updated.definition?.trigger
    )
    const newEdges = defToEdges(updated.definition?.edges ?? [])
    setNodes(newNodes)
    setEdges(newEdges)
    triggerRef.current = updated.definition?.trigger ?? DEFAULT_TRIGGER
    setName(updated.name)
    setIsDirty(false)
    setShowVersions(false)
    requestAnimationFrame(() => fitView({ padding: 0.4, maxZoom: 0.5 }))
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen flex-col">
      {/* Top bar */}
      <header className={`flex h-12 flex-shrink-0 items-center justify-between border-b px-4 ${
        mode === 'edit' ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'
      }`}>
        <div className="flex items-center gap-3">
          <Link
            href="/workflows"
            onClick={(e) => {
              // Let the browser handle modifier / middle clicks natively (open in new tab).
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
              if (typeof document === 'undefined' || !('startViewTransition' in document)) return
              e.preventDefault()
              ;(document as Document & { startViewTransition(cb: () => void): void })
                .startViewTransition(() => router.push('/workflows'))
            }}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← Workflows
          </Link>
          <div className="h-5 w-px bg-gray-200" />
          <div className="group flex items-center gap-1">
            {mode === 'edit' ? (
              <>
                <input
                  ref={nameRef}
                  style={{ viewTransitionName: 'workflow-name' }}
                  className="rounded border-0 bg-transparent text-base font-bold tracking-tight text-graphite outline-none ring-0 px-2 py-1 hover:bg-gray-100/70 focus:bg-gray-100/70 focus:ring-1 focus:ring-p-blue-light"
                  value={name}
                  onChange={(e) => { setName(e.target.value); setIsDirty(true) }}
                />
                <Pencil className="h-3 w-3 flex-shrink-0 text-gray-300 opacity-0 transition-opacity group-hover:opacity-100" />
              </>
            ) : (
              <span
                style={{ viewTransitionName: 'workflow-name' }}
                className="px-2 py-1 text-base font-bold tracking-tight text-graphite"
              >
                {name}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Group: Mode */}
          <div className="flex overflow-hidden rounded border border-gray-200 text-xs">
            <button
              onClick={() => switchMode('edit')}
              className={`flex items-center gap-1 px-2.5 py-1.5 font-medium ${
                mode === 'edit' ? 'bg-p-blue-dark text-white' : 'bg-white text-gray-400 hover:bg-beige'
              }`}
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
            <button
              onClick={() => switchMode('view')}
              className={`flex items-center gap-1 border-l border-gray-200 px-2.5 py-1.5 font-medium ${
                mode === 'view' ? 'bg-gray-100 text-gray-800' : 'bg-white text-gray-400 hover:bg-beige'
              }`}
            >
              <Eye className="h-3 w-3" />
              View
            </button>
          </div>

          <div className="h-5 w-px bg-gray-200" />

          {/* Group: History (edit only) */}
          {mode === 'edit' && (
            <>
              <button
                onClick={undo}
                disabled={history.length === 0}
                className="rounded p-1.5 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
                title="Undo (⌘Z)"
              >
                <Undo2 className="h-4 w-4" />
              </button>
              <button
                onClick={redo}
                disabled={future.length === 0}
                className="rounded p-1.5 text-gray-400 hover:bg-gray-100 disabled:opacity-30"
                title="Redo (⌘⇧Z)"
              >
                <Redo2 className="h-4 w-4" />
              </button>
              <div className="h-5 w-px bg-gray-200" />
            </>
          )}

          {/* Group: Utilities */}
          {mode === 'edit' && (
            <button
              onClick={() => { setShowTest((s) => !s); setSelectedNodeId(null) }}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium ${
                showTest
                  ? 'border-p-blue-light bg-p-blue-light text-p-blue-dark'
                  : 'border-gray-200 text-gray-600 hover:bg-beige'
              }`}
              title="Run a test execution"
            >
              <FlaskConical className="h-3.5 w-3.5" />
              Test
            </button>
          )}

          {/* Version history — always visible */}
          <button
            onClick={() => setShowVersions((s) => !s)}
            className={`rounded p-1.5 hover:bg-gray-100 ${showVersions ? 'bg-gray-100 text-gray-700' : 'text-gray-400'}`}
            title="Version history"
          >
            <Clock className="h-4 w-4" />
          </button>

          {mode === 'edit' && <div className="h-5 w-px bg-gray-200" />}

          {/* Validation warning */}
          {mode === 'edit' && validationErrors.size > 0 && (
            <div className="flex items-center gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              {validationErrors.size} node{validationErrors.size !== 1 ? 's' : ''} unconfigured
            </div>
          )}

          {/* Group: State */}
          {mode === 'edit' && (
            <div className="relative">
              <button
                onClick={openSaveMenu}
                disabled={saving || !isDirty}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-40 ${
                  saving    ? 'bg-p-blue-dark' :
                  savedOk   ? 'bg-green-600 hover:bg-green-700' :
                  isDirty   ? 'bg-amber-500 hover:bg-amber-600' :
                              'bg-gray-300 cursor-default'
                }`}
              >
                {savedOk ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {saving ? 'Saving…' : savedOk ? 'Saved' : 'Save'}
              </button>
              {showCommitMenu && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setShowCommitMenu(false)}
                  />
                  <div className="absolute right-0 top-full z-50 mt-1.5 w-80 rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
                    <p className="mb-2 text-xs font-medium text-gray-700">What changed? <span className="font-normal text-gray-400">(optional)</span></p>
                    {draftLoading ? (
                      <div className="flex h-[68px] flex-col justify-center rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5">
                        <div className="flex items-center gap-2 text-xs text-gray-500">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Drafting summary…
                        </div>
                        <div className="mt-2 space-y-1.5">
                          <div className="h-1.5 w-3/4 animate-pulse rounded bg-gray-200" />
                          <div className="h-1.5 w-1/2 animate-pulse rounded bg-gray-200" />
                        </div>
                      </div>
                    ) : (
                      <textarea
                        autoFocus
                        value={commitMessage}
                        onChange={(e) => {
                          setCommitMessage(e.target.value)
                          aiDraftKeyRef.current = null
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            setShowCommitMenu(false)
                          } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                            e.preventDefault()
                            handleSave(commitMessage)
                          }
                        }}
                        placeholder="Describe these changes…"
                        rows={3}
                        className="w-full resize-none rounded-md border border-gray-200 px-2.5 py-1.5 text-xs leading-relaxed text-gray-700 focus:border-p-blue-dark focus:outline-none focus:ring-1 focus:ring-p-blue-dark"
                      />
                    )}
                    <div className="mt-2.5 flex items-center justify-between">
                      <span className="text-[11px] text-gray-400">⌘↵ to save</span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setShowCommitMenu(false)}
                          className="rounded-md px-2.5 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleSave(commitMessage)}
                          disabled={draftLoading}
                          className="rounded-md bg-amber-500 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Canvas area */}
      <div className="flex flex-1 overflow-hidden">
        {mode === 'edit' ? (
          <NodePalette onDragStart={onDragStart} />
        ) : (
          <ExecutionListPanel
            workflowId={workflow.id}
            selectedId={executionId}
            onSelect={selectExecution}
            refreshSignal={refreshSignal}
          />
        )}

        {/* Center column: banners stacked on top of the React Flow canvas. Right rail lives as a sibling
            of this column so it spans the full height of the canvas row (up to just under the header). */}
        <div className="flex flex-1 flex-col min-w-0">
          {mode === 'view' && executionId && (
            <div className="flex items-center justify-between border-b border-p-blue-light bg-p-blue-light px-4 py-1.5 text-xs">
              <div className="flex items-center gap-2 text-p-blue-dark">
                <Eye className="h-3.5 w-3.5" />
                <span className="font-medium">Viewing execution</span>
                <span className="font-mono text-p-blue-dark">{executionId.slice(0, 8)}…</span>
              </div>
              <div className="flex items-center gap-3">
                <a
                  href={`/workflows/${workflow.id}/executions/${executionId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-p-blue-dark hover:text-navy"
                  title="Open full execution report"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Full report
                </a>
                {executionPayload !== undefined && (
                  <button
                    onClick={() => {
                      setTestInitialPayload(JSON.stringify(executionPayload, null, 2))
                      setShowTest(true)
                      switchMode('edit')
                    }}
                    className="flex items-center gap-1 text-p-blue-dark hover:text-navy"
                    title="Load this payload into the test panel"
                  >
                    <FlaskConical className="h-3.5 w-3.5" />
                    Use as test
                  </button>
                )}
                <button
                  disabled={replaying}
                  onClick={async () => {
                    setReplaying(true)
                    try {
                      const { executionId: newId } = await api.executions.replay(executionId)
                      setRefreshSignal((s) => s + 1)
                      if (newId) selectExecution(newId)
                    } finally {
                      setReplaying(false)
                    }
                  }}
                  className="flex items-center gap-1 text-p-blue-dark hover:text-navy disabled:opacity-50"
                  title="Re-run with the same trigger payload"
                >
                  {replaying
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <RotateCcw className="h-3.5 w-3.5" />}
                  Replay
                </button>
                <button
                  onClick={() => {
                    // Drop the execution view synchronously, then update the URL.
                    // Going through router first puts the state clear inside the
                    // App Router transition, which holds the visual update until
                    // the URL settles — visible as a 1-2s lag on this Clear.
                    onClearExecution?.()
                    router.replace(`/workflows/${workflow.id}?mode=view`)
                  }}
                  className="flex items-center gap-1 text-p-blue-dark hover:text-p-blue-dark"
                >
                  <X className="h-3.5 w-3.5" />
                  Clear
                </button>
              </div>
            </div>
          )}

          {mode === 'view' && executionId && (executionParentId || (executionChildren && executionChildren.length > 0)) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-gray-100 bg-beige px-4 py-1.5 text-xs text-gray-600">
              {executionParentId && (
                <span className="flex items-center gap-1.5">
                  <RotateCcw className="h-3 w-3 text-gray-400" />
                  <span>Replay of</span>
                  <button
                    onClick={() => executionParentId && selectExecution(executionParentId)}
                    className="font-mono text-p-blue-dark underline-offset-2 hover:underline"
                  >
                    {executionParentId.slice(0, 8)}…
                  </button>
                </span>
              )}
              {executionChildren && executionChildren.length > 0 && (
                <span className="flex items-center gap-1.5">
                  <RotateCcw className="h-3 w-3 text-gray-400" />
                  <span>Replayed {executionChildren.length === 1 ? 'as' : `${executionChildren.length} times — latest`}</span>
                  <button
                    onClick={() => {
                      const latest = executionChildren[executionChildren.length - 1]
                      selectExecution(latest.id)
                    }}
                    className="font-mono text-p-blue-dark underline-offset-2 hover:underline"
                  >
                    {executionChildren[executionChildren.length - 1].id.slice(0, 8)}…
                  </button>
                </span>
              )}
            </div>
          )}

          {saveError && (
            <div className="flex items-center gap-2 bg-red-50 px-4 py-2 text-xs text-red-600">
              <AlertCircle className="h-3.5 w-3.5" />
              {saveError}
            </div>
          )}

          <div className="relative flex-1 min-h-0" onDrop={mode === 'edit' ? onDrop : undefined} onDragOver={mode === 'edit' ? onDragOver : undefined}>
          {!layoutSettled && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white">
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Laying out workflow…
              </div>
            </div>
          )}
          <div
            className="h-full w-full"
            style={layoutSettled ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
          >
          <ReactFlow
            nodes={renderedNodes}
            edges={renderedEdges}
            onNodesChange={(changes) => {
              onNodesChange(changes)
              if (changes.some((c) => c.type === 'remove' || c.type === 'position')) setIsDirty(true)

              // Skip slot-in logic when multiple nodes just finished dragging
              // together — that's a group move, not a single-node re-placement.
              const finishedPositionChanges = changes.filter(
                (c) => c.type === 'position' && c.dragging === false
              )
              const isGroupDrag = finishedPositionChanges.length > 1
              if (isGroupDrag) return

              const reachableIds = finishedPositionChanges.length > 0
                ? reachableFromTrigger(nodes, edges)
                : null

              for (const change of changes) {
                if (change.type !== 'position' || change.dragging !== false) continue
                // Don't let the trigger node be reordered
                if (change.id === 'trigger') {
                  setNodes((ns) => layoutWorkflow(ns, edges))
                  continue
                }

                const node = nodes.find((n) => n.id === change.id)
                if (!node) continue

                // Disconnected subgraphs get pure free-drag: no auto-connect
                // on proximity. Wiring back in happens by dragging the wire
                // or connecting handles explicitly.
                if (reachableIds && !reachableIds.has(change.id)) {
                  const d = node.data as unknown as CanvasNodeData
                  if (d.manualPosition !== true) {
                    setNodes((ns) => ns.map((n) => n.id === change.id
                      ? { ...n, data: { ...(n.data as object), manualPosition: true } }
                      : n
                    ))
                  }
                  continue
                }

                const finalPos = (change as { position?: { x: number; y: number } }).position ?? node.position
                const otherNodes = nodes.filter((n) => n.id !== change.id)
                const isConnected = edges.some((e) => e.source === change.id || e.target === change.id)

                if (!isConnected) {
                  // SLOT-IN: isolated node dragged near the workflow → auto-connect
                  const sourceNode = findDropSource(otherNodes, edges, finalPos)
                  const sourceHandle = sourceNode ? chooseSourceHandle(sourceNode, finalPos.x) : null
                  const existingOutEdge = (sourceNode && sourceHandle)
                    ? edges.find((e) => e.source === sourceNode.id && e.sourceHandle === sourceHandle)
                    : null

                  if (sourceNode && sourceHandle && !existingOutEdge) {
                    // Append: handle is free, simply connect sourceNode → this node
                    const newEdges = [...edges, { id: uid(), source: sourceNode.id, target: change.id, sourceHandle }]
                    setEdges(newEdges)
                    setNodes((ns) => layoutWorkflow(ns, newEdges))
                    setIsDirty(true)
                  } else if (sourceNode && sourceHandle && existingOutEdge) {
                    // Insert between: remove sourceNode→oldTarget, add sourceNode→this→oldTarget
                    const newEdges = [
                      ...edges.filter((e) => e.id !== existingOutEdge.id),
                      { id: uid(), source: sourceNode.id, target: change.id, sourceHandle },
                      { id: uid(), source: change.id, target: existingOutEdge.target, sourceHandle: 'output' },
                    ]
                    setEdges(newEdges)
                    setNodes((ns) => layoutWorkflow(ns, newEdges))
                    setIsDirty(true)
                  } else {
                  // If no valid slot found, keep free-floating but push away from any overlap
                  if (overlapsAny(finalPos, node.type, otherNodes)) {
                    const safePos = findFreePosition(finalPos.x, finalPos.y, node.type, otherNodes)
                    setNodes((ns) => ns.map((n) => n.id === change.id ? { ...n, position: safePos } : n))
                  }
                  // If no valid slot found, node stays where it was dropped (free-floating)
                  }
                } else {
                  // REORDER: connected node dragged to a new position in the flow
                  const newSource = findDropSource(otherNodes, edges, finalPos)
                  const newSourceHandle = newSource ? chooseSourceHandle(newSource, finalPos.x) : null

                  // No valid target, or target is the same node, or target can't have outgoing edges → snap back
                  const inEdges = edges.filter((e) => e.target === change.id)
                  const currentSourceId = inEdges.length === 1 ? inEdges[0].source : null

                  if (!newSource || !newSourceHandle || newSource.id === currentSourceId) {
                    setNodes((ns) => layoutWorkflow(ns, edges))
                    continue
                  }

                  // The edge that newSource currently uses to connect to its successor
                  const newSourceOutEdge = edges.find(
                    (e) => e.source === newSource.id && e.sourceHandle === newSourceHandle
                  )
                  // newSource already connects to this node — nothing to do
                  if (newSourceOutEdge?.target === change.id) {
                    setNodes((ns) => layoutWorkflow(ns, edges))
                    continue
                  }

                  // N's primary output edge (non-filter/branch nodes have a single 'output' handle)
                  const primaryOut = edges.find(
                    (e) => e.source === change.id && e.sourceHandle === 'output'
                  )

                  // Remove: N's in-edges, N's primary out-edge, newSource's out-edge
                  const toRemove = new Set([
                    ...inEdges.map((e) => e.id),
                    ...(primaryOut ? [primaryOut.id] : []),
                    ...(newSourceOutEdge ? [newSourceOutEdge.id] : []),
                  ])
                  let newEdges = edges.filter((e) => !toRemove.has(e.id))

                  // Bridge the gap: connect N's old predecessor → N's old successor
                  if (inEdges.length === 1 && primaryOut) {
                    newEdges.push({
                      id: uid(),
                      source: inEdges[0].source,
                      target: primaryOut.target,
                      sourceHandle: inEdges[0].sourceHandle ?? 'output',
                    })
                  }

                  // Insert N at new position: newSource → N
                  newEdges.push({ id: uid(), source: newSource.id, target: change.id, sourceHandle: newSourceHandle })

                  // N → newSource's old successor (if any)
                  if (newSourceOutEdge) {
                    newEdges.push({ id: uid(), source: change.id, target: newSourceOutEdge.target, sourceHandle: 'output' })
                  }

                  setEdges(newEdges)
                  setNodes((ns) => layoutWorkflow(ns, newEdges))
                  setIsDirty(true)
                }
              }
            }}
            onEdgesChange={(changes) => {
              onEdgesChange(changes)
              if (changes.some((c) => c.type === 'remove')) {
                setIsDirty(true)
                const removedIds = new Set(
                  changes.filter((c) => c.type === 'remove').map((c) => c.id)
                )
                const remaining = edges.filter((e) => !removedIds.has(e.id))
                setNodes((ns) => layoutWorkflow(ns, remaining))
              }
            }}
            onConnect={onConnect}
            onConnectStart={mode === 'edit' ? onConnectStart : undefined}
            onConnectEnd={mode === 'edit' ? onConnectEnd : undefined}
            onReconnect={mode === 'edit' ? onReconnect : undefined}
            onReconnectStart={mode === 'edit' ? (_, edge, handleType) => {
              console.log('[canvas] onReconnectStart', { edgeId: edge.id, handleType })
              reconnectingEdgeIdRef.current = edge.id
            } : undefined}
            onReconnectEnd={mode === 'edit' ? (_, edge, handleType, state) => {
              console.log('[canvas] onReconnectEnd', { edgeId: edge.id, handleType, isValid: state?.isValid, toHandle: state?.toHandle })
              reconnectingEdgeIdRef.current = null
            } : undefined}
            reconnectRadius={24}
            connectionRadius={60}
            onEdgeMouseEnter={mode === 'edit' ? (_, edge) => { cancelEdgeHoverHide(); setHoveredEdgeId(edge.id) } : undefined}
            onEdgeMouseLeave={mode === 'edit' ? () => scheduleEdgeHoverHide() : undefined}
            isValidConnection={isValidConnection}
            onNodeClick={(e, node) => {
              // Shift / Cmd click → add to multi-selection (handled by React Flow);
              // don't clobber selectedNodeId, which drives the ConfigPanel.
              if (e.shiftKey || e.metaKey || e.ctrlKey) {
                setContextMenu(null)
                return
              }
              setSelectedNodeId(node.id)
              setContextMenu(null)
            }}
            onPaneClick={() => { setSelectedNodeId(null); setContextMenu(null); setEdgeContextMenu(null) }}
            onNodeContextMenu={mode === 'edit' ? (e, node) => {
              if (node.id === 'trigger') return
              e.preventDefault()
              setEdgeContextMenu(null)
              setContextMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
            } : undefined}
            onEdgeContextMenu={mode === 'edit' ? (e, edge) => {
              e.preventDefault()
              setContextMenu(null)
              setEdgeContextMenu({ edgeId: edge.id, x: e.clientX, y: e.clientY })
            } : undefined}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            // Default to a late-bend smoothstep so multi-output handles
            // keep their wire in the handle's column most of the way down,
            // bending horizontally only near the target. Avoids diagonals
            // (bezier) AND avoids early mid-Y bends that cross sibling wires
            // (default smoothstep). Aligned source/target collapses to a
            // plain vertical line.
            defaultEdgeOptions={{ type: 'lateBend' }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={mode === 'edit'}
            nodesConnectable={mode === 'edit'}
            deleteKeyCode={mode === 'edit' ? 'Backspace' : null}
            // Route keyboard deletes through the curated handler (snapshot/undo,
            // pair expansion, container-contents confirm) instead of RF's raw
            // remove path. Edge-only deletes fall through to RF.
            onBeforeDelete={async ({ nodes: toDelete }) => onBeforeNodeDelete(toDelete, handleNodesDelete)}
            snapToGrid={false}
            fitView
            fitViewOptions={{ padding: 0.4, maxZoom: 0.5 }}
            minZoom={0.05}
            maxZoom={1.5}
            zoomOnDoubleClick={false}
            multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
            selectionKeyCode="Shift"
            selectNodesOnDrag={false}
          >
            <Background variant={BackgroundVariant.Dots} color="#cbd5e1" gap={20} size={1.5} style={{ backgroundColor: '#f8fafc' }} />
            <Controls />
            {mode === 'edit' && nodes.length === 1 && !showTest && (
              <Panel position="bottom-center" className="mb-8 pointer-events-none">
                <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-gray-200 bg-white/90 px-8 py-5 text-center shadow-sm backdrop-blur-[2px]">
                  <p className="text-sm font-medium text-gray-500">Drag a step from the left to start building</p>
                  <p className="text-xs text-gray-400">Filter · Branch · Webhook · Code · Transform</p>
                </div>
              </Panel>
            )}
            <MiniMap
              nodeColor={(n) => {
                const data = n.data as unknown as CanvasNodeData | undefined
                if (data?.isReachable === false) return '#d1d5db' // gray-300
                const colorMap: Record<string, string> = {
                  trigger:        '#439FE1', // indigo
                  filter:         '#3b82f6', // blue
                  branch:         '#a855f7', // purple
                  code:           '#f59e0b', // amber
                  response:       '#10b981', // green
                  exit:           '#ef4444', // red
                  transform:      '#f97316', // orange
                  webhook:        '#14b8a6', // teal
                  bid_evaluation: '#f43f5e', // rose
                  partner_bid:    '#0ea5e9', // sky
                  parallel:       '#64748b', // slate
                  parallel_end:   '#64748b', // slate
                  salesforce:     '#3b82f6', // blue
                }
                return colorMap[n.type ?? ''] ?? '#9ca3af'
              }}
              maskColor="rgba(243,244,246,0.7)"
            />
          </ReactFlow>
          </div>

          {contextMenu && (() => {
            const cmInEdges = edges.filter((e) => e.target === contextMenu.nodeId)
            const cmOutEdges = edges.filter((e) => e.source === contextMenu.nodeId && e.sourceHandle === 'output')
            const hasInEdges = cmInEdges.length > 0
            const isInChain = hasInEdges || cmOutEdges.length > 0
            const selectedIds = nodes
              .filter((n) => n.selected && n.id !== 'trigger')
              .map((n) => n.id)
            const isMultiTarget = selectedIds.length > 1 && selectedIds.includes(contextMenu.nodeId)
            const deleteIds = isMultiTarget ? selectedIds : [contextMenu.nodeId]
            const deleteLabel = isMultiTarget ? `Delete ${selectedIds.length} nodes` : 'Delete'
            const duplicateIds = isMultiTarget ? selectedIds : [contextMenu.nodeId]
            const duplicateLabel = isMultiTarget ? `Duplicate ${selectedIds.length} nodes` : 'Duplicate'
            return (
              <div
                className="fixed z-50 min-w-[200px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
                style={{ left: contextMenu.x, top: contextMenu.y }}
                onContextMenu={(e) => e.preventDefault()}
              >
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-beige"
                  onClick={() => { duplicateNodes(duplicateIds); setContextMenu(null) }}
                  title={isMultiTarget ? 'Clone the selected nodes and the edges between them' : 'Clone this node'}
                >
                  <CopyPlus className="h-3.5 w-3.5 text-gray-400" />
                  {duplicateLabel}
                </button>
                {!isMultiTarget && hasInEdges && (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-beige"
                    onClick={() => { disconnectNode(contextMenu.nodeId); setContextMenu(null) }}
                    title="Detach this node and its downstream subgraph from the main flow"
                  >
                    <X className="h-3.5 w-3.5 text-gray-400" />
                    Disconnect
                  </button>
                )}
                {!isMultiTarget && isInChain && (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-beige"
                    onClick={() => { removeFromChain(contextMenu.nodeId); setContextMenu(null) }}
                    title="Splice this single node out; the chain reconnects around it"
                  >
                    <X className="h-3.5 w-3.5 text-gray-400" />
                    Remove from chain
                  </button>
                )}
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50"
                  onClick={() => { handleNodesDelete(deleteIds); setContextMenu(null) }}
                  title={isMultiTarget ? 'Remove the selected nodes from the canvas' : 'Remove this node from the canvas'}
                >
                  <Trash2 className="h-3.5 w-3.5 text-red-500" />
                  {deleteLabel}
                </button>
              </div>
            )
          })()}

          {edgeContextMenu && (
            <div
              className="fixed z-50 min-w-[160px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
              style={{ left: edgeContextMenu.x, top: edgeContextMenu.y }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-beige"
                onClick={() => deleteEdge(edgeContextMenu.edgeId)}
              >
                <X className="h-3.5 w-3.5 text-gray-400" />
                Disconnect
              </button>
            </div>
          )}

          {mode === 'edit' && hoveredEdgeId && (
            <EdgeRemoveButton
              edgeId={hoveredEdgeId}
              viewport={viewport}
              onMouseEnter={cancelEdgeHoverHide}
              onMouseLeave={scheduleEdgeHoverHide}
              onClick={() => { cancelEdgeHoverHide(); deleteEdge(hoveredEdgeId); setHoveredEdgeId(null) }}
            />
          )}
          </div>
        </div>

        {/* nokey: React Flow's window-level key handlers (Space = pan,
            Backspace = delete node) skip targets inside a .nokey element.
            Monaco 0.55+ types via an EditContext div that isn't a
            textarea/contenteditable, so without this the canvas eats
            Space and Backspace while editing code in the panel. */}
        <div ref={sidePanelRef} className="nokey contents">
          {/* TestRunPanel stays mounted while the test tool is open so its
              local state (steps, result banner, running status) survives
              when the user clicks into a node and back to the trigger. */}
          {mode === 'edit' && showTest && (
            <div
              style={{
                display: !selectedNode || selectedNode.id === 'trigger' ? 'contents' : 'none',
              }}
            >
              <TestRunPanel
                workflowId={workflow.id}
                currentDefinition={flowToDef(nodes, edges, triggerRef.current)}
                onClose={() => { setShowTest(false); setTestInitialPayload(undefined) }}
                onComplete={() => setRefreshSignal((s) => s + 1)}
                initialPayload={testInitialPayload}
                savedPayloads={savedPayloads}
                onSavedPayloadsChange={setSavedPayloads}
                onTestStart={handleTestStart}
                onLiveStep={handleLiveStep}
                onTestEnd={handleTestEnd}
                onTestStepsLoaded={handleTestStepsLoaded}
                width={sidePanelWidth}
                onResize={setSidePanelWidth}
              />
            </div>
          )}
          {selectedNode && mode === 'edit' && selectedNode.id === 'trigger' && !showTest && (
            <TriggerConfigPanel
              workflowId={workflow.id}
              workflowName={workflow.name}
              trigger={triggerRef.current}
              nodeNamespaces={orderedNamespaces}
              onChange={(t) => { triggerRef.current = t; setIsDirty(true); setTriggerVersion(v => v + 1) }}
              onClose={() => setSelectedNodeId(null)}
              width={sidePanelWidth}
              onResize={setSidePanelWidth}
              slackChannel={slackChannel}
              onSlackChannelChange={(value) => { setSlackChannel(value); setIsDirty(true) }}
            />
          )}
          {selectedNode && mode === 'edit' && selectedNode.id !== 'trigger' && (
            <ConfigPanel
              node={selectedNode}
              onUpdate={handleNodeUpdate}
              onDelete={handleNodeDelete}
              onClose={() => setSelectedNodeId(null)}
              onDuplicate={handleNodeDuplicate}
              nodeNamespaces={nodeNamespaces}
              nodeOptions={nodeOptions}
              refs={refs}
              namespaceReferenced={selectedNamespaceReferenced}
              edges={edges}
              onEdgesChange={handleParallelEdgesChange}
              canRerun={!!lastTestExecId}
              onRerun={handleNodeRerun}
              onNodeTest={handleNodeTest}
              canBuildFromRun={!!(lastTestExecId || executionId)}
              defaultTestPayload={(workflow as { test_payloads?: Array<{ name: string; payload: unknown }> }).test_payloads?.[0]?.payload}
              width={sidePanelWidth}
              onResize={setSidePanelWidth}
              workflowId={workflow.id}
              onRenameRequest={handleRenameRequest}
            />
          )}
        </div>
        {selectedNode && mode === 'view' && executionId && selectedNode.id === 'trigger' && (
          <TriggerExecutionPanel
            workflowId={workflow.id}
            payload={executionPayload}
            source={executionSource}
            traceId={executionTraceId}
            startedAt={executionStartedAt}
            onClose={() => setSelectedNodeId(null)}
            width={sidePanelWidth}
            onResize={setSidePanelWidth}
          />
        )}
        {selectedNode && mode === 'view' && executionId && selectedNode.id !== 'trigger' && (
          <ConfigPanel
            readOnly
            node={selectedNode}
            onClose={() => setSelectedNodeId(null)}
            nodeNamespaces={nodeNamespaces}
            nodeOptions={nodeOptions}
            refs={refs}
            edges={edges}
            width={sidePanelWidth}
            onResize={setSidePanelWidth}
            onRetryFromFailure={async () => {
              const { executionId: newId } = await api.executions.resume(executionId)
              setRefreshSignal((s) => s + 1)
              if (newId) selectExecution(newId)
            }}
          />
        )}
        {selectedNode && mode === 'view' && !executionId && selectedNode.id === 'trigger' && (
          <TriggerConfigPanel
            readOnly
            workflowId={workflow.id}
            workflowName={workflow.name}
            trigger={triggerRef.current}
            nodeNamespaces={nodeNamespaces.filter((n): n is string => typeof n === 'string' && n.length > 0 && n !== 'trigger')}
            onChange={() => {}}
            onClose={() => setSelectedNodeId(null)}
            width={sidePanelWidth}
            onResize={setSidePanelWidth}
            slackChannel={slackChannel}
          />
        )}
        {selectedNode && mode === 'view' && !executionId && selectedNode.id !== 'trigger' && (
          <ConfigPanel
            readOnly
            node={selectedNode}
            onClose={() => setSelectedNodeId(null)}
            nodeNamespaces={nodeNamespaces}
            nodeOptions={nodeOptions}
            refs={refs}
            edges={edges}
            width={sidePanelWidth}
            onResize={setSidePanelWidth}
          />
        )}
        {showVersions && (
          <VersionHistoryPanel
            workflowId={workflow.id}
            onClose={() => setShowVersions(false)}
            onRestore={handleVersionRestore}
            width={sidePanelWidth}
            onResize={setSidePanelWidth}
          />
        )}
      </div>

      {renamePrompt && (
        <RenameConfirmDialog
          oldNs={renamePrompt.oldNs}
          newNs={renamePrompt.newNs}
          canvasReferenceCount={renamePrompt.canvasReferenceCount}
          partnerFormulas={renamePrompt.partnerFormulas}
          onConfirm={() => renamePrompt.resolve(true)}
          onCancel={() => renamePrompt.resolve(false)}
        />
      )}

      {pendingContainerDelete && (() => {
        const { outerIds, innerIds, containerLabel } = pendingContainerDelete
        const innerCount = innerIds.length
        const cancel = () => setPendingContainerDelete(null)
        const leave = () => { executeNodesDelete(outerIds); setPendingContainerDelete(null) }
        const includeInner = () => { executeNodesDelete([...outerIds, ...innerIds]); setPendingContainerDelete(null) }
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={cancel}>
            <div
              className="w-[440px] rounded-xl bg-white p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="font-semibold text-graphite">
                Delete {containerLabel}?
              </p>
              <p className="mt-1 text-sm text-gray-600">
                {innerCount} {innerCount === 1 ? 'node' : 'nodes'} sit inside this container. Should they be deleted with it, or left disconnected on the canvas?
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  className="rounded-lg px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
                  onClick={cancel}
                >
                  Cancel
                </button>
                <button
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-beige"
                  onClick={leave}
                >
                  Leave them
                </button>
                <button
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
                  onClick={includeInner}
                >
                  Delete inside too
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// Hover-reveal button that sits on the rendered SVG path of an edge. We
// query the actual <path> React Flow rendered for `edgeId` and use
// `getPointAtLength(totalLength / 2)` so the X lands on the curve no matter
// how curved (default bezier with handle offsets, smoothstep, the custom
// converge edge, etc.). Computing a position from source/target points
// alone misses the curve when the wire bows out — even React Flow's own
// `labelX/Y` from `getBezierPath` is just the bbox midpoint, which drifts
// wide on strongly-curved edges.
function EdgeRemoveButton({
  edgeId,
  viewport,
  onMouseEnter,
  onMouseLeave,
  onClick,
}: {
  edgeId: string
  viewport: { x: number; y: number; zoom: number }
  onMouseEnter: () => void
  onMouseLeave: () => void
  onClick: () => void
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    let raf = 0
    const measure = () => {
      const pathEl = document.querySelector(
        `.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`
      ) as SVGPathElement | null
      if (!pathEl) {
        // Edge SVG might not be in the DOM yet on the first paint after hover.
        // Try again next frame; bail after we get a result.
        raf = requestAnimationFrame(measure)
        return
      }
      const len = pathEl.getTotalLength()
      const pt = pathEl.getPointAtLength(len / 2)
      setPos({ x: pt.x, y: pt.y })
    }
    measure()
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [edgeId, viewport.x, viewport.y, viewport.zoom])

  if (!pos) return null
  const left = pos.x * viewport.zoom + viewport.x
  const top = pos.y * viewport.zoom + viewport.y
  return (
    <button
      type="button"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      style={{ left, top, transform: 'translate(-50%, -50%)' }}
      className="absolute z-10 flex h-5 w-5 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-500 shadow-sm hover:border-red-400 hover:bg-red-50 hover:text-red-600"
      title="Disconnect"
    >
      <X className="h-3 w-3" />
    </button>
  )
}

// ── Public export: wraps with ReactFlowProvider ───────────────────────────────

export default function WorkflowCanvas({
  workflow,
  mode,
  onModeChange,
  executionId,
  executionSteps,
  executionPayload,
  executionSource,
  executionTraceId,
  executionStartedAt,
  executionParentId,
  executionChildren,
  onLoadStepDetail,
  onClearExecution,
  onSelectExecution,
  focusNodeId,
}: {
  workflow: Workflow
  mode: 'edit' | 'view'
  onModeChange?: (mode: 'edit' | 'view') => void
  executionId?: string
  executionSteps?: Record<string, ExecutionStep>
  executionPayload?: unknown
  executionSource?: string | null
  executionTraceId?: string | null
  executionStartedAt?: string | null
  executionParentId?: string | null
  executionChildren?: Array<{ id: string; started_at: string; status: string }>
  onLoadStepDetail?: (namespace: string) => void
  onClearExecution?: () => void
  onSelectExecution?: (execId: string) => void
  /** Node to select and center on load (e.g. from a config-warning deep link `?node=`). */
  focusNodeId?: string
}) {
  return (
    <ReactFlowProvider>
      <TimeoutSuggestionsProvider workflowId={workflow.id}>
      <CanvasInner
        workflow={workflow}
        mode={mode}
        onModeChange={onModeChange}
        executionId={executionId}
        executionSteps={executionSteps}
        executionPayload={executionPayload}
        executionSource={executionSource}
        executionTraceId={executionTraceId}
        executionStartedAt={executionStartedAt}
        executionParentId={executionParentId}
        executionChildren={executionChildren}
        onLoadStepDetail={onLoadStepDetail}
        onClearExecution={onClearExecution}
        onSelectExecution={onSelectExecution}
        focusNodeId={focusNodeId}
      />
      </TimeoutSuggestionsProvider>
    </ReactFlowProvider>
  )
}
