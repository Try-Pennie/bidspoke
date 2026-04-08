// Code node — user-defined JS executed inline via AsyncFunction constructor
// Config: { script: string }
// The script is the body of an async function receiving (payload, steps, env).
// It must return a JSON-serialisable value.

import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import type { Env } from '../../index'

interface CodeConfig {
  script: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<any>

export async function executeCodeNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  _env: Env
): Promise<StepExecutionResult> {
  const config = node.config as unknown as CodeConfig
  if (!config.script?.trim()) {
    throw new Error(`Code node "${node.namespace}" has no script configured`)
  }

  let fn: (...args: unknown[]) => Promise<unknown>
  try {
    fn = new AsyncFunction('payload', 'steps', 'env', config.script)
  } catch (e) {
    throw new Error(`Code node "${node.namespace}" syntax error: ${e instanceof Error ? e.message : String(e)}`)
  }

  const output: unknown = await fn(ctx.trigger.payload, ctx.steps, ctx.env)
  return { output }
}
