import type { ExecutionContext, StepOutput, StepLogEntry } from '../types'
import { coerceString } from '../lib/coerce'

export function buildContext(
  triggerPayload: unknown,
  source: string,
  workflowId: string,
  traceId: string,
  envVars: Record<string, string>,
  orgId: string,
  executionId?: string,
  appUrl?: string,
  sightingId?: string
): ExecutionContext {
  const trimmedAppUrl = (appUrl ?? '').replace(/\/$/, '')
  const bidspokeLink = trimmedAppUrl && executionId
    ? `${trimmedAppUrl}/workflows/${workflowId}?execution=${executionId}`
    : undefined
  return {
    trigger: { payload: triggerPayload, source, workflow_id: workflowId, trace_id: traceId, org_id: orgId, execution_id: executionId, sighting_id: sightingId },
    steps: {},
    env: envVars,
    execution: { workflow_id: workflowId, trace_id: traceId, execution_id: executionId, bidspoke_link: bidspokeLink },
  }
}

// Resolve {{env.KEY}} and {{steps.namespace.output.field}} references in node variable maps
export function resolveVariables(
  variables: Record<string, string>,
  ctx: ExecutionContext
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {}
  for (const [key, template] of Object.entries(variables)) {
    resolved[key] = resolveTemplate(template, ctx)
  }
  return resolved
}

function resolveTemplate(template: string, ctx: ExecutionContext): unknown {
  // Simple single-expression template: "{{expr}}" — returns the typed value.
  // The capture is restricted to non-brace chars so a concatenation of multiple
  // expressions ("{{a}}{{b}}") is NOT mistaken for one expression: with `.+?`
  // the trailing `$` would force backtracking that swallows the interior `}}{{`,
  // feeding a malformed path to resolveExpression (it resolves to undefined, and
  // JSON serialization then drops the key entirely). Valid expressions never
  // contain `{` or `}`.
  const match = template.match(/^\{\{([^{}]+)\}\}$/)
  if (match) {
    return resolveExpression(match[1].trim(), ctx)
  }
  // Inline interpolation: "Hello {{trigger.payload.name}}"
  return template.replace(/\{\{(.+?)\}\}/g, (_match, expr: string) => {
    const val = resolveExpression(expr.trim(), ctx)
    if (val === undefined) return ''
    if (val === null) return 'null' // preserve historical String(null) coercion
    return coerceString(val)
  })
}

function resolveExpression(expr: string, ctx: ExecutionContext): unknown {
  // Coalesce / fallback: "a ?? b ?? c" resolves to the first operand that isn't
  // null/undefined. Lets one reference read whichever of two steps actually ran
  // (e.g. a duplicated node: `steps.engine_no_bids_call_1.output.x ?? steps.engine_no_bids_call.output.x`).
  // Uses ?? semantics so a real `false`/`0`/'' is kept, not skipped. Lowest
  // precedence: each ?? operand may itself be an arithmetic expression.
  if (expr.includes('??')) {
    for (const part of expr.split('??')) {
      const v = resolveExpression(part.trim(), ctx)
      if (v !== null && v !== undefined) return v
    }
    return undefined
  }

  // Arithmetic: "a * b", "x + 0.65", "bid - fee * 2". Operators MUST be
  // whitespace-separated — payload keys can legally contain `-` (and in theory
  // `+`), so splitting on bare operators would corrupt plain lookups like
  // `trigger.payload.some-key`. Valid references never contain spaces, so a
  // spaced operand/operator alternation is unambiguous.
  const tokens = expr.split(/\s+/)
  if (
    tokens.length >= 3 &&
    tokens.length % 2 === 1 &&
    tokens.every((t, i) => (i % 2 === 1 ? ARITHMETIC_OPS.has(t) : t.length > 0))
  ) {
    return evalArithmetic(tokens, ctx)
  }

  return resolveReference(expr, ctx)
}

const ARITHMETIC_OPS = new Set(['*', '/', '+', '-'])
const NUMBER_LITERAL = /^-?\d+(\.\d+)?$/

/**
 * Evaluate a flat [operand, op, operand, op, ...] token list with standard
 * precedence (* / before + -). Number coercion is strict and the whole
 * expression fails closed to undefined when any operand doesn't resolve to a
 * finite number — preserving the dropped-field warning path, same as an
 * unresolvable plain reference. No parentheses; this is deliberately not a
 * full expression language.
 */
function evalArithmetic(tokens: string[], ctx: ExecutionContext): number | undefined {
  const values: number[] = []
  const ops: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (i % 2 === 1) {
      ops.push(tokens[i])
      continue
    }
    const raw = NUMBER_LITERAL.test(tokens[i]) ? Number(tokens[i]) : Number(resolveReference(tokens[i], ctx))
    if (!Number.isFinite(raw)) return undefined
    values.push(raw)
  }

  // Pass 1: * and / collapse into the left value
  const v2: number[] = [values[0]]
  const o2: string[] = []
  for (let i = 0; i < ops.length; i++) {
    if (ops[i] === '*') v2[v2.length - 1] = v2[v2.length - 1] * values[i + 1]
    else if (ops[i] === '/') v2[v2.length - 1] = v2[v2.length - 1] / values[i + 1]
    else {
      o2.push(ops[i])
      v2.push(values[i + 1])
    }
  }
  // Pass 2: + and - left to right
  let result = v2[0]
  for (let i = 0; i < o2.length; i++) {
    result = o2[i] === '+' ? result + v2[i + 1] : result - v2[i + 1]
  }
  // Division by zero and overflow fail closed rather than serializing
  // Infinity/NaN (JSON.stringify renders those as null).
  return Number.isFinite(result) ? result : undefined
}

/**
 * Resolve a `steps.*` reference against the step outputs. `segments` are the
 * path parts AFTER the `steps` root, so segments[0] is the namespace. Tolerates
 * an explicit `.output` segment after the namespace, matching the copy-path and
 * code-node conventions. Returns the step output, a nested field, or undefined
 * when the namespace or path is absent. Shared by resolveReference and the
 * field-presence capture so both agree on path semantics.
 */
export function resolveStepField(steps: Record<string, StepOutput>, segments: string[]): unknown {
  const ns = segments[0]
  if (!ns) return undefined
  const step = steps[ns]
  if (!step) return undefined
  if (segments.length === 1) return step.output
  const pathParts = segments[1] === 'output' ? segments.slice(2) : segments.slice(1)
  if (pathParts.length === 0) return step.output
  return getPath(step.output, pathParts)
}

/** A plain path reference: env.X, trigger.*, execution.*, steps.* — with
 * optional bracket segments (`map[trigger.payload.key]`, `arr[0]`, `obj['k']`)
 * whose keys resolve before the lookup. */
function resolveReference(expr: string, ctx: ExecutionContext): unknown {
  const segments = splitPathSegments(expr)
  if (!segments) return undefined

  // Resolve bracket segments to concrete keys first, failing closed if any
  // dynamic key doesn't resolve to a string/number.
  const parts: string[] = []
  for (const seg of segments) {
    if (typeof seg === 'string') {
      parts.push(seg)
      continue
    }
    const key = resolveBracketKey(seg.key, ctx)
    if (key === undefined) return undefined
    parts.push(key)
  }

  if (parts[0] === 'env' && parts[1]) {
    return ctx.env[parts[1]]
  }
  if (parts[0] === 'trigger') {
    return getPath(ctx.trigger, parts.slice(1))
  }
  if (parts[0] === 'execution') {
    if (parts.length === 1) return ctx.execution
    return getPath(ctx.execution, parts.slice(1))
  }
  if (parts[0] === 'steps' && parts[1]) {
    return resolveStepField(ctx.steps, parts.slice(1))
  }
  return undefined
}

/**
 * Split a reference into dot segments and bracket segments:
 * `steps.c.map[trigger.payload.k].id` ->
 * ['steps', 'c', 'map', {key: 'trigger.payload.k'}, 'id'].
 * Returns null on malformed input (unclosed bracket, empty segment between
 * dots) so the caller fails closed.
 */
function splitPathSegments(expr: string): Array<string | { key: string }> | null {
  const out: Array<string | { key: string }> = []
  let i = 0
  let current = ''
  while (i < expr.length) {
    const ch = expr[i]
    if (ch === '.') {
      if (current.length === 0) return null
      out.push(current)
      current = ''
      i++
      continue
    }
    if (ch === '[') {
      if (current.length > 0) {
        out.push(current)
        current = ''
      } else if (out.length === 0) {
        return null // expression can't start with a bracket
      }
      const close = expr.indexOf(']', i + 1)
      if (close === -1) return null
      const inner = expr.slice(i + 1, close).trim()
      if (inner.length === 0) return null
      out.push({ key: inner })
      i = close + 1
      // After a bracket: end of string, another bracket, or a dot (consumed here
      // so the next identifier doesn't start with it).
      if (expr[i] === '.') i++
      continue
    }
    current += ch
    i++
  }
  if (current.length > 0) out.push(current)
  if (out.length === 0) return null
  return out
}

/** Bracket key: quoted string literal, numeric index, or a reference resolved
 * against the context (`map[trigger.payload.subAccountUuid]`). */
function resolveBracketKey(inner: string, ctx: ExecutionContext): string | undefined {
  const quoted = inner.match(/^'(.*)'$|^"(.*)"$/)
  if (quoted) return quoted[1] ?? quoted[2]
  if (NUMBER_LITERAL.test(inner)) return inner
  const resolved = resolveExpression(inner, ctx)
  if (typeof resolved === 'string' || typeof resolved === 'number') return String(resolved)
  return undefined
}

// Recursively resolve template references in any value (used by response node body)
export function resolveValue(value: unknown, ctx: ExecutionContext): unknown {
  if (typeof value === 'string') return resolveTemplate(value, ctx)
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, ctx)
    }
    return out
  }
  return value
}

// Find dot-paths in a resolved value whose leaf is `undefined`. These keys
// silently vanish on JSON serialization (JSON.stringify drops undefined-valued
// object keys), so a body field configured with an unresolvable template would
// disappear from the outbound request with no other signal — exactly how a
// dropped Salesforce field went unnoticed. Used to warn at execution time.
export function findUndefinedPaths(value: unknown, base = ''): string[] {
  if (value === undefined) return [base || '(root)']
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findUndefinedPaths(v, base ? `${base}[${i}]` : `[${i}]`))
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      findUndefinedPaths(v, base ? `${base}.${k}` : k)
    )
  }
  return []
}

// Warn when a resolved request body has fields that resolved to `undefined` and
// would be silently dropped on serialization. Emits a structured console.warn
// (for tail/Logpush/alerting) and returns a StepLogEntry[] to surface in the
// execution detail UI. Returns [] when nothing was dropped.
export function warnDroppedBodyFields(
  resolvedBody: unknown,
  meta: { nodeNamespace?: string; nodeLabel?: string; traceId?: string }
): StepLogEntry[] {
  const dropped = findUndefinedPaths(resolvedBody)
  if (dropped.length === 0) return []
  console.warn(
    JSON.stringify({
      event: 'template_field_dropped',
      trace_id: meta.traceId,
      node: meta.nodeLabel ?? meta.nodeNamespace,
      fields: dropped,
    })
  )
  const plural = dropped.length === 1 ? '' : 's'
  return [
    {
      level: 'warn',
      message: `Dropped ${dropped.length} body field${plural} — template resolved to undefined: ${dropped.join(', ')}`,
      ts: new Date().toISOString(),
    },
  ]
}

// Synthetic join nodes (branch_end, parallel_end) are excluded from
// lastCompletedNamespace so terminal-node attribution reflects the last
// real step, not the join marker the workflow happens to converge through.
const END_NODE_TYPES = new Set(['branch_end', 'parallel_end'])

export function recordStepOutput(
  ctx: ExecutionContext,
  namespace: string,
  result: StepOutput,
  nodeType?: string
): void {
  ctx.steps[namespace] = result
  if (result.status === 'completed' && !END_NODE_TYPES.has(nodeType ?? '')) {
    ctx.lastCompletedNamespace = namespace
  }
}

function getPath(obj: unknown, parts: string[]): unknown {
  return parts.reduce<unknown>((cur, key) => {
    if (cur !== null && typeof cur === 'object') {
      return (cur as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}
