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
 * Branch nodes grow horizontally to fit all handle labels in the footer row.
 * Other types use the shared NODE_W. Keep this in sync with the rendered
 * width in BranchNode.tsx so dagre reserves the same horizontal slot.
 */
export function nodeWidth(type: string | undefined, data: unknown): number {
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
  g.setGraph({ rankdir: 'TB', ranksep: 48, nodesep: 48, marginx: 60, marginy: 60 })

  for (const node of nodes) {
    g.setNode(node.id, { width: nodeWidth(node.type, node.data), height: nodeHeight(node.type) })
  }

  // Build a quick lookup so we can resolve node type/data for each edge source
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

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

  for (const edge of sortedEdges) {
    g.setEdge(edge.source, edge.target)
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
  const SIBLING_SPACING = NODE_W + 48 // matches dagre's nodesep above
  const applyMultiOutputOverride = () => {
    for (const [sourceId, outEdges] of outEdgesBySource) {
      const src = nodeMap.get(sourceId)
      if (!src) continue
      const handles = configuredHandleIds(src)
      if (!handles || handles.length < 2) continue
      const parentPos = pos.get(sourceId)
      if (!parentPos) continue
      for (const e of outEdges) {
        if (!e.sourceHandle) continue
        const childPos = pos.get(e.target)
        if (!childPos) continue
        const idx = handles.indexOf(e.sourceHandle)
        if (idx >= 0) {
          childPos.x = parentPos.x + (idx - (handles.length - 1) / 2) * SIBLING_SPACING
        } else {
          childPos.x = parentPos.x
        }
      }
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
        if (inE.length !== 1) continue
        const parentId = inE[0].source
        const parentOut = outEdgesBySource.get(parentId) ?? []
        if (parentOut.length !== 1) continue
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

  return nodes.map((node) => {
    // manualPosition only applies to nodes NOT reachable from the trigger.
    // Active (reachable) nodes always take dagre's position so the main flow
    // stays aligned even if the node happened to have an old manual flag.
    // Orphans with existing positions are preserved regardless of the flag
    // (prevents drift on unrelated edits).
    const manual = (node.data as { manualPosition?: boolean } | undefined)?.manualPosition
    const isReachable = reachable.has(node.id)
    const hasExistingPos = node.position.x !== 0 || node.position.y !== 0
    if (!isReachable && (manual || hasExistingPos)) return node
    const p = pos.get(node.id)
    if (!p) return node
    return {
      ...node,
      position: {
        x: p.x - nodeWidth(node.type, node.data) / 2,
        y: p.y - nodeHeight(node.type) / 2,
      },
    }
  })
}
