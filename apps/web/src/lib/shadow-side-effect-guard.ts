/**
 * Static classifier for the shadow side-effect guard (#230). Given the source of
 * each node executor, returns the ones that would leak an external side effect in
 * a shadow dry-run. A node is a violation when it performs an outbound action
 * (HTTP/KV/DB/Durable-Object) without short-circuiting under isShadowDryRun, OR
 * when an allowlisted "pure" node turns out to perform one anyway, OR when a new
 * node is neither shadow-aware nor explicitly classified as pure.
 *
 * Pure / read-only node executors. These do no HTTP/KV/DB-write/Durable-Object
 * work, so a shadow dry-run can run them as-is. Adding outbound work to one of
 * these trips the guard until it is removed from the list and given a shadow
 * short-circuit.
 */
export const SHADOW_EXEMPT_NODES = [
  'branch',
  'filter',
  'transform',
  'constants',
  'response',
  'parallel',
  'bid-group',
  // Pure helpers for the achieve_offers node rather than executors of their own. Both only
  // read from the execution context (the lead payload and the already-pulled credit report)
  // and reach nothing outside the isolate, so a shadow dry-run may run them freely. The
  // exemption is still checked both ways: the guard fails if either ever starts performing an
  // outbound call, which is what would make a shadow guard necessary.
  'achieve-credit-report',
  'achieve-screen',
]

// Tokens that mark a node as shadow-aware (it short-circuits its side effects).
const SHADOW_GUARD_RE = /isShadowDryRun|isShadowStandIn|shadow_mode/

// Outbound side-effect markers. Reads (.select/.get) are intentionally excluded —
// a shadow dry-run may read freely; only outbound writes/calls must be skipped.
const OUTBOUND_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'fetch', re: /\bfetch\s*\(/ },
  { label: 'kv.put', re: /\.put\s*\(/ },
  { label: 'db-write', re: /\.(insert|update|upsert|delete)\s*\(/ },
  { label: 'durable-object', re: /\.idFromName\s*\(/ },
]

export interface NodeSource {
  name: string
  content: string
}

export interface ShadowGuardViolation {
  node: string
  reason: string
}

export function findShadowGuardViolations(files: NodeSource[]): ShadowGuardViolation[] {
  const violations: ShadowGuardViolation[] = []

  for (const file of files) {
    const exempt = SHADOW_EXEMPT_NODES.includes(file.name)
    const aware = SHADOW_GUARD_RE.test(file.content)
    const outbound = OUTBOUND_PATTERNS.filter((p) => p.re.test(file.content)).map((p) => p.label)

    if (exempt) {
      if (outbound.length > 0) {
        violations.push({
          node: file.name,
          reason:
            `on the pure/read-only allowlist but performs an outbound side effect ` +
            `(${outbound.join(', ')}). Remove it from SHADOW_EXEMPT_NODES and add an ` +
            `isShadowDryRun guard.`,
        })
      }
      continue
    }

    if (outbound.length > 0 && !aware) {
      violations.push({
        node: file.name,
        reason:
          `performs an outbound side effect (${outbound.join(', ')}) without a shadow guard. ` +
          `Short-circuit it under isShadowDryRun(ctx), or add it to SHADOW_EXEMPT_NODES if pure.`,
      })
      continue
    }

    if (outbound.length === 0 && !aware) {
      violations.push({
        node: file.name,
        reason:
          `is neither on the pure/read-only allowlist nor shadow-aware. Classify it: add ` +
          `to SHADOW_EXEMPT_NODES if pure, otherwise add a shadow guard.`,
      })
    }
  }

  return violations
}
