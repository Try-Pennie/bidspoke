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
    return `    ${JSON.stringify(namespace)}: async (payload, steps, env, execution, console, props) => {
      const trigger = { payload }
      const process = { env }
      props = props || {}
${indented}
    },`
  }).join('\n')

  return `const scripts = {
${entries}
}

// Per-call console capture. Each invocation gets its own buffer; the user's
// console.{log,info,warn,error,debug} calls are captured here, then returned
// alongside the script result so the engine can persist them to the step row.
// Capped at 200 entries / 50KB to keep step-row writes bounded — anything past
// the cap drops with a single [truncated] marker.
const LOG_MAX_ENTRIES = 200
const LOG_MAX_BYTES = 50000
function makeConsole() {
  const entries = []
  let bytes = 0
  let truncated = false
  function fmt(arg) {
    if (arg === undefined) return 'undefined'
    if (arg === null) return 'null'
    if (typeof arg === 'string') return arg
    try { return JSON.stringify(arg) } catch { return String(arg) }
  }
  function push(level, args) {
    if (truncated) return
    const message = Array.from(args).map(fmt).join(' ')
    const entry = { level, message, ts: new Date().toISOString() }
    const size = message.length + 30
    if (entries.length >= LOG_MAX_ENTRIES || bytes + size > LOG_MAX_BYTES) {
      entries.push({ level: 'warn', message: '[truncated: console output exceeded limit]', ts: new Date().toISOString() })
      truncated = true
      return
    }
    entries.push(entry)
    bytes += size
  }
  return {
    captured: entries,
    api: {
      log:   function () { push('log',   arguments) },
      info:  function () { push('info',  arguments) },
      warn:  function () { push('warn',  arguments) },
      error: function () { push('error', arguments) },
      debug: function () { push('debug', arguments) },
    },
  }
}

// Run a single registered script by namespace, capturing its console output.
async function runOne(ns, payload, steps, env, execution) {
  const fn = scripts[ns]
  if (!fn) throw new Error('script not found: ' + ns)
  const c = makeConsole()
  const output = await fn(payload, steps, env, execution, c.api)
  return { output, logs: c.captured }
}

// Detect a code-node sentinel in a returned value. Matches the engine's
// single-step sentinel detection; used to short-circuit a chain when any
// step requests respond-and-exit / exit / respond-and-continue.
function detectSentinel(output) {
  if (output === null || typeof output !== 'object') return null
  if ('response' in output && output.response !== null && typeof output.response === 'object') {
    return { kind: 'response', continueAfter: output.continueExecution === true }
  }
  if (output.exit === true) return { kind: 'exit', continueAfter: false }
  return null
}

export default {
  async fetch(request) {
    const url = new URL(request.url)

    // /execute-chain — runs N adjacent code nodes sequentially in one subrequest,
    // threading each step's output into the next step's steps context. Main
    // worker dispatches here when it detects a run of plain code nodes, saving
    // N-1 HTTP round-trips. Short-circuits on any sentinel (exit, response, or
    // response+continueExecution — the main worker handles continueExecution
    // semantics; this endpoint just stops further steps in the chain).
    if (url.pathname === '/execute-chain') {
      const { chain, payload, steps, env, execution } = await request.json()
      const results = []
      const stepsCtx = steps ?? {}
      for (const entry of chain) {
        const namespace = entry.namespace
        const props = entry.props || {}
        const startMs = Date.now()
        const c = makeConsole()
        try {
          const fn = scripts[namespace]
          if (!fn) throw new Error('script not found: ' + namespace)
          const output = await fn(payload, stepsCtx, env, execution, c.api, props)
          const durationMs = Date.now() - startMs
          const sentinel = detectSentinel(output)
          stepsCtx[namespace] = { output: output ?? null, status: 'completed' }
          results.push({ namespace, status: 'completed', output: output ?? null, logs: c.captured, durationMs, sentinel })
          // Stop the chain on any sentinel — main worker decides what happens next
          if (sentinel) break
        } catch (err) {
          const durationMs = Date.now() - startMs
          results.push({ namespace, status: 'failed', error: String(err && err.message ? err.message : err), logs: c.captured, durationMs })
          break
        }
      }
      return Response.json({ __bsv: 1, results })
    }

    const match = url.pathname.match(/^\\/execute\\/([^/]+)$/)
    if (!match) {
      return new Response(JSON.stringify({ error: 'route must be /execute/{namespace}' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    }
    const ns = match[1]
    const fn = scripts[ns]
    if (!fn) {
      return new Response(JSON.stringify({ error: 'script not found: ' + ns }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    }
    const { payload, steps, env, execution, props } = await request.json()
    const c = makeConsole()
    try {
      const output = await fn(payload, steps, env, execution, c.api, props || {})
      return Response.json({ __bsv: 1, output: output ?? null, logs: c.captured })
    } catch (err) {
      // Surface the real script error as a 500 JSON response so the engine's
      // dispatchWithFallback treats it as bundle-present-with-error and reports
      // the actual message, not a misleading "Worker not found" fallback miss.
      const message = err && err.message ? err.message : String(err)
      return new Response(JSON.stringify({ __bsv: 1, error: message, logs: c.captured }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }
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
