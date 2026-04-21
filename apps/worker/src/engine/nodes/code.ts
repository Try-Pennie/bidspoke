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

  const rawEnv = env as unknown as Record<string, unknown>
  const cfSecrets: Record<string, string> = {}
  for (const key of Object.keys(rawEnv)) {
    if (typeof rawEnv[key] === 'string') cfSecrets[key] = rawEnv[key] as string
  }
  const mergedEnv = { ...cfSecrets, ...ctx.env }

  const res = await binding.fetch('https://worker/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payload: ctx.trigger.payload,
      steps: ctx.steps,
      env: mergedEnv,
      execution: { trace_id: ctx.trigger.trace_id },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Code node "${node.namespace}" failed (HTTP ${res.status}): ${text}`)
  }

  const output: unknown = await res.json()

  // Detect early-exit sentinels emitted by translated Pipedream code:
  //   $.respond({...})  → return { response: { status, body, headers? } }
  //   $.flow.exit(...)  → return { exit: true, reason: ... }
  if (output !== null && typeof output === 'object') {
    const obj = output as Record<string, unknown>
    if ('response' in obj && obj.response !== null && typeof obj.response === 'object') {
      const r = obj.response as { status?: number; body?: unknown; headers?: Record<string, string> }
      if (obj.continueExecution === true) {
        return { output, earlyResponse: { status: r.status ?? 200, body: r.body ?? null, headers: r.headers }, continueAfterResponse: true }
      }
      return { output, earlyResponse: { status: r.status ?? 200, body: r.body ?? null, headers: r.headers } }
    }
    if (obj.exit === true) {
      return { output, earlyExit: true }
    }
  }

  return { output }
}
