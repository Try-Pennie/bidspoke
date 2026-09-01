import { stepReferencePattern } from '@bidspoke/references'

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

// The pattern comes from the shared reference parser (#433), so the syntax this
// REWRITES is the syntax the engine RESOLVES. A rename tool with its own idea of
// what a reference looks like either misses references (leaving them pointing at
// a namespace that no longer exists) or rewrites text that is not one.
const buildStepsPattern = stepReferencePattern

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

// Config fields that store a raw namespace (no `steps.` prefix), so they aren't
// caught by renameStepReferences/countStepReferences. They must be rewritten and
// counted on a step rename or they silently break at runtime:
//   - fallback_node:    on_error fallback target.
//   - parallel_source:  a node reading ctx.steps[config.parallel_source] throws
//                       if the referenced step was renamed.
const BARE_NAMESPACE_FIELDS = ['fallback_node', 'parallel_source'] as const

/**
 * How many bare-namespace config fields point at `ns`. Used so a rename that
 * only touches these fields still prompts (instead of taking the silent path).
 */
export function countBareNamespaceRefs(config: unknown, ns: string): number {
  if (!ns || !config || typeof config !== 'object') return 0
  let n = 0
  for (const field of BARE_NAMESPACE_FIELDS) {
    if ((config as Record<string, unknown>)[field] === ns) n += 1
  }
  return n
}

/**
 * Rewrite every bare-namespace config field equal to oldNs → newNs. Returns a
 * new config only when something changed (same reference otherwise).
 */
export function renameBareNamespaceFields(config: unknown, oldNs: string, newNs: string): unknown {
  if (oldNs === newNs || !oldNs || !newNs || !config || typeof config !== 'object') return config
  let changed = false
  const out: Record<string, unknown> = { ...(config as Record<string, unknown>) }
  for (const field of BARE_NAMESPACE_FIELDS) {
    if (out[field] === oldNs) {
      out[field] = newNs
      changed = true
    }
  }
  return changed ? out : config
}

/**
 * Rename a bare namespace within a list of namespaces — e.g. the trigger's
 * `success_node_namespaces`. Returns a new array only when something changed.
 */
export function renameNamespaceInList(value: unknown, oldNs: string, newNs: string): unknown {
  if (oldNs === newNs || !oldNs || !newNs || !Array.isArray(value) || !value.includes(oldNs)) return value
  return value.map((v) => (v === oldNs ? newNs : v))
}
