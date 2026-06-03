import type { ExecutionContext, StepOutput } from '../types'

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
  // Simple single-expression template: "{{expr}}"
  const match = template.match(/^\{\{(.+?)\}\}$/)
  if (match) {
    return resolveExpression(match[1].trim(), ctx)
  }
  // Inline interpolation: "Hello {{trigger.payload.name}}"
  return template.replace(/\{\{(.+?)\}\}/g, (_, expr) => {
    const val = resolveExpression(expr.trim(), ctx)
    return val !== undefined ? String(val) : ''
  })
}

function resolveExpression(expr: string, ctx: ExecutionContext): unknown {
  // Coalesce / fallback: "a ?? b ?? c" resolves to the first operand that isn't
  // null/undefined. Lets one reference read whichever of two steps actually ran
  // (e.g. a duplicated node: `steps.engine_no_bids_call_1.output.x ?? steps.engine_no_bids_call.output.x`).
  // Uses ?? semantics so a real `false`/`0`/'' is kept, not skipped.
  if (expr.includes('??')) {
    for (const part of expr.split('??')) {
      const v = resolveExpression(part.trim(), ctx)
      if (v !== null && v !== undefined) return v
    }
    return undefined
  }
  const parts = expr.split('.')
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
    const step = ctx.steps[parts[1]]
    if (!step) return undefined
    if (parts.length === 2) return step.output
    // Tolerate explicit `.output` — matches the copy-path format from the JSON tree
    // and the code-node-script convention. `{{steps.X.output}}` and `{{steps.X.output.Y}}`
    // resolve the same as `{{steps.X}}` and `{{steps.X.Y}}`.
    const pathParts = parts[2] === 'output' ? parts.slice(3) : parts.slice(2)
    if (pathParts.length === 0) return step.output
    return getPath(step.output, pathParts)
  }
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
