// Response node — structured HTTP response (PRD Section 5.6)
// Config: { status_code?: number, headers?: Record<string, string>, body?: unknown,
//           continue_after_response?: boolean }
// Body strings support {{...}} template references (trigger, steps, env).
// By default, the engine returns this node's output as the final HTTP response and
// terminates the walk. With continue_after_response: true, the engine sends the
// response immediately and keeps walking the graph (mirrors the code-node
// continueExecution sentinel).

import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import { resolveValue } from '../context'

interface ResponseConfig {
  status_code?: number
  headers?: Record<string, string>
  body?: unknown
  continue_after_response?: boolean
}

export function executeResponseNode(
  node: NodeDefinition,
  ctx: ExecutionContext
): StepExecutionResult {
  const config = node.config as ResponseConfig
  const status = config.status_code ?? 200
  const headers = config.headers ?? {}
  const body = resolveValue(config.body ?? null, ctx)

  const output = { status_code: status, headers, body }

  if (config.continue_after_response) {
    return {
      output,
      earlyResponse: { status, headers, body },
      continueAfterResponse: true,
    }
  }

  return { output }
}
