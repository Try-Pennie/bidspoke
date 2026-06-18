/**
 * Webhook node — PRD Section 5.5
 *
 * Generic HTTP step with service-aware presets for Equifax, Eligibility Scout,
 * LendSwift, Salesforce, and custom endpoints.
 *
 * Config: { service, action?, url, method?, headers?, body?, auth? }
 * Output: { status, body, headers }
 *
 * Auth credentials should be referenced via {{env.SECRET_NAME}}. Non-secret env
 * vars come from ctx.env (Supabase environment_variables); Cloudflare secrets
 * injected via `wrangler secret put` are merged in at execution time. CF bindings
 * take precedence over same-named Supabase env vars.
 *
 * On non-2xx: throws a Response instance so engine.ts classifies the HTTP error
 * via classifyHttpError() — same pattern as partner-bid node.
 */

import type { NodeDefinition, ExecutionContext, StepExecutionResult, ResolvedStepInput } from '../../types'
import type { Env } from '../../index'
import { resolveValue, warnDroppedBodyFields } from '../context'
import { linkAbort } from '../retry'
import { isShadowDryRun, shadowIntegrationStub } from '../shadow'

// ── Config ────────────────────────────────────────────────────────────────────

type AuthType = 'none' | 'bearer' | 'basic' | 'api_key'

interface IntegrationAuth {
  type: AuthType
  // bearer
  token?: string
  // basic
  username?: string
  password?: string
  // api_key
  header?: string    // header name, defaults to 'X-API-Key'
  key?: string
}

interface IntegrationConfig {
  service?: string      // 'equifax' | 'eligibility_scout' | 'lendswift' | 'salesforce' | 'custom'
  action?: string       // label only — used for display and circuit breaker naming
  url: string           // template-enabled: {{env.SERVICE_URL}} or literal
  method?: string       // GET | POST | PUT | PATCH | DELETE; default POST
  headers?: Record<string, string>  // template-enabled values
  body?: unknown        // template-enabled JSON body (omitted for GET/HEAD)
  auth?: IntegrationAuth
  timeout_ms?: number
}

// ── Output ────────────────────────────────────────────────────────────────────

export interface IntegrationOutput {
  status: number
  body: unknown
  headers: Record<string, string>
}

// Header names whose values must never be persisted to step logs. Includes the
// standard auth-bearing headers; the node's configured api_key header name is
// added dynamically (see maskHeadersForLog). The real values still go on the
// wire — only the logged/displayed copy in resolvedInput is masked.
const SENSITIVE_HEADER_KEYS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization'])
const REDACTED = '[redacted]'

function maskHeadersForLog(
  headers: Record<string, string>,
  apiKeyHeader?: string,
): Record<string, string> {
  const sensitive = new Set(SENSITIVE_HEADER_KEYS)
  if (apiKeyHeader) sensitive.add(apiKeyHeader.toLowerCase())
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = sensitive.has(k.toLowerCase()) ? REDACTED : v
  }
  return out
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function executeIntegrationNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env,
  signal?: AbortSignal
): Promise<StepExecutionResult> {
  const config = node.config as unknown as IntegrationConfig

  if (!config.url) {
    throw new Error('Webhook node requires config.url')
  }

  // Shadow dry-run: don't make the outbound call.
  if (isShadowDryRun(ctx)) return shadowIntegrationStub()

  // Merge CF secrets (string-valued bindings) into env so {{env.SECRET}} resolves.
  // CF secrets are not in ctx.env (which only has non-secret Supabase vars).
  const rawEnv = env as unknown as Record<string, unknown>
  const cfSecrets: Record<string, string> = {}
  for (const key of Object.keys(rawEnv)) {
    if (typeof rawEnv[key] === 'string') cfSecrets[key] = rawEnv[key] as string
  }
  // CF bindings take precedence over same-named Supabase env vars
  const enrichedCtx: ExecutionContext = { ...ctx, env: { ...ctx.env, ...cfSecrets } }

  const method = (config.method ?? 'POST').toUpperCase()
  const timeoutMs = config.timeout_ms ?? 15000

  // Resolve URL
  const resolvedUrl = String(resolveValue(config.url, enrichedCtx) ?? '')
  if (!resolvedUrl) throw new Error('Webhook node: url resolved to empty string')

  // Build headers — start with Content-Type + trace ID, merge config headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Trace-Id': ctx.trigger.trace_id,
  }
  if (config.headers) {
    const resolved = resolveValue(config.headers, enrichedCtx) as Record<string, unknown>
    for (const [k, v] of Object.entries(resolved)) {
      if (v !== undefined && v !== null) headers[k] = String(v)
    }
  }

  // Auth header
  const auth = config.auth
  if (auth && auth.type !== 'none') {
    if (auth.type === 'bearer' && auth.token) {
      const token = String(resolveValue(auth.token, enrichedCtx) ?? '')
      if (token) headers['Authorization'] = `Bearer ${token}`
    } else if (auth.type === 'basic') {
      const username = String(resolveValue(auth.username ?? '', enrichedCtx) ?? '')
      const password = String(resolveValue(auth.password ?? '', enrichedCtx) ?? '')
      // btoa is available globally in CF Workers runtime
      headers['Authorization'] = `Basic ${btoa(`${username}:${password}`)}`
    } else if (auth.type === 'api_key' && auth.key) {
      const headerName = auth.header ?? 'X-API-Key'
      const keyValue = String(resolveValue(auth.key, enrichedCtx) ?? '')
      if (keyValue) headers[headerName] = keyValue
    }
  }

  // Resolve body (skipped for GET/HEAD)
  let bodyStr: string | undefined
  let resolvedBodyForInput: unknown = undefined
  const warnLogs: import('../../types').StepLogEntry[] = []
  if (method !== 'GET' && method !== 'HEAD' && config.body !== undefined) {
    const resolvedBody = resolveValue(config.body, enrichedCtx)
    resolvedBodyForInput = resolvedBody
    warnLogs.push(...warnDroppedBodyFields(resolvedBody, {
      nodeNamespace: node.namespace,
      nodeLabel: node.label,
      traceId: ctx.trigger.trace_id,
    }))
    if (resolvedBody !== null && resolvedBody !== undefined) {
      bodyStr = typeof resolvedBody === 'string' ? resolvedBody : JSON.stringify(resolvedBody)
    }
  }

  const resolvedInput: ResolvedStepInput = {
    template: {
      service: config.service,
      action: config.action,
      url: config.url,
      method: config.method,
      headers: config.headers,
      body: config.body,
      auth: config.auth ? { type: config.auth.type } : undefined,
    },
    resolved: {
      method,
      url: resolvedUrl,
      // Mask auth-bearing headers — resolvedInput is persisted to execution_steps
      // and rendered in the Results panel, and PII redaction ships disabled, so
      // the raw token/key would otherwise sit in plaintext in the warm log tier.
      headers: maskHeadersForLog(headers, auth?.type === 'api_key' ? (auth.header ?? 'X-API-Key') : undefined),
      body: resolvedBodyForInput,
    },
  }

  // Fetch with timeout
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  linkAbort(controller, signal)  // also cancel on the step-level timeout (#66)

  let res: Response
  try {
    res = await fetch(resolvedUrl, {
      method,
      headers,
      ...(bodyStr !== undefined ? { body: bodyStr } : {}),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  // Parse response — try JSON, fall back to text
  const responseText = await res.text()
  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(responseText)
  } catch {
    parsedBody = responseText
  }

  const responseHeaders: Record<string, string> = {}
  res.headers.forEach((value, key) => { responseHeaders[key] = value })

  // Non-2xx: throw Response so engine classifies the HTTP error
  if (!res.ok) {
    const responseErr = new Response(responseText, { status: res.status, headers: res.headers })
    ;(responseErr as Response & { resolvedInput?: ResolvedStepInput; logs?: import('../../types').StepLogEntry[] }).resolvedInput = resolvedInput
    if (warnLogs.length > 0) {
      (responseErr as Response & { logs?: import('../../types').StepLogEntry[] }).logs = warnLogs
    }
    throw responseErr
  }

  const output: IntegrationOutput = {
    status: res.status,
    body: parsedBody,
    headers: responseHeaders,
  }

  return { output, resolvedInput, ...(warnLogs.length > 0 ? { logs: warnLogs } : {}) }
}
