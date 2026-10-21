import { NODE_TRAITS, isNodeType, type NodeType } from '@/types/workflow'

/**
 * The one list of a canvas node's output handles and where they sit (#1576,
 * milestone 55). The layout places children from it, publishes the positions it
 * chose onto the node's data, and every multi output card draws its handles from
 * those positions through <SourceHandles>. Before this, the handle ids were
 * written out in the layout twice (configuredHandleIds and handleSortIndex) and
 * again in each card, and the copies disagreed.
 */

type NodeLike = { type?: string; data?: unknown }

/**
 * How a card's width relates to its outputs.
 * - fanout: the card widens so each handle sits above its child's column.
 * - fixed: the card keeps its width (filters, 560e915d, 2026-06-03, and the
 *   click check). One wired output is drawn at the centre with its child
 *   straight below; with more wired, the handles stay at the card's own
 *   fractions and the children spread, so the wires bend (Dan, 2026-09-25).
 * - single: one pass through output, or none. branch_end and parallel_end are
 *   here on purpose: their output continues the flow rather than being an arm.
 * Keyed by every node type, so a new type is a compile error until it is placed.
 */
export const CARD_KIND: Record<NodeType, 'fanout' | 'fixed' | 'single'> = {
  branch: 'fanout',
  parallel: 'fanout',
  bid_group: 'fanout',
  latency_gate: 'fanout',
  buyer_select: 'fanout',
  buyer_click_send: 'fanout',
  filter: 'fixed',
  buyer_click_check: 'fixed',
  branch_end: 'single',
  parallel_end: 'single',
  code: 'single',
  response: 'single',
  exit: 'single',
  partner_bid: 'single',
  webhook: 'single',
  transform: 'single',
  constants: 'single',
  salesforce: 'single',
  data_store: 'single',
  achieve_offers: 'single',
  // One output, the lead going on; a rejection answers and ends the run (#2589).
  lead_validation: 'single',
}

export function cardKind(type: string | undefined): 'fanout' | 'fixed' | 'single' {
  return isNodeType(type) ? CARD_KIND[type] : 'single'
}

/** Where a fixed card draws its handles when none, or more than one, is wired: a fraction of its width. */
const FIXED_FRACTIONS: Partial<Record<NodeType, readonly number[]>> = {
  filter: [0.3, 0.7],
  buyer_click_check: [0.25, 0.75],
}

/** Horizontal gap between two sibling columns. */
export const SLOT_GAP = 96

/**
 * A node's output handle ids, left to right, or [] when it has one pass through
 * output. Static lists come from the node type's traits; three types read their
 * config:
 * - branch: an arm per branch, then `else` only when the else is an output (the
 *   old sort copy appended `else` always, so an else of none or error still
 *   sorted one; that disagreement is resolved here in favour of the card).
 * - parallel: `child-N` for the legacy list of node ids, the slot id otherwise
 *   (the old sort gave every named slot 999, so their order was dagre's).
 * - latency_gate: within and exceeded in check mode; mark mode passes through.
 */
export function outputHandles(node: NodeLike): string[] {
  const config = (node.data as { config?: Record<string, unknown> } | undefined)?.config ?? {}
  const type = node.type
  if (type === 'branch') {
    const branches = (config.branches as { label: string }[] | undefined) ?? []
    const elseBehavior = (config.else_behavior as string | undefined) ?? (config.use_else === false ? 'none' : 'output')
    return [...branches.map((b) => b.label), ...(elseBehavior === 'output' ? ['else'] : [])]
  }
  if (type === 'parallel') {
    const raw = config.children
    if (!Array.isArray(raw) || raw.length === 0) return []
    return typeof raw[0] === 'string' ? raw.map((_, i) => `child-${i}`) : (raw as { id: string }[]).map((s) => s.id)
  }
  if (type === 'latency_gate') return config.operation === 'check' ? ['within', 'exceeded'] : []
  if (!isNodeType(type)) return []
  return [...(NODE_TRAITS[type].staticHandles ?? [])]
}

/** Centres of side by side columns of these widths, as offsets from the card's centre, the whole row centred on it. */
export function slotColumns(widths: number[], gap = SLOT_GAP): number[] {
  const total = widths.reduce((s, w) => s + w, 0) + gap * Math.max(0, widths.length - 1)
  let cursor = -total / 2
  return widths.map((w) => {
    const c = cursor + w / 2
    cursor += w + gap
    return c
  })
}

const evenFractions = (n: number) => Array.from({ length: n }, (_, i) => (i + 0.5) / n)

function restingFractions(type: string | undefined, n: number): number[] {
  const own = isNodeType(type) ? FIXED_FRACTIONS[type] : undefined
  return own && own.length === n ? [...own] : evenFractions(n)
}

/**
 * Where a fixed card draws each handle, as an offset from its centre. One wired
 * handle sits at the centre and the rest share the half of the card on their
 * own side, so no two labels sit on each other; otherwise the card fractions.
 */
export function fixedHandleOffsets(type: string | undefined, handles: string[], wired: ReadonlySet<string>, width: number): number[] {
  const wiredIdx = handles.map((h, i) => (wired.has(h) ? i : -1)).filter((i) => i >= 0)
  let fractions: number[]
  if (wiredIdx.length === 1) {
    const w = wiredIdx[0]
    fractions = handles.map((_, i) => {
      if (i === w) return 0.5
      if (i < w) return (0.5 * (i + 0.5)) / w
      const right = handles.length - 1 - w
      return 0.5 + (0.5 * (i - w - 0.5)) / right
    })
  } else {
    fractions = restingFractions(type, handles.length)
  }
  return fractions.map((f) => (f - 0.5) * width)
}

/**
 * Each handle's left edge as a fraction of the drawn card: from the offsets the
 * layout published when it has run, else the card's resting fractions (only
 * ever seen before the first layout pass).
 */
export function handleLeftFractions(type: string | undefined, handles: string[], offsets: number[] | undefined, width: number): number[] {
  if (offsets && offsets.length === handles.length && width > 0) return offsets.map((o) => 0.5 + o / width)
  return restingFractions(type, handles.length)
}
