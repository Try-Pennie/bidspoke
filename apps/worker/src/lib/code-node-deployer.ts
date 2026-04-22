// Deploys a single bundled Worker per workflow containing all code node scripts,
// routed internally by namespace path (/execute/{namespace}). On workflow save,
// this replaces the old per-node worker deployment — eliminating N-1 subrequest
// roundtrips per execution and cutting deploy time.
//
// Name conventions in the bidspoke-code-nodes dispatch namespace:
//   bs-wf-{workflowId[0..8]}           bundled worker (new)
//   bs-{workflowId[0..8]}-{namespace}  per-node worker (legacy, fallback only)
//
// Old per-node workers created before the bundle rollout stay orphaned in the
// dispatch namespace. The executor falls back to them if the bundle is missing,
// which keeps unmigrated workflows working until the migration endpoint has
// been run for every active workflow. A cleanup job can delete orphans later.

import type { WorkflowDefinition, NodeDefinition } from '../types'

const NAMESPACE = 'bidspoke-code-nodes'
// Cloudflare's limit is 1MB compressed; stay under to avoid hitting it with
// whitespace or minor growth between deploys.
const MAX_SCRIPT_BYTES = 900_000

/** Bundled worker name for a workflow (current layout). */
export function codeBundleName(workflowId: string): string {
  return `bs-wf-${workflowId.slice(0, 8)}`.slice(0, 64)
}

/** Legacy per-node worker name — kept so the executor can fall back during migration. */
export function codeWorkerName(workflowId: string, namespace: string): string {
  return `bs-${workflowId.slice(0, 8)}-${namespace}`.slice(0, 64)
}

/**
 * Wraps all user scripts for a workflow into a single Worker module with a
 * path-routed dispatcher. Each user script gets its own closure with the same
 * (payload, steps, env, execution) contract as the old per-node worker plus
 * the synthesized `trigger` / `process` locals.
 */
export function buildBundledWorkerScript(scripts: Array<{ namespace: string; script: string }>): string {
  const entries = scripts.map(({ namespace, script }) => {
    const indented = script.split('\n').map((l) => `      ${l}`).join('\n')
    return `    ${JSON.stringify(namespace)}: async (payload, steps, env, execution) => {
      const trigger = { payload }
      const process = { env }
${indented}
    },`
  }).join('\n')

  return `const scripts = {
${entries}
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const match = url.pathname.match(/^\\/execute\\/([^/]+)$/)
    if (!match) {
      return new Response(JSON.stringify({ error: 'route must be /execute/{namespace}' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    }
    const ns = match[1]
    const fn = scripts[ns]
    if (!fn) {
      return new Response(JSON.stringify({ error: 'script not found: ' + ns }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    }
    const { payload, steps, env, execution } = await request.json()
    const result = await fn(payload, steps, env, execution)
    return Response.json(result ?? null)
  }
}`
}

export interface DeployResult {
  namespace: string
  error?: string
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Deploys all code nodes in a workflow as a single bundled Worker.
 * Returns one DeployResult per code node namespace so the UI can surface
 * per-node errors uniformly; a bundle-level error applies to every node
 * in that bundle equally.
 *
 * Passing `cache` enables hash-and-skip: if the current bundle's SHA-256
 * matches the hash stored at `deployed-hash-{workflowId}`, the CF API
 * upload is skipped. TTL is 24h so out-of-band worker deletions self-heal
 * within a day. The admin migration endpoint deliberately omits `cache` to
 * force a redeploy.
 */
export async function deployCodeNodes(
  workflowId: string,
  definition: WorkflowDefinition,
  accountId: string | undefined,
  apiToken: string | undefined,
  cache?: KVNamespace
): Promise<DeployResult[]> {
  if (!accountId || !apiToken) {
    console.warn('[code-deployer] Skipping — CLOUDFLARE_ACCOUNT_ID/API_TOKEN not configured')
    return []
  }

  const codeNodes = definition.nodes.filter((n): n is NodeDefinition => {
    const script = n.config?.script as string | undefined
    return n.type === 'code' && typeof script === 'string' && script.trim().length > 0
  })
  if (codeNodes.length === 0) return []

  const scripts = codeNodes.map((n) => ({
    namespace: n.namespace,
    script: n.config.script as string,
  }))

  const workerScript = buildBundledWorkerScript(scripts)
  const scriptBytes = new TextEncoder().encode(workerScript).length

  if (scriptBytes > MAX_SCRIPT_BYTES) {
    const err = `Bundled code exceeds ${MAX_SCRIPT_BYTES} bytes (${scriptBytes}). Shrink scripts or split the workflow.`
    console.error(`[code-deployer] ${err}`)
    return codeNodes.map((n) => ({ namespace: n.namespace, error: err }))
  }

  // Hash-and-skip: if the current bundle matches what's already deployed,
  // we don't need to re-upload. Saves ~200-500ms per test click.
  const hashKey = `deployed-hash-${workflowId}`
  const scriptHash = cache ? await sha256Hex(workerScript) : undefined
  if (cache && scriptHash) {
    const cachedHash = await cache.get(hashKey)
    if (cachedHash === scriptHash) {
      console.log(`[code-deployer] Skipping upload — bundle unchanged (${codeNodes.length} nodes, ${scriptBytes} bytes)`)
      return codeNodes.map((n) => ({ namespace: n.namespace }))
    }
  }

  const workerName = codeBundleName(workflowId)
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
    let errorMessage: string
    try {
      const parsed = JSON.parse(body) as { errors?: { message?: string }[] }
      errorMessage = parsed.errors?.[0]?.message ?? `HTTP ${res.status}`
    } catch {
      errorMessage = body || `HTTP ${res.status}`
    }
    console.error(`[code-deployer] Failed to deploy bundle "${workerName}": ${errorMessage}`)
    return codeNodes.map((n) => ({ namespace: n.namespace, error: errorMessage }))
  }

  console.log(`[code-deployer] Deployed bundle "${workerName}" (${codeNodes.length} nodes, ${scriptBytes} bytes)`)

  // Cache the hash so subsequent deploys with identical bundles can skip upload
  if (cache && scriptHash) {
    await cache.put(hashKey, scriptHash, { expirationTtl: 86400 }).catch(() => undefined)
  }

  return codeNodes.map((n) => ({ namespace: n.namespace }))
}
