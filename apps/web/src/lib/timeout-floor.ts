// Minimum timeout (ms) that can reliably work for a step, by node type — the
// irreducible dispatch / network / IO overhead a configured value must clear or
// the step times out on cold runs and fails. The percentiles can't see this:
// completed-step durations exclude any attempt slow enough to have hit the
// current timeout, so for dispatch-/IO-bound steps the real floor lives below
// the visible data.
//
// MIRROR of `suggestionFloorMs` in apps/worker/src/routes/api/executions.ts.
// Kept on the frontend so the canvas can flag a sub-floor timeout at a glance —
// in view mode, without selecting the node or making an API round-trip. Keep
// the two in sync; the worker is the source of truth.
const DISPATCH_OR_DB_FLOOR_MS = 150
const NETWORK_FLOOR_MS = 50
const INMEMORY_FLOOR_MS = 10
const DISPATCH_OR_DB_NODE_TYPES = new Set(['code', 'constants'])
const NETWORK_NODE_TYPES = new Set(['partner_bid', 'integration', 'salesforce', 'webhook', 'bid_group'])

export function timeoutFloorMs(nodeType?: string): number {
  if (nodeType && DISPATCH_OR_DB_NODE_TYPES.has(nodeType)) return DISPATCH_OR_DB_FLOOR_MS
  if (nodeType && NETWORK_NODE_TYPES.has(nodeType)) return NETWORK_FLOOR_MS
  return INMEMORY_FLOOR_MS
}

/**
 * The configured timeout is below the node-type floor — a hard misconfig that
 * fails on cold runs. Returns the floor when below it, otherwise null.
 */
export function timeoutBelowFloor(nodeType: string | undefined, config: Record<string, unknown> | undefined): number | null {
  const timeout = config?.timeout_ms
  if (typeof timeout !== 'number') return null
  const floor = timeoutFloorMs(nodeType)
  return timeout < floor ? floor : null
}
