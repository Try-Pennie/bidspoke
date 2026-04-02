// Response node — structured HTTP response (PRD Section 5.6)
// Config: { status_code?: number, headers?: Record<string, string>, body?: unknown }
// Body strings support {{...}} template references (trigger, steps, env).
// The engine returns this node's output as the final HTTP response body.

import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import { resolveValue } from '../context'

interface ResponseConfig {
  status_code?: number
  headers?: Record<string, string>
  body?: unknown
}

export function executeResponseNode(
  node: NodeDefinition,
  ctx: ExecutionContext
): StepExecutionResult {
  const config = node.config as ResponseConfig

  return {
    output: {
      status_code: config.status_code ?? 200,
      headers: config.headers ?? {},
      body: resolveValue(config.body ?? null, ctx),
    },
  }
}
