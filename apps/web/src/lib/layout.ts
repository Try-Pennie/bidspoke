import dagre from '@dagrejs/dagre'
import type { Node, Edge } from '@xyflow/react'

// All canvas nodes share this width (w-52 = 208px)
export const NODE_W = 208

// Per-type heights — must match the MAX rendered height for that type so
// dagre's layout reserves enough room and produces visually-uniform gaps.
// When actual rendered height exceeds the declared value, adjacent nodes
// appear to have uneven spacing (because dagre lays out as if the node were
// shorter, then the DOM pushes past the reserved slot into the next rank).
// Nodes within a rank are centered vertically, so a height delta between
// siblings shows up as a top-edge offset. Use a single declared height for
// every standard "header + body" node type so siblings (e.g., a code node
// next to a webhook in a parallel slot) align at the top. Nodes with extra
// rows (branch labels, parallel slots, salesforce update tag) stay larger.
const STANDARD_NODE_H = 144
const NODE_H: Record<string, number> = {
  trigger:       STANDARD_NODE_H,
  filter:        STANDARD_NODE_H,
  branch:        164,             // adds the branch labels row
  code:          STANDARD_NODE_H,
  response:      STANDARD_NODE_H,
  exit:          STANDARD_NODE_H,
  parallel:      156,             // adds the slot label row (when slots > 0)
  parallel_end:  STANDARD_NODE_H,
  branch_end:    STANDARD_NODE_H,
  salesforce:    164,             // adds the Update tag row
  webhook:       STANDARD_NODE_H,
  partner_bid:   STANDARD_NODE_H,
  transform:     STANDARD_NODE_H,
  bid_evaluation: STANDARD_NODE_H,
  bid_group:     STANDARD_NODE_H,
  constants:     STANDARD_NODE_H,
  default:       STANDARD_NODE_H,
}

export function nodeHeight(type: string | undefined) {
  return NODE_H[type ?? 'default'] ?? NODE_H.default
}

/**
 * The height we should use for layout. Prefers React Flow's measured DOM height
 * when available so dagre reserves exactly the rendered space — that keeps the
 * gap between adjacent ranks visually constant regardless of how tall a given
 * node ends up. Falls back to the declared NODE_H for the very first layout
 * pass, before nodes have been measured.
 */
function effectiveHeight(node: Node): number {
  const m = (node as { measured?: { height?: number } }).measured
  if (m?.height != null && m.height > 0) return m.height
  return nodeHeight(node.type)
}

/**
 * Branch nodes grow horizontally to fit all handle labels in the footer row.
 * Other types use the shared NODE_W. Keep this in sync with the rendered
 * width in BranchNode.tsx so dagre reserves the same horizontal slot.
 */
export function nodeWidth(type: string | undefined, data: unknown): number {
  // Layout writes a `_spanWidth` onto multi-output nodes whose children's
  // total span exceeds the label-based width. Honor it so the rendered DOM
  // matches dagre's reservation (and handles can be placed over their
  // children's actual columns).
  const spanW = (data as { _spanWidth?: number } | undefined)?._spanWidth
  if (typeof spanW === 'number' && spanW > 0) return spanW
  if (type === 'branch') {
    type BranchData = {
      config?: {
        branches?: { label: string }[]
        else_behavior?: 'output' | 'none' | 'error'
        use_else?: boolean
        else_label?: string
      }
    }
    const cfg = (data as BranchData | undefined)?.config
    const branches = cfg?.branches ?? []
    const elseBehavior = cfg?.else_behavior ?? (cfg?.use_else === false ? 'none' : 'output')
    const elseLabel = cfg?.else_label || 'else'
    const labels = [...branches.map((b) => b.label), ...(elseBehavior === 'output' ? [elseLabel] : [])]
    return widthForFooterLabels(labels)
  }
  if (type === 'parallel') {
    type ParallelData = { config?: { children?: Array<{ label: string }> | string[] } }
    const raw = (data as ParallelData | undefined)?.config?.children
    if (!Array.isArray(raw) || raw.length === 0) return NODE_W
    const labels = typeof raw[0] === 'string'
      ? (raw as string[]).map((_, i) => `child_${i + 1}`)
      : (raw as Array<{ label: string }>).map((s) => s.label || '')
    return widthForFooterLabels(labels)
  }
  return NODE_W
}

// Compute the rendered width needed to fit a row of footer labels (matches
// the branch / parallel slot row layout: text-xs, ↓ prefix, px-2 row padding,
// 16px between cells). Cap at a sensible max so labels truncate rather than
// grow the node forever.
const NODE_W_MAX = 360
function widthForFooterLabels(labels: string[]): number {
  if (labels.length === 0) return NODE_W
  const labelsPx = labels.reduce((sum, h) => sum + 12 + h.length * 6.5, 0)
  const totalPx = 16 + labelsPx + 16 * Math.max(0, labels.length - 1)
  return Math.min(NODE_W_MAX, Math.max(NODE_W, Math.ceil(totalPx)))
}

const NODE_GAP = 24 // minimum clear space between any two nodes
export const DISCONNECTED_GAP = 280 // horizontal gap between the main flow and a disconnected subgraph

/** Returns true if placing a node of `type` at `pos` would overlap any existing node (excluding `excludeId`). */
export function overlapsAny(
  pos: { x: number; y: number },
  type: string | undefined,
  nodes: Node[],
  excludeId?: string
): boolean {
  const w = NODE_W
  const h = nodeHeight(type)
  return nodes
    .filter((n) => n.id !== excludeId)
    .some((n) => {
      const nw = NODE_W
      const nh = nodeHeight(n.type)
      return (
        pos.x < n.position.x + nw + NODE_GAP &&
        pos.x + w + NODE_GAP > n.position.x &&
        pos.y < n.position.y + nh + NODE_GAP &&
        pos.y + h + NODE_GAP > n.position.y
      )
    })
}

/**
 * Returns a position near (preferX, preferY) that does not overlap any existing node.
 * Tries shifting right first, then falls back to below the whole graph.
 */
export function findFreePosition(
  preferX: number,
  preferY: number,
  type: string | undefined,
  nodes: Node[],
  excludeId?: string
): { x: number; y: number } {
  if (!overlapsAny({ x: preferX, y: preferY }, type, nodes, excludeId)) {
    return { x: preferX, y: preferY }
  }
  for (let i = 1; i <= 8; i++) {
    const x = preferX + i * (NODE_W + NODE_GAP)
    if (!overlapsAny({ x, y: preferY }, type, nodes, excludeId)) return { x, y: preferY }
  }
  // Fall back: place below the entire graph
  const bottomY =
    Math.max(0, ...nodes.filter((n) => n.id !== excludeId).map((n) => n.position.y + nodeHeight(n.type))) +
    NODE_GAP
  return { x: preferX, y: bottomY }
}

/**
 * Returns a sort index for a source handle so that siblings are ordered
 * left-to-right on the canvas to match the visual handle positions on the node.
 *
 * filter:         pass=0 (30% left), exit=1 (70% left)
 * bid_evaluation: winner=0, no_winner=1
 * branch:         branch labels in order + else last
 */
/**
 * Returns the configured handle ids on a multi-output node, in left-to-right
 * order. Returns null for nodes that don't have multi-output semantics (or
 * have only a single output, in which case the layout never branches).
 */
export function configuredHandleIds(node: Node): string[] | null {
  const type = node.type
  const config = (node.data as { config?: Record<string, unknown> } | undefined)?.config
  if (type === 'branch') {
    const branches = (config?.branches as { label: string }[] | undefined) ?? []
    const elseBehavior =
      (config?.else_behavior as 'output' | 'none' | 'error' | undefined) ??
      ((config?.use_else as boolean | undefined) === false ? 'none' : 'output')
    const ids = [
      ...branches.map((b) => b.label),
      ...(elseBehavior === 'output' ? ['else'] : []),
    ]
    return ids.length > 0 ? ids : null
  }
  if (type === 'filter') return ['pass', 'exit']
  if (type === 'bid_evaluation' || type === 'bid_group') return ['winner', 'no_winner']
  if (type === 'latency_gate') {
    const op = (config?.operation as string | undefined) ?? 'mark'
    return op === 'check' ? ['within', 'exceeded'] : null
  }
  if (type === 'parallel') {
    const raw = config?.children
    if (!Array.isArray(raw) || raw.length === 0) return null
    if (typeof raw[0] === 'string') {
      return (raw as string[]).map((_, i) => `child-${i}`)
    }
    return (raw as { id: string }[]).map((s) => s.id)
  }
  return null
}

function handleSortIndex(
  nodeType: string | undefined,
  handleId: string | null | undefined,
  nodeData: unknown
): number {
  if (!handleId) return 0
  if (nodeType === 'filter') {
    if (handleId === 'pass') return 0
    if (handleId === 'exit') return 1
  }
  if (nodeType === 'bid_evaluation') {
    if (handleId === 'winner') return 0
    if (handleId === 'no_winner') return 1
  }
  if (nodeType === 'latency_gate') {
    if (handleId === 'within') return 0
    if (handleId === 'exceeded') return 1
  }
  if (nodeType === 'branch') {
    type BranchData = { config?: { branches?: { label: string }[] } }
    const cfg = (nodeData as BranchData | undefined)?.config
    const branches = cfg?.branches ?? []
    const handles = [...branches.map((b) => b.label), 'else']
    const idx = handles.indexOf(handleId)
    return idx >= 0 ? idx : 999
  }
  if (nodeType === 'parallel') {
    // child-0, child-1, ... → sort left-to-right by index
    const m = /^child-(\d+)$/.exec(handleId)
    return m ? parseInt(m[1]) : 999
  }
  return 0
}

/**
 * Auto-layout a React Flow graph top-to-bottom using dagre.
 * Returns a new nodes array with updated positions; edges are unchanged.
 *
 * For multi-output nodes (filter, branch, bid_evaluation) the children are
 * guaranteed to be ordered left-to-right to match the handle positions on
 * the node, so edges never cross.
 */
export function layoutWorkflow(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes

  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', ranksep: 48, nodesep: 96, marginx: 60, marginy: 60 })

  // Build a quick lookup so we can resolve node type/data for each edge source
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  // Effective width per node — for branch/parallel/etc. with asymmetric child
  // chain widths, the node should render wide enough to put each handle
  // directly above its child's column. Otherwise, the wire from a handle to
  // a far-offset child cuts diagonally and clips the sibling chain's region.
  // Horizontal gap between sibling subtrees of a multi-output node. Bumped
  // from 48 → 96 on 2026-05-05 because adjacent branch clusters' region
  // backdrops were touching when one subtree was wide and the next was
  // also wide (nested branches in adjacent slots). 96 gives a visible gap
  // even after the region backdrops extend their own padding.
  const NODESEP_PRE = 96
  // Compute the set of nodes where a multi-output's chain rejoins (convergence
  // points reachable from every handle, plus the paired branch_end/parallel_end
  // via the backbone). Width recursion stops at these so the multi-output's
  // effective width reflects only its own internal territory and not anything
  // downstream of where the chains converge.
  const stopAtForMultiOutput = (n: Node, handles: string[]): Set<string> => {
    const stops = new Set<string>()
    const perHandle = handles
      .map((h) => {
        const slotEdge = edges.find((e) => e.source === n.id && e.sourceHandle === h)
        if (!slotEdge) return new Set<string>()
        const set = new Set<string>([slotEdge.target])
        const q = [slotEdge.target]
        while (q.length > 0) {
          const cur = q.shift() as string
          for (const e of edges) {
            if (e.source === cur && !set.has(e.target)) {
              set.add(e.target)
              q.push(e.target)
            }
          }
        }
        return set
      })
      .filter((s) => s.size > 0)
    if (perHandle.length >= 2) {
      for (const id of perHandle[0]) {
        if (perHandle.every((s) => s.has(id))) stops.add(id)
      }
    }
    if (n.type === 'branch' || n.type === 'parallel') {
      const endType = n.type === 'branch' ? 'branch_end' : 'parallel_end'
      const backbone = edges.find((e) => {
        if (e.source !== n.id) return false
        const target = nodeMap.get(e.target)
        return target?.type === endType
      })
      if (backbone) stops.add(backbone.target)
    }
    return stops
  }
  // Node types that render their card wide enough to span their arms' subtrees
  // (handles placed above each child column). `filter` is intentionally NOT here:
  // it's a 2-way gate, not a fan-out splitter, so it stays a fixed-width card and
  // its pass/exit wires just bend to their targets — otherwise a filter whose arm
  // points at a wide subtree (e.g. a bid_group) balloons across the canvas.
  const FANOUT_TYPES = new Set(['branch', 'parallel', 'bid_group', 'bid_evaluation', 'latency_gate'])

  // Cross-path edges: a node can be deliberately wired from a second, deeper
  // path (e.g. a filter on one branch routing into a bid_group on another).
  // That edge must be DRAWN but must NOT drive dagre's ranking OR the width-
  // reservation math — otherwise the shared target is forced to a deep rank and
  // the branch that owns the forking arm balloons to "reserve" a subtree that
  // actually lives elsewhere, scattering its arms. For each multi-parent node
  // we keep its shallowest incoming edge as the ranking ("primary") edge and
  // treat any strictly-deeper parent as a cross-link. branch_end / parallel_end
  // joins keep their own multi-parent handling and are never cross-links.
  const incomingByTarget = new Map<string, typeof edges>()
  for (const e of edges) {
    const arr = incomingByTarget.get(e.target) ?? []
    arr.push(e)
    incomingByTarget.set(e.target, arr)
  }
  const nodeDepth = new Map<string, number>()
  {
    const roots = nodes.filter((n) => !incomingByTarget.has(n.id)).map((n) => n.id)
    const queue = roots.length > 0 ? [...roots] : nodes[0] ? [nodes[0].id] : []
    for (const r of queue) nodeDepth.set(r, 0)
    while (queue.length > 0) {
      const cur = queue.shift() as string
      const d = nodeDepth.get(cur) ?? 0
      for (const e of edges) {
        if (e.source !== cur || nodeDepth.has(e.target)) continue
        nodeDepth.set(e.target, d + 1)
        queue.push(e.target)
      }
    }
  }
  const crossEdgeIds = new Set<string>()
  const isFilter = (id: string) => nodeMap.get(id)?.type === 'filter'
  for (const [targetId, ins] of incomingByTarget) {
    if (ins.length < 2) continue
    const tgt = nodeMap.get(targetId)
    if (tgt?.type === 'branch_end' || tgt?.type === 'parallel_end') continue
    // A filter must never influence the shape: its fork edge is always a cross-
    // link (drawn, not ranked), and a non-filter parent is preferred as primary
    // so the forked node sits under its real upstream, not the filter.
    const pool = ins.some((e) => !isFilter(e.source)) ? ins.filter((e) => !isFilter(e.source)) : ins
    let primary = pool[0]
    let primaryDepth = nodeDepth.get(pool[0].source) ?? Infinity
    for (const e of pool) {
      const d = nodeDepth.get(e.source) ?? Infinity
      if (d < primaryDepth) { primaryDepth = d; primary = e }
    }
    for (const e of ins) {
      if (e === primary) continue
      // De-rank a genuine cross-link: any filter fork, or a non-filter parent
      // strictly deeper than the primary. Same-depth non-filter diamonds stay.
      if (isFilter(e.source) || (nodeDepth.get(e.source) ?? Infinity) > primaryDepth) crossEdgeIds.add(e.id)
    }
  }

  const effectiveSubtreeWidthPre = (startId: string, visited: Set<string>, outerStopAt?: Set<string>): number => {
    if (visited.has(startId)) return 0
    if (outerStopAt && outerStopAt.has(startId)) return 0
    visited.add(startId)
    const n = nodeMap.get(startId)
    if (!n) return NODE_W
    const ownWidth = nodeWidth(n.type, n.data)
    const handles = configuredHandleIds(n)
    if (handles && handles.length >= 2 && FANOUT_TYPES.has(n.type ?? '')) {
      // Add this multi-output's own convergence + paired end to the stopAt
      // before walking its slot chains, so each slot's width reflects its
      // exclusive territory (not any rejoin or post-cluster downstream).
      const innerStops = stopAtForMultiOutput(n, handles)
      const merged = outerStopAt ? new Set([...outerStopAt, ...innerStops]) : innerStops
      const slotWidths = handles.map((h) => {
        const slotEdge = edges.find((e) => e.source === startId && e.sourceHandle === h && !crossEdgeIds.has(e.id))
        if (!slotEdge) return NODE_W
        return Math.max(NODE_W, effectiveSubtreeWidthPre(slotEdge.target, new Set(visited), merged))
      })
      const fanOutWidth = slotWidths.reduce((s, w) => s + w, 0) + NODESEP_PRE * (slotWidths.length - 1)
      // When this branch/parallel is itself nested inside an outer slot, the
      // chain that exits via its end node and continues toward the outer
      // stopAt still has to fit inside the outer slot's allocated column.
      // Walking past the pair_end (constrained by outerStopAt) catches a wide
      // downstream node — e.g. a bid_group sitting between a nested branch's
      // end and its parent branch's end — which would otherwise be invisible
      // to width math and visually overflow into a sibling slot's column.
      //
      // Only meaningful when we have an `outerStopAt`. At the top-level call
      // (no outer slot to fit into), pastEnd has no boundary and would walk
      // the entire downstream workflow, inflating the node's own width.
      let pastEndWidth = 0
      if (outerStopAt && (n.type === 'branch' || n.type === 'parallel')) {
        const endType = n.type === 'branch' ? 'branch_end' : 'parallel_end'
        const pairEnd = edges.find((e) => e.source === n.id && nodeMap.get(e.target)?.type === endType)?.target
        if (pairEnd && !outerStopAt.has(pairEnd)) {
          for (const e of edges) {
            if (e.source !== pairEnd || crossEdgeIds.has(e.id)) continue
            const sub = effectiveSubtreeWidthPre(e.target, new Set(visited), outerStopAt)
            if (sub > pastEndWidth) pastEndWidth = sub
          }
        }
      }
      return Math.max(ownWidth, fanOutWidth, pastEndWidth)
    }
    let maxBelow = 0
    for (const e of edges) {
      if (e.source !== startId || crossEdgeIds.has(e.id)) continue
      const sub = effectiveSubtreeWidthPre(e.target, new Set(visited), outerStopAt)
      if (sub > maxBelow) maxBelow = sub
    }
    return Math.max(ownWidth, maxBelow)
  }
  const effectiveWidthByNode = new Map<string, number>()
  const handleOffsetsByNode = new Map<string, number[]>()
  // Every multi-output node type renders its card wide enough to span its
  // children's columns and reads `_handleOffsets` to place handles directly
  // above each child. This is what keeps wires straight and prevents wide
  // sibling subtrees from horizontally overlapping each other.
  //
  // The card-render side of each of these types MUST read `_spanWidth` and
  // `_handleOffsets` from `data`. See `BranchNode.tsx`, `ParallelNode.tsx`,
  // `BranchEndNode.tsx`, `BidGroupNode.tsx`, `BidEvaluationNode.tsx`. New node
  // types that opt in here must do the same. (`filter` is excluded — see
  // FANOUT_TYPES above; it renders fixed-width with handles at 30%/70%.)
  for (const n of nodes) {
    if (!FANOUT_TYPES.has(n.type ?? '')) continue
    const handles = configuredHandleIds(n)
    if (!handles || handles.length < 2) continue
    const stopAt = stopAtForMultiOutput(n, handles)
    const slotWidths = handles.map((h) => {
      const slotEdge = edges.find((e) => e.source === n.id && e.sourceHandle === h)
      if (!slotEdge) return NODE_W
      return Math.max(NODE_W, effectiveSubtreeWidthPre(slotEdge.target, new Set([n.id]), stopAt))
    })
    const totalSpan = slotWidths.reduce((s, w) => s + w, 0) + NODESEP_PRE * (slotWidths.length - 1)
    const labelW = nodeWidth(n.type, n.data)
    const effW = Math.max(labelW, totalSpan)
    effectiveWidthByNode.set(n.id, effW)
    // Per-handle offset from the node's center, used for child placement and
    // for rendering each handle above its child's column.
    let cursor = -totalSpan / 2
    const offsets = slotWidths.map((w) => {
      const center = cursor + w / 2
      cursor += w + NODESEP_PRE
      return center
    })
    handleOffsetsByNode.set(n.id, offsets)
  }
  // Parallel_end / branch_end inherit their paired start node's effective
  // width so the join visually closes the cluster instead of staying NODE_W
  // under a wider start.
  // Helper: a branch_end is "effectively connected" if a chain wires into it
  // OR every chain leaving the paired branch terminates in an exit / response
  // (workflow-ending). Mirrors `effectivelyConnected` in BranchEndNode.
  const branchEndIsEffectivelyConnected = (endId: string, branchId: string): boolean => {
    if (edges.some((e) => e.target === endId && e.source !== branchId)) return true
    const branch = nodeMap.get(branchId)
    const handleCount = branch ? (configuredHandleIds(branch)?.length ?? 0) : 0
    const wiredHandles = new Set<string>()
    const seedTargets: string[] = []
    for (const e of edges) {
      if (e.source !== branchId) continue
      if (!e.sourceHandle || e.sourceHandle === 'output') continue
      wiredHandles.add(e.sourceHandle)
      seedTargets.push(e.target)
    }
    if (seedTargets.length === 0) return false
    // An empty/unwired handle means not all chains converge — keep it a pill.
    if (wiredHandles.size < handleCount) return false
    const visited = new Set<string>()
    const queue = [...seedTargets]
    const leaves: string[] = []
    while (queue.length > 0) {
      const cur = queue.shift() as string
      if (visited.has(cur)) continue
      visited.add(cur)
      const outs = edges.filter((e) => e.source === cur && e.target !== endId)
      if (outs.length === 0) leaves.push(cur)
      else for (const o of outs) queue.push(o.target)
    }
    if (leaves.length === 0) return false
    for (const lid of leaves) {
      const leaf = nodeMap.get(lid)
      if (!leaf) return false
      if (leaf.type === 'exit') continue
      if (leaf.type === 'response') {
        const cfg = (leaf.data as { config?: { continue_after_response?: boolean } } | undefined)?.config
        if (!cfg?.continue_after_response) continue
      }
      return false
    }
    return true
  }

  for (const n of nodes) {
    if (n.type !== 'parallel_end' && n.type !== 'branch_end') continue
    const startType = n.type === 'parallel_end' ? 'parallel' : 'branch'
    const pairEdge = edges.find((e) => {
      if (e.target !== n.id) return false
      const src = nodeMap.get(e.source)
      return src?.type === startType
    })
    if (!pairEdge) continue
    if (n.type === 'branch_end') {
      if (!branchEndIsEffectivelyConnected(n.id, pairEdge.source)) continue
    }
    const startW = effectiveWidthByNode.get(pairEdge.source)
    if (startW) effectiveWidthByNode.set(n.id, startW)
  }

  const widthFor = (n: Node) => effectiveWidthByNode.get(n.id) ?? nodeWidth(n.type, n.data)

  // Per-branch convergence nodes — those reachable from every branch handle.
  // After dagre runs we'll pick the highest-up one (smallest Y) and align it
  // to the branch's own X so the post-branch flow continues straight down.
  const convergenceCandidatesByBranch = new Map<string, Set<string>>()
  for (const n of nodes) {
    if (n.type !== 'branch') continue
    const handles = configuredHandleIds(n)
    if (!handles || handles.length < 2) continue
    const perHandle = handles.map((h) => {
      const slotEdge = edges.find((e) => e.source === n.id && e.sourceHandle === h)
      if (!slotEdge) return new Set<string>()
      const s = new Set<string>([slotEdge.target])
      const q = [slotEdge.target]
      while (q.length > 0) {
        const cur = q.shift() as string
        for (const e of edges) {
          if (e.source !== cur || s.has(e.target)) continue
          s.add(e.target)
          q.push(e.target)
        }
      }
      return s
    }).filter((s) => s.size > 0)
    if (perHandle.length < 2) continue
    const candidates = new Set<string>()
    for (const id of perHandle[0]) {
      if (perHandle.every((s) => s.has(id))) candidates.add(id)
    }
    if (candidates.size > 0) convergenceCandidatesByBranch.set(n.id, candidates)
  }

  for (const node of nodes) {
    g.setNode(node.id, { width: widthFor(node), height: effectiveHeight(node) })
  }

  // Sort edges from the same source by handle position before feeding dagre.
  // Dagre's crossing-minimisation starts from the initial node order, so adding
  // edges in left-to-right handle order gives the correct starting permutation.
  const sortedEdges = [...edges].sort((a, b) => {
    if (a.source !== b.source) return 0
    const src = nodeMap.get(a.source)
    const aIdx = handleSortIndex(src?.type, a.sourceHandle, src?.data)
    const bIdx = handleSortIndex(src?.type, b.sourceHandle, src?.data)
    return aIdx - bIdx
  })

  // Edge weights govern dagre's network-simplex objective (Σ weight * slack).
  // Three groups need special handling:
  //
  //   1. Backbone edges (branch → branch_end, parallel → parallel_end). Weight
  //      0.01 — simplex won't drag the entire subtree below the start downward
  //      to shorten the backbone, but the start still sits above the end.
  //
  //   2. Chain-leaf-to-branch_end edges. Weight 0 — branch_end's Y is post-
  //      processed (see below), so we don't want simplex shortening these
  //      either. A positive weight (even 0.01) makes simplex pull the chain
  //      leaf DOWN to branch_end.rank - 1, which breaks sibling alignment:
  //      a short chain whose leaf wires to branch_end gets yanked deeper
  //      than a sibling chain's same-rank node that doesn't wire down.
  //      minlen: 1 still ensures branch_end ≥ leaf.rank + 1 for downstream.
  //
  //   3. Chain-leaf-to-parallel_end edges. Weight 0.01 retained — parallel_end
  //      uses a different positioning strategy (synthetic dagre edges added
  //      below) and dagre's natural rank for it is load-bearing.
  for (const edge of sortedEdges) {
    // Cross-links are rendered by React Flow but excluded from dagre ranking.
    if (crossEdgeIds.has(edge.id)) continue
    const src = nodeMap.get(edge.source)
    const tgt = nodeMap.get(edge.target)
    const isBackbone =
      (src?.type === 'branch' && tgt?.type === 'branch_end') ||
      (src?.type === 'parallel' && tgt?.type === 'parallel_end')
    const isChainToBranchEnd = !isBackbone && tgt?.type === 'branch_end'
    const isChainToParallelEnd = !isBackbone && tgt?.type === 'parallel_end'
    if (isChainToBranchEnd) {
      g.setEdge(edge.source, edge.target, { weight: 0, minlen: 1 })
    } else if (isBackbone || isChainToParallelEnd) {
      g.setEdge(edge.source, edge.target, { weight: 0.01, minlen: 1 })
    } else {
      g.setEdge(edge.source, edge.target)
    }
  }

  // Phantom children for unconnected multi-output handles. dagre allocates a
  // column for each phantom, which keeps the empty handle's "lane" of canvas
  // visible (and reachable for future drops) instead of letting the connected
  // chain collapse into the whole branch's territory. Phantoms are dagre-only
  // — never in React Flow's nodes/edges, never rendered, never saved.
  for (const node of nodes) {
    const handles = configuredHandleIds(node)
    if (!handles || handles.length < 2) continue
    const usedHandles = new Set<string>()
    for (const e of edges) {
      if (e.source === node.id && e.sourceHandle) usedHandles.add(e.sourceHandle)
    }
    for (const h of handles) {
      if (usedHandles.has(h)) continue
      const phantomId = `__phantom_${node.id}_${h}`
      g.setNode(phantomId, { width: NODE_W, height: STANDARD_NODE_H })
      // Low weight so the phantom doesn't fight dagre's real edge optimizer.
      g.setEdge(node.id, phantomId, { weight: 0.05, minlen: 1 })
    }
  }

  // For each parallel, push its paired parallel_end one rank below the slot
  // children's chains by adding synthetic dagre-only edges from each chain
  // leaf to the parallel_end. Without this, slot children (e.g., a webhook)
  // and the parallel_end render at the same y and overlap horizontally —
  // they're both rank+1 from the parallel start because the only edge into
  // parallel_end is the backbone. These synthetic edges are not added to
  // React Flow's edge state; they only influence dagre's rank assignment.
  for (const node of nodes) {
    if (node.type !== 'parallel') continue
    // Find the paired parallel_end by walking outgoing edges to a parallel_end
    // target. Don't rely on data._pairId — that only exists on freshly-dropped
    // parallels, not on definitions loaded from the DB.
    const pairEdge = edges.find((e) => {
      if (e.source !== node.id) return false
      const target = nodes.find((n) => n.id === e.target)
      return target?.type === 'parallel_end'
    })
    if (!pairEdge) continue
    const pairId = pairEdge.target
    const slotEdges = edges.filter(
      (e) => e.source === node.id && (e.sourceHandle ?? '').startsWith('child-')
    )
    for (const slotEdge of slotEdges) {
      let current = slotEdge.target
      const visited = new Set<string>([node.id])
      while (!visited.has(current)) {
        visited.add(current)
        if (current === pairId) break
        const next = edges.find((e) => e.source === current && !visited.has(e.target))
        if (!next) break
        current = next.target
      }
      if (current !== pairId) {
        // Low weight so dagre's rank-optimization doesn't bump shorter slot
        // chains up to a deeper rank just to keep the synthetic edge short.
        // The minlen still ensures parallel_end sits below the chain leaf.
        g.setEdge(current, pairId, { weight: 0.05, minlen: 1 })
      }
    }
  }

  // Note: branches DON'T get synthetic dagre rank edges to their branch_end.
  // Tried it (commits f7b6661 / 1aef364) — dagre's rank-balancing pulls the
  // whole left half of a workflow deep just to minimize a synthetic edge's
  // length when the right half is more nested. Branch_end positions are
  // post-processed below dagre instead.

  dagre.layout(g)

  // ── Post-process: guarantee correct left-to-right child ordering ────────────
  //
  // Dagre's crossing minimisation is heuristic and not guaranteed to preserve
  // the edge-insertion order. We enforce the correct order by:
  //   1. Grouping children of each multi-output node by rank (y position).
  //   2. Sorting each group by desired handle order.
  //   3. Assigning the dagre-computed x values in sorted order (so the spread
  //      dagre chose is preserved — only the assignment changes).
  //
  // This is a pure x-coordinate swap and cannot break anything downstream.

  // Collect dagre positions (center-based)
  const pos = new Map<string, { x: number; y: number }>()
  for (const node of nodes) {
    const p = g.node(node.id)
    if (p) pos.set(node.id, { x: p.x, y: p.y })
  }

  // Group outgoing edges by source
  const outEdgesBySource = new Map<string, Edge[]>()
  for (const edge of edges) {
    const list = outEdgesBySource.get(edge.source) ?? []
    list.push(edge)
    outEdgesBySource.set(edge.source, list)
  }

  for (const [sourceId, outEdges] of outEdgesBySource) {
    if (outEdges.length < 2) continue
    const src = nodeMap.get(sourceId)

    // Collect children that have dagre positions and group by rank (rounded y)
    const children = outEdges
      .filter((e) => pos.has(e.target))
      .map((e) => ({
        nodeId: e.target,
        handleIdx: handleSortIndex(src?.type, e.sourceHandle, src?.data),
        ...pos.get(e.target)!,
      }))

    // Group by y rank (round to nearest px to tolerate floating-point drift)
    const byRank = new Map<number, typeof children>()
    for (const child of children) {
      const rank = Math.round(child.y)
      const group = byRank.get(rank) ?? []
      group.push(child)
      byRank.set(rank, group)
    }

    for (const group of byRank.values()) {
      if (group.length < 2) continue

      // The x values dagre assigned (sorted ascending)
      const sortedX = [...group].sort((a, b) => a.x - b.x).map((c) => c.x)
      // The desired order of those x values (by handle index)
      const desired = [...group].sort((a, b) => a.handleIdx - b.handleIdx)

      for (let i = 0; i < desired.length; i++) {
        pos.get(desired[i].nodeId)!.x = sortedX[i]
      }
    }
  }

  // ── Post-process: children of multi-output nodes sit at the X they would
  // occupy if every configured handle had a child attached. This keeps a
  // 1-of-N child directly under its specific handle (instead of centered),
  // and lays out 2-of-3 cases without collapsing the gap left by the unused
  // middle handle.
  const applyMultiOutputOverride = () => {
    for (const [sourceId, outEdges] of outEdgesBySource) {
      const src = nodeMap.get(sourceId)
      if (!src) continue
      const handles = configuredHandleIds(src)
      if (!handles || handles.length < 2) continue
      const parentPos = pos.get(sourceId)
      if (!parentPos) continue
      const offsets = handleOffsetsByNode.get(sourceId)
      if (!offsets) continue
      for (const e of outEdges) {
        if (!e.sourceHandle) continue
        const childPos = pos.get(e.target)
        if (!childPos) continue
        const idx = handles.indexOf(e.sourceHandle)
        if (idx >= 0) {
          childPos.x = parentPos.x + offsets[idx]
        } else {
          childPos.x = parentPos.x
        }
      }
    }
    // For each branch, align its first convergence node (smallest Y among
    // nodes reachable from every handle) to the branch's own X. Linear-chain
    // then propagates that X down the post-branch flow, so the "after the
    // branch" chain sits in the same column as the "before the branch" chain.
    for (const [branchId, candidates] of convergenceCandidatesByBranch) {
      const branchPos = pos.get(branchId)
      if (!branchPos) continue
      let firstConvId: string | null = null
      let firstConvY = Infinity
      for (const id of candidates) {
        const p = pos.get(id)
        if (!p) continue
        if (p.y < firstConvY) {
          firstConvY = p.y
          firstConvId = id
        }
      }
      if (!firstConvId) continue
      const convPos = pos.get(firstConvId)
      if (convPos) convPos.x = branchPos.x
    }
  }
  applyMultiOutputOverride()

  // ── Post-process: x-align single-child linear chains with their parent.
  //
  // Dagre's network-simplex layout will sometimes pull a downstream chain
  // toward the visual center of the graph instead of placing it directly
  // under its actual parent. This is most visible when a Branch has multiple
  // children but only one of them has further descendants — dagre centers
  // those descendants between the branch's children, making it look like
  // they belong to the wrong branch.
  //
  // Fix: for any node with exactly one incoming edge whose parent has exactly
  // one outgoing edge, copy the parent's x. Iterate until stable so chains
  // of any length get aligned. Only kicks in for linear segments — multi-child
  // nodes keep dagre's balanced layout.
  const inEdgesByTarget = new Map<string, Edge[]>()
  for (const edge of edges) {
    const list = inEdgesByTarget.get(edge.target) ?? []
    list.push(edge)
    inEdgesByTarget.set(edge.target, list)
  }
  const applyLinearChain = () => {
    let changed = true
    let iterations = 0
    while (changed && iterations < nodes.length) {
      changed = false
      iterations++
      for (const node of nodes) {
        const inE = inEdgesByTarget.get(node.id) ?? []
        if (inE.length === 0) continue
        // Multiple incoming edges from the same single parent (e.g. a stray
        // duplicate edge with a null sourceHandle) is still a linear segment
        // — what matters is that all incoming come from one upstream.
        const uniqueParents = new Set(inE.map((e) => e.source))
        if (uniqueParents.size !== 1) continue
        const parentId = inE[0].source
        const parentOut = outEdgesBySource.get(parentId) ?? []
        const uniqueChildren = new Set(parentOut.map((e) => e.target))
        if (uniqueChildren.size !== 1) continue
        const parent = nodeMap.get(parentId)
        if (parent && configuredHandleIds(parent)) continue
        const childPos = pos.get(node.id)
        const parentPos = pos.get(parentId)
        if (!childPos || !parentPos) continue
        if (Math.abs(childPos.x - parentPos.x) < 0.5) continue
        childPos.x = parentPos.x
        changed = true
      }
    }
  }
  applyLinearChain()

  // Each (override → linear-chain) pair settles one more level of nesting.
  // 2 pairs covers 2 levels; arbitrary depth needs an iteration. Both
  // operations are idempotent given a stable pos map, so extra passes are
  // free — break early when nothing changes.
  const snapshot = () => Array.from(pos.entries(), ([id, p]) => `${id}:${p.x}`).join('|')
  for (let i = 0; i < 8; i++) {
    const before = snapshot()
    applyMultiOutputOverride()
    applyLinearChain()
    if (snapshot() === before) break
  }

  // ── Post-process: place every branch_end below its branch's content and
  // below any nested end that would horizontally overlap it. The starts
  // cascade naturally by nesting depth (each nested branch is one flow-step
  // deeper); the ends should mirror that on the way out — inner ends shallow,
  // outer ends deep, no overlap.
  //
  // Done in nesting order (innermost branch first) in a SINGLE pass to avoid
  // the circular dependency that an iterative forward-BFS hits: an inner end's
  // forward reach can run downstream into an outer end (e.g. bid_race.output →
  // state_condition_check_end skips estimated_debt_check_end), and the outer
  // end's reach runs back through the inner — each iteration pushed both
  // deeper, blowing the outermost end thousands of px down.
  //
  // Containment depth: how many branches contain B in their slot subtree.
  // Crucially, the slot-reachable walk STOPS at the branch's own paired end —
  // otherwise a branch whose flow continues past its end (e.g. equifax_debt →
  // … → equifax_debt_end → mutate_bes → … → the entire rest of the workflow)
  // would appear to "contain" everything downstream, making its end stack
  // below all of it. Real containment ends at the branch's own convergence.
  const slotReachable = new Map<string, Set<string>>()
  for (const b of nodes) {
    if (b.type !== 'branch' && b.type !== 'parallel') continue
    const endType = b.type === 'branch' ? 'branch_end' : 'parallel_end'
    const pairEnd = edges.find((e) => e.source === b.id && nodeMap.get(e.target)?.type === endType)?.target
    const handles = configuredHandleIds(b) ?? []
    const reach = new Set<string>()
    const q: string[] = []
    for (const h of handles) {
      const se = edges.find((e) => e.source === b.id && e.sourceHandle === h)
      if (se) q.push(se.target)
    }
    while (q.length > 0) {
      const cur = q.shift() as string
      if (reach.has(cur) || cur === pairEnd) continue
      reach.add(cur)
      for (const e of edges) if (e.source === cur && !reach.has(e.target)) q.push(e.target)
    }
    slotReachable.set(b.id, reach)
  }
  const branchContainmentDepth = (branchId: string): number => {
    let d = 0
    for (const [otherId, reach] of slotReachable) {
      if (otherId !== branchId && reach.has(branchId)) d++
    }
    return d
  }

  // Both end types participate: a parallel_end nested in a branch's slot (or
  // vice versa) must stack below its container's content too. Excluding
  // parallel_end here left it at its dagre position while branch_ends cascaded,
  // so an outer branch_end could land directly on top of an inner parallel_end.
  const endNodes = nodes.filter((n) => n.type === 'branch_end' || n.type === 'parallel_end')
  const endDepth = new Map<string, number>()
  for (const e of endNodes) {
    const branchId = (e.data as { _pairId?: string })._pairId
    endDepth.set(e.id, branchId ? branchContainmentDepth(branchId) : 0)
  }
  // Innermost (highest containment depth) first.
  endNodes.sort((a, b) => (endDepth.get(b.id) ?? 0) - (endDepth.get(a.id) ?? 0))

  for (const node of endNodes) {
    const branchId = (node.data as { _pairId?: string })._pairId
    if (!branchId) continue
    const branchPos = pos.get(branchId)
    const ownPos = pos.get(node.id)
    if (!branchPos || !ownPos) continue
    const branch = nodeMap.get(branchId)

    // (1) Deepest CONTENT in this branch's subtree (skip end nodes; stop
    // recursing at ends so we don't run downstream into outer ends).
    const handles = branch ? configuredHandleIds(branch) ?? [] : []
    let contentDeepestY = branchPos.y
    let contentDeepestH = branch ? effectiveHeight(branch) : nodeHeight(undefined)
    const visited = new Set<string>([branchId, node.id])
    const queue: string[] = []
    for (const h of handles) {
      const slotEdge = edges.find((e) => e.source === branchId && e.sourceHandle === h)
      if (slotEdge) queue.push(slotEdge.target)
    }
    while (queue.length > 0) {
      const cur = queue.shift() as string
      if (visited.has(cur)) continue
      visited.add(cur)
      const curNode = nodeMap.get(cur)
      const isEnd = curNode?.type === 'branch_end' || curNode?.type === 'parallel_end'
      const curPos = pos.get(cur)
      if (curPos && !isEnd && curPos.y > contentDeepestY) {
        contentDeepestY = curPos.y
        if (curNode) contentDeepestH = effectiveHeight(curNode)
      }
      if (isEnd) continue // don't recurse past a nested end
      for (const e of edges) {
        if (e.source === cur && !visited.has(e.target)) queue.push(e.target)
      }
    }
    let newY = contentDeepestY + contentDeepestH / 2 + 96 + effectiveHeight(node) / 2

    // (2) Below every already-placed end whose paired branch is genuinely
    // nested inside MY branch's slot (real containment). The outer end always
    // sits below its inner ends — no X-overlap gate, because pills are narrow
    // and two containment-related pills in different columns would otherwise
    // land at nearly the same Y (ambiguous which is the outer convergence).
    // Processed innermost-first, so inner positions are final. 48 px gap.
    // Using real containment (not global depth) means a shallow-but-late end
    // like equifax_debt_end isn't dragged below deep ends it doesn't contain.
    const myContains = slotReachable.get(branchId) ?? new Set<string>()
    for (const other of endNodes) {
      if (other === node) continue
      const otherBranch = (other.data as { _pairId?: string })._pairId
      if (!otherBranch || !myContains.has(otherBranch)) continue
      const otherPos = pos.get(other.id)
      if (!otherPos) continue
      const stackedY = otherPos.y + effectiveHeight(other) / 2 + 48 + effectiveHeight(node) / 2
      if (stackedY > newY) newY = stackedY
    }

    ownPos.x = branchPos.x
    ownPos.y = newY
  }

  // ── Post-process: downstream of a cascaded end must follow it down.
  // The cascade above moves an end BELOW its dagre rank (to clear its content
  // and any nested ends). But nodes after the end (e.g. branch_end → mutate_bes)
  // were placed by dagre/applyLinearChain at the end's ORIGINAL rank — they
  // don't know it moved. The gap then collapses, which is most visible in
  // execution view: code/branch/filter nodes grow an output-preview row, so on
  // a layout pass that runs with measured execution heights the cascade offset
  // is larger and the downstream node ends up underneath the end card. Push
  // each end's downstream chain down to restore the gap. Relax until stable —
  // shifting one end's subtree carries any nested ends with it, preserving
  // their internal spacing; the re-check then finds them already clear.
  const END_DOWNSTREAM_GAP = 48
  const shiftSubtreeDown = (rootId: string, delta: number) => {
    const seen = new Set<string>([rootId])
    const stack = [rootId]
    while (stack.length > 0) {
      const id = stack.pop() as string
      const p = pos.get(id)
      if (p) p.y += delta
      for (const e of edges) {
        if (e.source === id && !seen.has(e.target)) {
          seen.add(e.target)
          stack.push(e.target)
        }
      }
    }
  }
  for (let iter = 0; iter < nodes.length; iter++) {
    let moved = false
    for (const end of endNodes) {
      const endPos = pos.get(end.id)
      if (!endPos) continue
      const endBottom = endPos.y + effectiveHeight(end) / 2
      for (const e of edges) {
        if (e.source !== end.id) continue
        const child = nodeMap.get(e.target)
        const childPos = pos.get(e.target)
        if (!child || !childPos) continue
        const requiredCenter = endBottom + END_DOWNSTREAM_GAP + effectiveHeight(child) / 2
        if (childPos.y < requiredCenter - 0.5) {
          shiftSubtreeDown(e.target, requiredCenter - childPos.y)
          moved = true
        }
      }
    }
    if (!moved) break
  }

  // ── Post-process: extra gap between the main (trigger) component and any
  // disconnected subgraphs so it's visually obvious they aren't wired up.
  const EXTRA_DISCONNECTED_GAP = DISCONNECTED_GAP
  const adj = new Map<string, Set<string>>()
  for (const n of nodes) adj.set(n.id, new Set())
  for (const e of edges) {
    adj.get(e.source)?.add(e.target)
    adj.get(e.target)?.add(e.source)
  }
  const component = new Map<string, number>()
  let compIdx = 0
  for (const n of nodes) {
    if (component.has(n.id)) continue
    const queue = [n.id]
    while (queue.length) {
      const id = queue.shift() as string
      if (component.has(id)) continue
      component.set(id, compIdx)
      for (const next of adj.get(id) ?? []) queue.push(next)
    }
    compIdx++
  }
  const mainComp = component.get('trigger')
  if (mainComp !== undefined && compIdx > 1) {
    const bbox = (comp: number) => {
      let minX = Infinity, maxX = -Infinity
      for (const [id, c] of component) {
        if (c !== comp) continue
        const p = pos.get(id)
        if (!p) continue
        const w = nodeWidth(nodeMap.get(id)?.type, nodeMap.get(id)?.data)
        minX = Math.min(minX, p.x - w / 2)
        maxX = Math.max(maxX, p.x + w / 2)
      }
      return { minX, maxX }
    }
    const shiftComp = (comp: number, dx: number) => {
      for (const [id, c] of component) {
        if (c !== comp) continue
        const p = pos.get(id)
        if (p) p.x += dx
      }
    }
    // Walk components left-to-right by their current min-x and keep pushing
    // each one past everything already placed. Main always anchors first.
    const others = Array.from({ length: compIdx }, (_, i) => i).filter((c) => c !== mainComp)
    others.sort((a, b) => bbox(a).minX - bbox(b).minX)
    let cursor = bbox(mainComp).maxX
    for (const c of others) {
      const box = bbox(c)
      if (!Number.isFinite(box.minX)) continue
      const minAllowed = cursor + EXTRA_DISCONNECTED_GAP
      if (box.minX < minAllowed) shiftComp(c, minAllowed - box.minX)
      cursor = bbox(c).maxX
    }
  }

  // Reachability from trigger — any unreachable node with an existing
  // position is treated as manually-positioned and left alone. Prevents
  // disconnected subgraphs from getting re-aligned to the top whenever
  // another part of the graph mutates (e.g. dropping a new node).
  const reachable = new Set<string>()
  if (nodeMap.has('trigger')) {
    const outgoing = new Map<string, string[]>()
    for (const e of edges) {
      const arr = outgoing.get(e.source) ?? []
      arr.push(e.target)
      outgoing.set(e.source, arr)
    }
    // Parallel parent → children follow-through (matches canvas reachability)
    for (const n of nodes) {
      const children = (n.data as { children?: unknown })?.children
      if (Array.isArray(children) && children.every((c) => typeof c === 'string')) {
        const arr = outgoing.get(n.id) ?? []
        outgoing.set(n.id, [...arr, ...(children as string[])])
      }
    }
    const queue = ['trigger']
    while (queue.length > 0) {
      const id = queue.shift() as string
      if (reachable.has(id)) continue
      reachable.add(id)
      for (const next of outgoing.get(id) ?? []) queue.push(next)
    }
  }

  // Chain-straightening. dagre balances a node between its own parent and its
  // child's subtree, which leaves a single-child chain running on a diagonal
  // (e.g. engine_no_bids_call → engine_ok_branch drifting right under its
  // response legs). When a node C has exactly ONE non-cross parent P and P has
  // exactly ONE non-cross child (C), pull C's whole exclusive subtree so C sits
  // directly under P. Cross-links (filter forks) are ignored — they don't count
  // as parents/children here, so the chain straightens "ignoring the filter".
  {
    const isEnd = (id: string) => { const t = nodeMap.get(id)?.type; return t === 'branch_end' || t === 'parallel_end' }
    const childrenOf = (id: string) => edges
      .filter((e) => e.source === id && !crossEdgeIds.has(e.id) && reachable.has(e.target) && !isEnd(e.target))
      .map((e) => e.target)
    const parentsOf = (id: string) => edges
      .filter((e) => e.target === id && !crossEdgeIds.has(e.id))
      .map((e) => e.source)
    const order = [...pos.keys()].filter((id) => reachable.has(id)).sort((a, b) => pos.get(a)!.y - pos.get(b)!.y)
    for (const p of order) {
      const kids = childrenOf(p)
      if (kids.length !== 1) continue
      const c = kids[0]
      const cp = parentsOf(c)
      if (cp.length !== 1 || cp[0] !== p || isEnd(c)) continue
      const shift = pos.get(p)!.x - pos.get(c)!.x
      if (Math.abs(shift) < 1) continue
      // Shift C and its exclusive non-cross subtree (stop at any node that has a
      // parent outside the subtree, so we never drag a shared node).
      const sub = new Set<string>([c])
      const stack = [c]
      while (stack.length) {
        const x = stack.pop() as string
        for (const k of childrenOf(x)) {
          if (sub.has(k)) continue
          if (parentsOf(k).every((pp) => sub.has(pp))) { sub.add(k); stack.push(k) }
        }
      }
      for (const id of sub) { const pp = pos.get(id); if (pp) pp.x += shift }
    }
  }

  // De-overlap pass. dagre separates nodes within a rank, but the post-dagre
  // overrides (multi-output children snapped to handle-x, convergence nodes
  // aligned to their branch-x) move nodes without collision checks — so two
  // chains that end up in the same column (e.g. a filter's cross-link routes
  // one response leg on top of another) can overlap. We compare ACTUAL boxes
  // rather than rank buckets: a tall node (a branch is 164px) can bleed into a
  // neighbour that dagre put a sub-rank away, so same-rank grouping misses it.
  // For every vertically-overlapping pair, push the right node rightward by the
  // minimum gap; iterate until stable. Only reachable nodes are shuffled
  // (orphans keep their manual positions). Runs as part of layout, so collisions
  // resolve live as the canvas re-lays-out on wiring — no save/reload needed.
  {
    const DEOVERLAP_GAP = NODE_GAP
    const widthOf = (id: string) =>
      effectiveWidthByNode.get(id) ?? nodeWidth(nodeMap.get(id)?.type, nodeMap.get(id)?.data)
    const halfH = (id: string) => {
      const n = nodeMap.get(id)
      return (n ? effectiveHeight(n) : STANDARD_NODE_H) / 2
    }
    const ids = [...pos.keys()].filter((id) => reachable.has(id))
    for (let iter = 0; iter < 8; iter++) {
      ids.sort((a, b) => pos.get(a)!.x - pos.get(b)!.x)
      let moved = false
      for (let i = 0; i < ids.length; i++) {
        const a = pos.get(ids[i])!
        for (let j = i + 1; j < ids.length; j++) {
          const b = pos.get(ids[j])!
          // Only collide nodes whose vertical spans actually overlap.
          if (Math.abs(a.y - b.y) >= halfH(ids[i]) + halfH(ids[j])) continue
          const minCenterDist = widthOf(ids[i]) / 2 + widthOf(ids[j]) / 2 + DEOVERLAP_GAP
          if (b.x - a.x < minCenterDist - 0.5) {
            b.x = a.x + minCenterDist
            moved = true
          }
        }
      }
      if (!moved) break
    }
  }

  // Top-align siblings within a rank. `pos` holds CENTER coordinates, so
  // converting to top-left as `centerY - height/2` makes same-rank nodes of
  // different heights (e.g. a tall data_store with a value chip next to a
  // short response) land at different tops — the incoming edges then arrive at
  // visibly different heights. Group nodes by their shared center-y and align
  // every node in the rank to the tallest one's top, so tops line up.
  const willUsePos = (node: (typeof nodes)[number]) => {
    const manual = (node.data as { manualPosition?: boolean } | undefined)?.manualPosition
    const isReachable = reachable.has(node.id)
    const hasExistingPos = node.position.x !== 0 || node.position.y !== 0
    if (!isReachable && (manual || hasExistingPos)) return false
    return pos.has(node.id)
  }
  const maxHByRank = new Map<number, number>()
  for (const node of nodes) {
    if (!willUsePos(node)) continue
    const p = pos.get(node.id)!
    const rank = Math.round(p.y)
    const h = effectiveHeight(node)
    if (h > (maxHByRank.get(rank) ?? 0)) maxHByRank.set(rank, h)
  }

  return nodes.map((node) => {
    // manualPosition only applies to nodes NOT reachable from the trigger.
    // Active (reachable) nodes always take dagre's position so the main flow
    // stays aligned even if the node happened to have an old manual flag.
    // Orphans with existing positions are preserved regardless of the flag
    // (prevents drift on unrelated edits).
    const manual = (node.data as { manualPosition?: boolean } | undefined)?.manualPosition
    const isReachable = reachable.has(node.id)
    const hasExistingPos = node.position.x !== 0 || node.position.y !== 0
    // Layout-computed canvas-only data: effective width (so multi-output nodes
    // render wide enough to cover their children's span) and per-handle
    // offsets (so handles render above each child's actual column).
    const effW = effectiveWidthByNode.get(node.id)
    const offsets = handleOffsetsByNode.get(node.id)
    const staleData = node.data as { _spanWidth?: number; _handleOffsets?: number[] } | undefined
    let layoutData: typeof node.data
    if (effW || offsets) {
      layoutData = { ...node.data, _spanWidth: effW, _handleOffsets: offsets }
    } else if (staleData?._spanWidth != null || staleData?._handleOffsets != null) {
      // Node is no longer an active fan-out (e.g. a `filter`, or a type change) —
      // drop the stale span so `nodeWidth` stops honoring it. Only rebuilds the
      // object when the fields actually exist, preserving identity otherwise.
      const { _spanWidth, _handleOffsets, ...rest } = node.data
      void _spanWidth; void _handleOffsets
      layoutData = rest
    } else {
      layoutData = node.data
    }
    if (!isReachable && (manual || hasExistingPos)) {
      return layoutData === node.data ? node : { ...node, data: layoutData }
    }
    const p = pos.get(node.id)
    if (!p) return layoutData === node.data ? node : { ...node, data: layoutData }
    const w = effW ?? nodeWidth(node.type, node.data)
    return {
      ...node,
      data: layoutData,
      position: {
        x: p.x - w / 2,
        y: p.y - (maxHByRank.get(Math.round(p.y)) ?? effectiveHeight(node)) / 2,
      },
    }
  })
}
