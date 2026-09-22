import type { Node } from '@xyflow/react'
import type { NodeType } from '@/types/workflow'

// Node-state preview (#227): render every node type across the cross-cutting
// visual states so canvas styling (warning glow, corner badges, execution rings)
// can be checked in a browser / Playwright without auth or live data.

// Typed by NodeType plus the trigger (#1411), so a misspelt entry is a compile
// error; the coverage test beside this file fails on a saved node type that is
// neither previewed nor named in PREVIEW_OMITTED with a reason.
export const PREVIEW_TYPES = [
  'trigger', 'filter', 'branch', 'code', 'webhook', 'transform',
  'parallel', 'bid_group', 'constants', 'salesforce', 'data_store', 'latency_gate',
  'achieve_offers', 'response', 'exit', 'branch_end', 'parallel_end',
] as const satisfies readonly (NodeType | 'trigger')[]

export const PREVIEW_OMITTED: Readonly<Partial<Record<NodeType, string>>> = {
  partner_bid: 'retired (#645): it renders as the generic card, which the preview shows through no type of its own',
}

export const PREVIEW_STATES = ['default', 'unconfigured', 'timeout', 'failed', 'completed'] as const

const COL_GAP = 280
const ROW_GAP = 150

export function buildPreviewNodes(): Node[] {
  const nodes: Node[] = []
  PREVIEW_TYPES.forEach((type, row) => {
    PREVIEW_STATES.forEach((state, col) => {
      const hasError = state === 'unconfigured'
      // Drives the ConfigWarningBadge tooltip (#563). Type-specific in the real
      // canvas ('No script written'); a stand-in here, where every type shares
      // one preview row.
      const errorMessage = hasError ? 'Required fields are empty' : undefined
      // A sub-floor timeout (below every node-type floor) fires the timeout
      // warning badge + glow locally, no history/suggestions fetch needed.
      const config: Record<string, unknown> = state === 'timeout' ? { timeout_ms: 10 } : {}
      const executionStep =
        state === 'failed' ? { status: 'failed' }
        : state === 'completed' ? { status: 'completed' }
        : undefined
      nodes.push({
        id: `${type}-${state}`,
        type,
        position: { x: col * COL_GAP, y: row * ROW_GAP },
        draggable: false,
        selectable: false,
        data: {
          namespace: `${type}_${state}`,
          label: '',
          config,
          hasError,
          errorMessage,
          executionStep,
          isReachable: true,
          variables: {},
        },
      })
    })
  })
  return nodes
}
