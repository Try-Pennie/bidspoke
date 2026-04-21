import type { ExecutionContext, StepOutput } from '../types'

export function buildContext(
  triggerPayload: unknown,
  source: string,
  workflowId: string,
  traceId: string,
  envVars: Record<string, string>,
  orgId: string
): ExecutionContext {
  return {
    trigger: { payload: triggerPayload, source, workflow_id: workflowId, trace_id: traceId, org_id: orgId },
    steps: {},
    env: envVars,
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
  const parts = expr.split('.')
  if (parts[0] === 'env' && parts[1]) {
    return ctx.env[parts[1]]
  }
  if (parts[0] === 'trigger') {
    return getPath(ctx.trigger, parts.slice(1))
  }
  if (parts[0] === 'steps' && parts[1]) {
    const step = ctx.steps[parts[1]]
    if (!step) return undefined
    if (parts.length === 2) return step.output
    return getPath(step.output, parts.slice(2))
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

export function recordStepOutput(
  ctx: ExecutionContext,
  namespace: string,
  result: StepOutput
): void {
  ctx.steps[namespace] = result
}

function getPath(obj: unknown, parts: string[]): unknown {
  return parts.reduce<unknown>((cur, key) => {
    if (cur !== null && typeof cur === 'object') {
      return (cur as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}
