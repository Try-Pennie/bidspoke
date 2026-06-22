// Response node — structured HTTP response (PRD Section 5.6)
// Config: { status_code?: number, headers?: Record<string, string>, body?: unknown,
//           continue_after_response?: boolean }
// Output: { status, headers, body } — the config key stays status_code (it's
// saved in live workflow definitions), but the OUTPUT key is status, matching
// the integration/salesforce/achieve nodes so {{steps.X.output.status}} works
// against any node type.
// Body strings and header values support {{...}} template references (trigger, steps, env).
// By default, the engine returns this node's output as the final HTTP response and
// terminates the walk. With continue_after_response: true, the engine sends the
// response immediately and keeps walking the graph (mirrors the code-node
// continueExecution sentinel).

import type { NodeDefinition, ExecutionContext, StepExecutionResult, ResolvedStepInput, StepLogEntry } from '../../types'
import { coerceString } from '../../lib/coerce'
import { resolveValue } from '../context'

interface ResponseConfig {
  /** Number or template string ({{steps.X.output.status}}). Resolves to a number;
   *  falls back to 200 on undefined/non-numeric. */
  status_code?: number | string
  headers?: Record<string, string>
  body?: unknown
  continue_after_response?: boolean
}

export function executeResponseNode(
  node: NodeDefinition,
  ctx: ExecutionContext
): StepExecutionResult {
  const config = node.config as ResponseConfig
  const { status, warning } = resolveStatus(config.status_code, ctx)
  const headers = resolveHeaders(config.headers, ctx)
  const body = resolveValue(config.body ?? null, ctx)

  const output = { status, headers, body }
  const resolvedInput: ResolvedStepInput = {
    template: { status_code: config.status_code, headers: config.headers, body: config.body, continue_after_response: config.continue_after_response },
    resolved: { status, headers, body },
  }
  const logs: StepLogEntry[] | undefined = warning
    ? [{ level: 'warn', message: warning, ts: new Date().toISOString() }]
    : undefined

  if (config.continue_after_response) {
    return {
      output,
      earlyResponse: { status, headers, body },
      continueAfterResponse: true,
      resolvedInput,
      ...(logs ? { logs } : {}),
    }
  }

  return { output, resolvedInput, ...(logs ? { logs } : {}) }
}

// Header values are template-resolved and coerced to strings (HTTP headers are
// always strings on the wire). A value whose template resolves to undefined/null
// is omitted entirely — sending "x-submission-id: " would be worse than not
// sending the header at all.
function resolveHeaders(
  raw: Record<string, string> | undefined,
  ctx: ExecutionContext
): Record<string, string> {
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    const resolved = typeof value === 'string' ? resolveValue(value, ctx) : value
    if (resolved === undefined || resolved === null) continue
    out[key] = coerceString(resolved)
  }
  return out
}

// Falls back to 200 when the configured status doesn't resolve to a finite
// number — but a CONFIGURED string that falls back gets a step-level warning.
// A silent 200 is exactly what hid the pre-d0bbc2d key mismatch:
// {{steps.X.output.status}} against a node emitting status_code just returned
// 200 with no signal. An unset status (the common case) stays silent.
function resolveStatus(raw: unknown, ctx: ExecutionContext): { status: number; warning?: string } {
  if (raw === undefined || raw === null) return { status: 200 }
  const resolved = typeof raw === 'string' ? resolveValue(raw, ctx) : raw
  if (typeof resolved === 'number' && Number.isFinite(resolved)) return { status: Math.trunc(resolved) }
  if (typeof resolved === 'string') {
    const n = parseInt(resolved, 10)
    if (Number.isFinite(n)) return { status: n }
  }
  if (typeof raw === 'string') {
    const resolvedDesc = resolved === undefined ? 'undefined' : JSON.stringify(resolved)
    return {
      status: 200,
      warning: `Status template ${JSON.stringify(raw)} resolved to ${resolvedDesc}; responded with the 200 fallback. Check the referenced step output key.`,
    }
  }
  return { status: 200 }
}
