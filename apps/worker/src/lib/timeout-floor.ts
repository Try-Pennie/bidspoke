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
//
// Network floor (~50ms): outbound HTTP round-trip + TLS. These nodes' own p99 is
// usually well above this, so the floor mainly guards a fast-declining partner.
//
// In-memory floor (10ms): filter/branch/transform/response/etc. — truly fast;
// keep the original floor so we don't recommend 0ms.
//
// SOURCE OF TRUTH. The web app mirrors this in apps/web/src/lib/timeout-floor.ts
// so the canvas can flag a sub-floor timeout without an API call. The two apps
// share no package, so a consistency test (apps/web/src/lib/__tests__/
// timeout-floor-sync.test.ts) imports both and fails CI if they diverge — edit
// here, and update the mirror or the test breaks.
const DISPATCH_OR_DB_FLOOR_MS = 150
const NETWORK_FLOOR_MS = 50
const INMEMORY_FLOOR_MS = 10
const DISPATCH_OR_DB_NODE_TYPES = new Set(['code', 'constants'])
const NETWORK_NODE_TYPES = new Set(['partner_bid', 'integration', 'salesforce', 'webhook', 'bid_group', 'achieve_offers'])

export function suggestionFloorMs(nodeType?: string): number {
  if (nodeType && DISPATCH_OR_DB_NODE_TYPES.has(nodeType)) return DISPATCH_OR_DB_FLOOR_MS
  if (nodeType && NETWORK_NODE_TYPES.has(nodeType)) return NETWORK_FLOOR_MS
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
  if (nodeType && NETWORK_NODE_TYPES.has(nodeType))
    return 'This step makes an outbound API call, so every run pays a network round-trip plus TLS setup.'
  return null
}
