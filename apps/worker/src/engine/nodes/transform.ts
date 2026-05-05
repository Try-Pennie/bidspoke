/**
 * Transform node — PRD Section 5.7
 *
 * Visual data reshaping: takes prior step output and produces a new object
 * from an explicit mapping list. Only mapped fields appear in output.
 *
 * Config: { mappings: Array<{ source: string; target: string }> }
 * Output: assembled JSONB object
 *
 * Source formats:
 *   steps.ns.output.field          — dot-path reference
 *   steps.ns.output.list[0].field  — array index
 *   steps.ns.output.list[*].field  — map over array → produces array
 *   trigger.payload.field          — trigger payload reference
 *   env.KEY                        — environment variable
 *   "static string"                — string literal
 *   42 / 3.14 / -1                 — number literal
 *   true / false / null            — boolean/null literal
 *   steps.x.output.amount * 0.85  — simple arithmetic expression
 */

import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'

// ── Config ────────────────────────────────────────────────────────────────────

interface TransformMapping {
  source: string
  target: string
}

interface TransformConfig {
  mappings?: TransformMapping[]
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function executeTransformNode(
  node: NodeDefinition,
  ctx: ExecutionContext
): StepExecutionResult {
  const config = node.config as unknown as TransformConfig
  const mappings = config.mappings ?? []

  const output: Record<string, unknown> = {}

  for (const { source, target } of mappings) {
    if (!source || !target) continue
    const value = resolveSource(source.trim(), ctx)
    setNestedPath(output, target.trim(), value)
  }

  return { output }
}

// ── Source resolution ─────────────────────────────────────────────────────────

export function resolveSource(source: string, ctx: ExecutionContext): unknown {
  // 1. Static literals
  if (
    (source.startsWith('"') && source.endsWith('"')) ||
    (source.startsWith("'") && source.endsWith("'"))
  ) {
    return source.slice(1, -1)
  }
  if (/^-?\d+(\.\d+)?$/.test(source)) return parseFloat(source)
  if (source === 'true') return true
  if (source === 'false') return false
  if (source === 'null') return null

  // 2. Array [*] map-over — expand entire array
  if (source.includes('[*]')) {
    const starIdx = source.indexOf('[*]')
    const prefix = source.slice(0, starIdx)
    const suffix = source.slice(starIdx + 3)  // after [*]
    const arr = resolveContextPath(prefix, ctx)
    if (!Array.isArray(arr)) return []
    if (!suffix) return arr
    const itemPath = suffix.startsWith('.') ? suffix.slice(1) : suffix
    const itemParts = splitPath(itemPath)
    return arr.map((item) => resolvePathOnValue(item, itemParts))
  }

  // 3. Plain dot-path (handles [n] array indices)
  if (/^[\w.[\]]+$/.test(source)) {
    return resolveContextPath(source, ctx)
  }

  // 4. Expression — substitute context references, evaluate with Function constructor
  return evaluateTransformExpression(source, ctx)
}

// ── Context path resolution ───────────────────────────────────────────────────

function resolveContextPath(path: string, ctx: ExecutionContext): unknown {
  if (!path) return undefined
  const segments = splitPath(path)
  if (segments.length === 0) return undefined

  if (segments[0] === 'trigger') {
    return resolvePathOnValue(ctx.trigger, segments.slice(1))
  }
  if (segments[0] === 'steps') {
    const ns = segments[1]
    if (!ns) return undefined
    const step = ctx.steps[ns]
    if (!step) return undefined
    if (segments.length === 2) return step.output
    // Tolerate explicit `.output` — matches graph.ts/context.ts and the
    // copy-path format from the JSON tree. `steps.X.output.Y` and
    // `steps.X.Y` resolve identically.
    const rest = segments[2] === 'output' ? segments.slice(3) : segments.slice(2)
    if (rest.length === 0) return step.output
    return resolvePathOnValue(step.output, rest)
  }
  if (segments[0] === 'env') {
    const key = segments[1]
    return key ? ctx.env[key] : undefined
  }
  return undefined
}

/**
 * Split a dot-path into segments, preserving array index notation.
 * "steps.ns.output.list[0].field" → ["steps", "ns", "output", "list[0]", "field"]
 */
function splitPath(path: string): string[] {
  return path.split('.').filter(Boolean)
}

function resolvePathOnValue(obj: unknown, parts: string[]): unknown {
  for (const part of parts) {
    if (obj === null || obj === undefined) return undefined
    // Array index: "list[0]" or just "[0]"
    const arrMatch = part.match(/^([^[]*)\[(\d+)\]$/)
    if (arrMatch) {
      const key = arrMatch[1]
      const idx = parseInt(arrMatch[2])
      const base = key ? (obj as Record<string, unknown>)[key] : obj
      obj = Array.isArray(base) ? base[idx] : undefined
    } else {
      obj = (obj as Record<string, unknown>)[part]
    }
  }
  return obj
}

// ── Expression evaluation ─────────────────────────────────────────────────────

/**
 * Evaluate a simple expression with context references substituted as variables.
 * E.g. "steps.bid.output.amount * 0.85" resolves the path, then evaluates the math.
 */
function evaluateTransformExpression(expr: string, ctx: ExecutionContext): unknown {
  // Match path references: steps.ns.*, trigger.*, env.*
  const pathPattern =
    /\b((?:steps\.[a-zA-Z_][a-zA-Z0-9_]*|trigger|env)(?:\.[a-zA-Z0-9_]+(?:\[\d+\])?)*)/g

  const seen = new Map<string, string>()       // path → varName
  const values: unknown[] = []

  const substituted = expr.replace(pathPattern, (match) => {
    if (seen.has(match)) return seen.get(match)!
    const varName = `__ref${seen.size}`
    seen.set(match, varName)
    values.push(resolveContextPath(match, ctx))
    return varName
  })

  try {
    const paramNames = ['Math', ...seen.values()]
    const paramValues: unknown[] = [Math, ...values]
    // eslint-disable-next-line no-new-func
    const fn = new Function(...paramNames, `return (${substituted})`)
    return fn(...paramValues)
  } catch {
    return undefined
  }
}

// ── Target path setter ────────────────────────────────────────────────────────

/**
 * Set a value at a dot-path target within an output object.
 * "applicant.name" → output.applicant.name = value
 */
export function setNestedPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split('.').filter(Boolean)
  if (parts.length === 0) return
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (typeof cur[key] !== 'object' || cur[key] === null) {
      cur[key] = {}
    }
    cur = cur[key] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}
