// Deploys code node scripts to the bidspoke-code-nodes dispatch namespace.
// Called on every workflow save that contains code nodes.
// Worker name is deterministic: bs-{workflow_id[0..7]}-{namespace}

import type { WorkflowDefinition } from '../types'

const NAMESPACE = 'bidspoke-code-nodes'

/** Returns the dispatch-namespace worker name for a given code node. */
export function codeWorkerName(workflowId: string, namespace: string): string {
  // Max 64 chars; UUIDs are 36 chars, namespace is typically short
  return `bs-${workflowId.slice(0, 8)}-${namespace}`.slice(0, 64)
}

/** Wraps a user script body into a deployable Worker module. */
function buildWorkerScript(script: string): string {
  return `export default {
  async fetch(request) {
    const { payload, steps, env, execution } = await request.json()
    const fn = async (payload, steps, env, execution) => {
${script.split('\n').map((l) => `      ${l}`).join('\n')}
    }
    const result = await fn(payload, steps, env, execution)
    return Response.json(result)
  }
}`
}

/**
 * Deploys all code nodes in a workflow definition to the dispatch namespace.
 * Skips nodes with empty scripts. Fires-and-forgets non-critical failures.
 */
export async function deployCodeNodes(
  workflowId: string,
  definition: WorkflowDefinition,
  accountId: string | undefined,
  apiToken: string | undefined
): Promise<void> {
  if (!accountId || !apiToken) {
    console.warn('[code-deployer] Skipping — CLOUDFLARE_ACCOUNT_ID/API_TOKEN not configured')
    return
  }

  const codeNodes = definition.nodes.filter((n) => n.type === 'code' && (n.config?.script as string | undefined)?.trim())

  for (const node of codeNodes) {
    const script = node.config.script as string
    const workerName = codeWorkerName(workflowId, node.namespace)
    const workerScript = buildWorkerScript(script)

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${NAMESPACE}/scripts/${workerName}`

    const formData = new FormData()
    formData.append('metadata', JSON.stringify({ main_module: 'script.js' }))
    formData.append('script.js', new Blob([workerScript], { type: 'application/javascript+module' }), 'script.js')

    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiToken}` },
      body: formData,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[code-deployer] Failed to deploy "${workerName}": ${res.status} ${body}`)
    } else {
      console.log(`[code-deployer] Deployed "${workerName}"`)
    }
  }
}
