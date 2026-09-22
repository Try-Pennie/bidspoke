// Minimum timeout the suggester will ever recommend, by node type. This is the
// irreducible overhead the percentiles CAN'T measure: completed-step durations
// exclude any attempt slow enough to have hit the current timeout, so for
// dispatch-/IO-bound steps the real floor lives below the visible data.
//
// Dispatch/DB floor (~150ms): a cold-path round-trip that retries can't rescue,
// because a cold worker / cold cache makes EVERY attempt in the run slow.
//   - code: Cloudflare Dynamic Worker (WfP) dispatch. Warm is single-digit ms,
//     cold is 100ms+. A 20ms timeout here = flaky timeouts on cold runs.
//   - constants: LOOKS in-memory but loadPartnerConstants reads KV and, on a
//     cold miss, queries Supabase (partner_uuid_map + partner_configs) — a DB
//     round-trip. A timed-out fetch never populates KV, so retries stay cold.
//   - data_store: a Cloudflare KV get/set/delete. KV is a storage round-trip,
//     not in-memory — a cold read can run 100ms+, so a sub-floor timeout flaps.
//   - latency_gate: mark/check stamp and read a bid time in KV (SUBMISSIONS) —
//     same storage round-trip as data_store.
//
// Network floor (~50ms): outbound HTTP round-trip + TLS. These nodes' own p99 is
// usually well above this, so the floor mainly guards a fast-declining partner.
//
// In-memory floor (10ms): filter/branch/transform/response/etc. — truly fast;
// keep the original floor so we don't recommend 0ms.
//
// SOURCE OF TRUTH. The web app mirrors this in apps/web/src/lib/timeout-floor.ts
// so the canvas can flag a sub-floor timeout without an API call. A consistency
// test (apps/web/src/lib/__tests__/timeout-floor-sync.test.ts) imports both and
// fails CI if they diverge.
//
// Which types are network and which are dispatch or storage is a TRAIT in
// @bidspoke/node-types (#1411), so a new node type declares it once and both
// copies read it. A string that is not a node type (the trigger, a region, a
// stray spelling) gets the in memory floor, as before.
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

export function suggestionFloorMs(nodeType?: string): number {
  if (isDispatchOrDb(nodeType)) return DISPATCH_OR_DB_FLOOR_MS
  if (isNetwork(nodeType)) return NETWORK_FLOOR_MS
  return INMEMORY_FLOOR_MS
}

// Plain-language reason the floor exists, so the config UI can explain why a
// sub-floor timeout is a hard error (cold path fails every attempt) rather than
// a soft "you have less headroom" nudge. Mirrors the categories above.
export function suggestionFloorReason(nodeType?: string): string | null {
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
