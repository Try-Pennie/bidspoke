// Code node — user-defined JS/TS executed in a sandboxed Dynamic Worker (PRD Section 5.4)
// Config: { worker_name: string }
// The named worker must exist in the "bidspoke-code-nodes" dispatch namespace.
// Worker receives { payload, steps, env } and must return a JSON-serialisable value.

import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import type { Env } from '../../index'

interface CodeConfig {
  worker_name: string
}

export async function executeCodeNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env
): Promise<StepExecutionResult> {
  const config = node.config as unknown as CodeConfig
  if (!config.worker_name) {
    throw new Error(`Code node "${node.namespace}" is missing worker_name config`)
  }

  const binding = env.DYNAMIC_WORKER_LOADER.get(config.worker_name)

  const res = await binding.fetch('https://worker/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payload: ctx.trigger.payload,
      steps: ctx.steps,
      env: ctx.env,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Code node "${node.namespace}" failed (HTTP ${res.status}): ${text}`)
  }

  const output: unknown = await res.json()
  return { output }
}
