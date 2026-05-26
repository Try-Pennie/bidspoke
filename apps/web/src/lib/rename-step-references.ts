/**
 * Rewrites `steps.OLD.…` references to `steps.NEW.…` everywhere they appear
 * in a node config. Used when a user renames a node's namespace (step ID) on
 * the canvas — references in downstream nodes get updated automatically.
 *
 * Covers both reference shapes the engine resolves:
 *   - Template form:   `{{steps.OLD.output.x}}` (response bodies, code props, etc.)
 *   - Bare dot-path:   `steps.OLD.output.x`     (rule-builder fields, transforms, formulas)
 *
 * Word-boundary safe: renaming `credit_check` will not touch `credit_check_v2`.
 *
 * Does NOT rewrite `trigger.X`, `env.X`, or `context.X` — those aren't step
 * namespaces. `config.fallback_node` is a bare-namespace field (not prefixed
 * with `steps.`) — use `renameFallbackNamespace` for that.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildStepsPattern(ns: string): RegExp {
  // \b before "steps" anchors the start; \b after the namespace prevents
  // matching `steps.foo_bar` when renaming `foo`.
  return new RegExp(`\\bsteps\\.${escapeRegex(ns)}\\b`, 'g')
}

/**
 * Rewrite `steps.oldNs.…` → `steps.newNs.…` recursively through any value.
 * Returns a new value tree (does not mutate input). Returns the same reference
 * when no change was made, so callers can cheaply diff.
 */
export function renameStepReferences(value: unknown, oldNs: string, newNs: string): unknown {
  if (oldNs === newNs || !oldNs || !newNs) return value
  const pattern = buildStepsPattern(oldNs)
  const replacement = `steps.${newNs}`
  return walk(value, pattern, replacement)
}

function walk(value: unknown, pattern: RegExp, replacement: string): unknown {
  if (typeof value === 'string') {
    pattern.lastIndex = 0
    if (!pattern.test(value)) return value
    pattern.lastIndex = 0
    return value.replace(pattern, replacement)
  }
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const r = walk(item, pattern, replacement)
      if (r !== item) changed = true
      return r
    })
    return changed ? next : value
  }
  if (value && typeof value === 'object') {
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = walk(v, pattern, replacement)
      if (r !== v) changed = true
      next[k] = r
    }
    return changed ? next : value
  }
  return value
}

/**
 * Count `steps.ns.…` occurrences in a value tree (any depth, any node-config
 * shape). Used to show "N references will be updated" in the rename prompt.
 */
export function countStepReferences(value: unknown, ns: string): number {
  if (!ns) return 0
  const pattern = buildStepsPattern(ns)
  return countWalk(value, pattern)
}

function countWalk(value: unknown, pattern: RegExp): number {
  if (typeof value === 'string') {
    pattern.lastIndex = 0
    const matches = value.match(pattern)
    return matches ? matches.length : 0
  }
  if (Array.isArray(value)) {
    let n = 0
    for (const item of value) n += countWalk(item, pattern)
    return n
  }
  if (value && typeof value === 'object') {
    let n = 0
    for (const v of Object.values(value as Record<string, unknown>)) n += countWalk(v, pattern)
    return n
  }
  return 0
}

/**
 * Returns true if the bare-namespace string equals oldNs. Used for fields
 * that store a raw namespace (no `steps.` prefix) — e.g. `config.fallback_node`.
 */
export function renameFallbackNamespace(value: unknown, oldNs: string, newNs: string): unknown {
  if (oldNs === newNs || !oldNs || !newNs) return value
  if (typeof value === 'string' && value === oldNs) return newNs
  return value
}
