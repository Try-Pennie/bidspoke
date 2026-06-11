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

import type { NodeDefinition, ExecutionContext, StepExecutionResult, ResolvedStepInput } from '../../types'
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
  const status = resolveStatus(config.status_code, ctx)
  const headers = resolveHeaders(config.headers, ctx)
  const body = resolveValue(config.body ?? null, ctx)

  const output = { status, headers, body }
  const resolvedInput: ResolvedStepInput = {
    template: { status_code: config.status_code, headers: config.headers, body: config.body, continue_after_response: config.continue_after_response },
    resolved: { status, headers, body },
  }

  if (config.continue_after_response) {
    return {
      output,
      earlyResponse: { status, headers, body },
      continueAfterResponse: true,
      resolvedInput,
    }
  }

  return { output, resolvedInput }
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
    out[key] = typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved)
  }
  return out
}

function resolveStatus(raw: unknown, ctx: ExecutionContext): number {
  if (raw === undefined || raw === null) return 200
  const resolved = typeof raw === 'string' ? resolveValue(raw, ctx) : raw
  if (typeof resolved === 'number' && Number.isFinite(resolved)) return Math.trunc(resolved)
  if (typeof resolved === 'string') {
    const n = parseInt(resolved, 10)
    if (Number.isFinite(n)) return n
  }
  return 200
}
