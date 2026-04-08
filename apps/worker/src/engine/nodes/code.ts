// Code node — user-defined JS executed in a sandboxed Dynamic Worker (Workers for Platforms)
// Config: { script: string }
// The script is auto-deployed to the "bidspoke-code-nodes" dispatch namespace on workflow save.
// Worker receives { payload, steps, env } and must return a JSON-serialisable value.

import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import type { Env } from '../../index'
import { codeWorkerName } from '../../lib/code-node-deployer'

export async function executeCodeNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env
): Promise<StepExecutionResult> {
  const script = (node.config?.script as string | undefined)?.trim()
  if (!script) {
    throw new Error(`Code node "${node.namespace}" has no script configured`)
  }

  const workerName = codeWorkerName(ctx.trigger.workflow_id, node.namespace)
  const binding = env.DYNAMIC_WORKER_LOADER.get(workerName)

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
