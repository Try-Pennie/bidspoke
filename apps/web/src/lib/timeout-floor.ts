// Minimum timeout (ms) that can reliably work for a step, by node type — the
// irreducible dispatch / network / IO overhead a configured value must clear or
// the step times out on cold runs and fails. The percentiles can't see this:
// completed-step durations exclude any attempt slow enough to have hit the
// current timeout, so for dispatch-/IO-bound steps the real floor lives below
// the visible data.
//
// MIRROR of `suggestionFloorMs` in apps/worker/src/lib/timeout-floor.ts (the
// source of truth). Kept on the frontend so the canvas can flag a sub-floor
// timeout at a glance, in view mode, without selecting the node or making an
// API round trip. __tests__/timeout-floor-sync.test.ts imports both and fails
// CI if they diverge. Which types are network and which are dispatch or storage
// is a TRAIT in @bidspoke/node-types (#1411), read by both copies.
import { NODE_TRAITS, isNodeType } from '@bidspoke/node-types'

const DISPATCH_OR_DB_FLOOR_MS = 150
const NETWORK_FLOOR_MS = 50
const INMEMORY_FLOOR_MS = 10

function isNetwork(nodeType: string | undefined): boolean {
  return isNodeType(nodeType) && NODE_TRAITS[nodeType].network
}

function isDispatchOrDb(nodeType: string | undefined): boolean {
  return isNodeType(nodeType) && NODE_TRAITS[nodeType].dispatchOrDb
}

export function timeoutFloorMs(nodeType?: string): number {
  if (isDispatchOrDb(nodeType)) return DISPATCH_OR_DB_FLOOR_MS
  if (isNetwork(nodeType)) return NETWORK_FLOOR_MS
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

// Plain-language reason the floor exists. MIRROR of suggestionFloorReason in
// apps/worker/src/lib/timeout-floor.ts, guarded by the same sync test. Needed
// client-side when the config panel builds its callout from the shared batch
// stats instead of the per-node endpoint (which carries the reason).
export function timeoutFloorReason(nodeType?: string): string | null {
  if (nodeType && nodeType === 'code')
    return 'Code nodes run in a sandboxed worker that takes time to dispatch, so a cold run can take 100ms+ before your code even starts.'
  if (nodeType && nodeType === 'constants')
    return 'The constants step reads from KV and queries the database on a cold cache, so the first run after a gap is a full round-trip.'
  if (nodeType && (nodeType === 'data_store' || nodeType === 'latency_gate'))
    return 'This step reads or writes Cloudflare KV, a storage round-trip that can take 100ms+ on a cold read.'
  if (isNetwork(nodeType))
    return 'This step makes an outbound API call, so every run pays a network round-trip plus TLS setup.'
  return null
}
