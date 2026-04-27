/**
 * Salesforce node — structured Salesforce REST API integration
 *
 * Handles token acquisition via Client Credentials OAuth flow (cached in KV),
 * then executes create / update / upsert / query operations against the
 * Salesforce REST API v60.0.
 *
 * Required env vars (CF secrets or Bidspoke UI):
 *   SALESFORCE_CLIENT_ID
 *   SALESFORCE_CLIENT_SECRET
 *   SALESFORCE_INSTANCE_URL   e.g. https://trypennie.my.salesforce.com
 *
 * Config: { operation, object, body?, record_id?, external_id_field?,
 *           external_id_value?, soql? }
 * Output: { status, body }
 */

import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import type { Env } from '../../index'
import { resolveValue } from '../context'

type SalesforceOperation = 'create' | 'update' | 'upsert' | 'query' | 'apex'

interface ExpectedError {
  code: string
  message_contains?: string
  /** When set, returns this body as the workflow response instead of letting
   * the bare error structure leak through. Template-enabled. */
  response_body?: unknown
  /** HTTP status for the response_body. Defaults to 200. */
  response_status?: number
}

interface SalesforceConfig {
  operation: SalesforceOperation
  object?: string       // SObject API name, e.g. Prospect__c
  body?: unknown        // template-enabled JSON body (create / update / upsert / apex)
  record_id?: string    // template-enabled — required for update
  external_id_field?: string  // upsert: external ID field name
  external_id_value?: string  // upsert: template-enabled external ID value
  soql?: string         // template-enabled SOQL query string
  apex_path?: string    // apex: relative path, e.g. /services/apexrest/prospect-trades
  expected_errors?: ExpectedError[]  // SF rejections treated as business rejections, not failures.
                                     // Matched by errorCode AND optional message substring.
                                     // Step logs as completed and the workflow exits here.
  injected_fields?: Record<string, string>  // create / update / upsert: SF field → template value, merged into body.
                                            // Overrides body on key collision. Resolved per-execution.
                                            // Use {{execution.bidspoke_link}} for the run deeplink.
}

// Token cache TTL slightly under SF default of 3600s to avoid races
const TOKEN_TTL_S = 3500

export async function getSalesforceToken(env: Env, orgId: string, instanceUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const cacheKey = `sf-token-${orgId}`
  const cached = await env.WORKFLOW_CACHE.get(cacheKey)
  if (cached) return cached

  const res = await fetch(`${instanceUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Salesforce token fetch failed (${res.status}): ${text}`)
  }

  const data = await res.json() as { access_token: string }
  await env.WORKFLOW_CACHE.put(cacheKey, data.access_token, { expirationTtl: TOKEN_TTL_S })
  return data.access_token
}

export async function executeSalesforceNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env
): Promise<StepExecutionResult> {
  const config = node.config as unknown as SalesforceConfig

  // Merge CF secrets so {{env.*}} templates resolve
  const rawEnv = env as unknown as Record<string, unknown>
  const cfSecrets: Record<string, string> = {}
  for (const key of Object.keys(rawEnv)) {
    if (typeof rawEnv[key] === 'string') cfSecrets[key] = rawEnv[key] as string
  }
  const enrichedCtx: ExecutionContext = { ...ctx, env: { ...ctx.env, ...cfSecrets } }

  const instanceUrl = (enrichedCtx.env.SALESFORCE_INSTANCE_URL ?? '').replace(/\/$/, '')
  const clientId = enrichedCtx.env.SALESFORCE_CLIENT_ID ?? ''
  const clientSecret = enrichedCtx.env.SALESFORCE_CLIENT_SECRET ?? ''

  if (!instanceUrl || !clientId || !clientSecret) {
    throw new Error('Salesforce node requires SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID, and SALESFORCE_CLIENT_SECRET env vars')
  }

  const tokenStart = Date.now()
  const token = await getSalesforceToken(env, ctx.trigger.org_id, instanceUrl, clientId, clientSecret)
  const tokenMs = Date.now() - tokenStart
  const operation = config.operation ?? 'create'
  const object = config.object ?? ''

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'X-Trace-Id': ctx.trigger.trace_id,
  }

  let url: string
  let method: string
  let bodyStr: string | undefined

  const baseUrl = `${instanceUrl}/services/data/v60.0/sobjects/${object}`

  if (operation === 'create') {
    url = baseUrl
    method = 'POST'
    const resolvedBody = resolveValue(config.body, enrichedCtx)
    bodyStr = JSON.stringify(applyInjectedFields(resolvedBody, config, enrichedCtx))
  } else if (operation === 'update') {
    const recordId = String(resolveValue(config.record_id ?? '', enrichedCtx) ?? '')
    if (!recordId) throw new Error('Salesforce update requires record_id')
    url = `${baseUrl}/${recordId}`
    method = 'PATCH'
    const resolvedBody = resolveValue(config.body, enrichedCtx)
    bodyStr = JSON.stringify(applyInjectedFields(resolvedBody, config, enrichedCtx))
  } else if (operation === 'upsert') {
    const extField = config.external_id_field ?? ''
    const extValue = String(resolveValue(config.external_id_value ?? '', enrichedCtx) ?? '')
    if (!extField || !extValue) throw new Error('Salesforce upsert requires external_id_field and external_id_value')
    url = `${baseUrl}/${extField}/${extValue}`
    method = 'PATCH'
    const resolvedBody = resolveValue(config.body, enrichedCtx)
    bodyStr = JSON.stringify(applyInjectedFields(resolvedBody, config, enrichedCtx))
  } else if (operation === 'query') {
    const soql = String(resolveValue(config.soql ?? '', enrichedCtx) ?? '')
    if (!soql) throw new Error('Salesforce query requires soql')
    url = `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`
    method = 'GET'
  } else if (operation === 'apex') {
    const apexPath = (config.apex_path ?? '').replace(/^\/?/, '/')
    if (!apexPath || apexPath === '/') throw new Error('Salesforce apex requires apex_path')
    url = `${instanceUrl}${apexPath}`
    method = 'POST'
    const resolvedBody = resolveValue(config.body, enrichedCtx)
    bodyStr = JSON.stringify(resolvedBody)
  } else {
    throw new Error(`Unknown Salesforce operation: ${operation}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)

  const fetchStart = Date.now()
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(bodyStr !== undefined ? { body: bodyStr } : {}),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  const fetchMs = Date.now() - fetchStart

  // Salesforce returns 204 No Content for successful updates — body is empty
  const responseText = await res.text()
  const targetLabel = object || (config.apex_path ?? '')
  console.log(`[salesforce] ${operation} ${targetLabel} — token ${tokenMs}ms, fetch ${fetchMs}ms, status ${res.status}, trace=${ctx.trigger.trace_id}`)
  let parsedBody: unknown = null
  if (responseText) {
    try {
      parsedBody = JSON.parse(responseText)
    } catch {
      parsedBody = responseText
    }
  }

  if (!res.ok) {
    // If token expired (401), evict cache so next attempt re-fetches
    if (res.status === 401) {
      await env.WORKFLOW_CACHE.delete(`sf-token-${ctx.trigger.org_id}`)
    }

    // Expected-error short-circuit: if the SF error matches a configured
    // business rejection (e.g. dedup validation), exit the workflow here with
    // the step marked completed instead of failing the execution.
    const expected = config.expected_errors ?? []
    if (expected.length > 0) {
      const errorCode = extractSalesforceErrorCode(parsedBody)
      const message = extractSalesforceErrorMessage(parsedBody)
      const matched = expected.find((e) => {
        if (!errorCode || e.code !== errorCode) return false
        const needle = e.message_contains?.trim()
        if (!needle) return true
        return (message ?? '').includes(needle)
      })
      if (matched) {
        console.log(`[salesforce] expected rejection ${errorCode} — exiting workflow (trace=${ctx.trigger.trace_id})`)
        const output = { status: res.status, ok: false, errorCode, message, body: parsedBody }
        if (matched.response_body !== undefined) {
          // Custom response shape configured — return it to the consumer instead of the raw SF error.
          // Template-resolved against the current execution context.
          const resolvedBody = resolveValue(matched.response_body, enrichedCtx)
          return {
            output,
            earlyResponse: { status: matched.response_status ?? 200, body: resolvedBody },
            earlyExit: true,
          }
        }
        return { output, earlyExit: true }
      }
    }

    // Tag transient vs permanent so the engine's retry logic can skip non-retryable
    // SF errors. Mirrors Pipedream's makeRequestWithRetry classification:
    // 429 + 5xx are retried, everything else (400/401/403/404/422/etc) is permanent.
    const err = new Error(`Salesforce API error (${res.status}): ${responseText}`) as Error & { permanent?: boolean }
    const isTransient = res.status === 429 || res.status >= 500
    if (!isTransient) err.permanent = true
    throw err
  }

  return { output: { status: res.status, body: parsedBody } }
}

function applyInjectedFields(
  body: unknown,
  config: SalesforceConfig,
  ctx: ExecutionContext
): unknown {
  const fields = config.injected_fields
  if (!fields) return body ?? {}
  const resolved: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (!k) continue
    resolved[k] = resolveValue(v, ctx)
  }
  if (Object.keys(resolved).length === 0) return body ?? {}
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>), ...resolved }
  }
  return resolved
}

function extractSalesforceErrorCode(body: unknown): string | null {
  if (Array.isArray(body) && body.length > 0) {
    const first = body[0] as { errorCode?: unknown } | undefined
    if (first && typeof first.errorCode === 'string') return first.errorCode
  }
  if (body && typeof body === 'object' && 'errorCode' in body) {
    const code = (body as { errorCode?: unknown }).errorCode
    if (typeof code === 'string') return code
  }
  return null
}

function extractSalesforceErrorMessage(body: unknown): string | null {
  if (Array.isArray(body) && body.length > 0) {
    const first = body[0] as { message?: unknown } | undefined
    if (first && typeof first.message === 'string') return first.message
  }
  if (body && typeof body === 'object' && 'message' in body) {
    const msg = (body as { message?: unknown }).message
    if (typeof msg === 'string') return msg
  }
  return null
}
