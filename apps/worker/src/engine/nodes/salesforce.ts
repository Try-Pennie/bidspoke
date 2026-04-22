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

interface SalesforceConfig {
  operation: SalesforceOperation
  object?: string       // SObject API name, e.g. Prospect__c
  body?: unknown        // template-enabled JSON body (create / update / upsert / apex)
  record_id?: string    // template-enabled — required for update
  external_id_field?: string  // upsert: external ID field name
  external_id_value?: string  // upsert: template-enabled external ID value
  soql?: string         // template-enabled SOQL query string
  apex_path?: string    // apex: relative path, e.g. /services/apexrest/prospect-trades
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
    bodyStr = JSON.stringify(resolvedBody)
  } else if (operation === 'update') {
    const recordId = String(resolveValue(config.record_id ?? '', enrichedCtx) ?? '')
    if (!recordId) throw new Error('Salesforce update requires record_id')
    url = `${baseUrl}/${recordId}`
    method = 'PATCH'
    const resolvedBody = resolveValue(config.body, enrichedCtx)
    bodyStr = JSON.stringify(resolvedBody)
  } else if (operation === 'upsert') {
    const extField = config.external_id_field ?? ''
    const extValue = String(resolveValue(config.external_id_value ?? '', enrichedCtx) ?? '')
    if (!extField || !extValue) throw new Error('Salesforce upsert requires external_id_field and external_id_value')
    url = `${baseUrl}/${extField}/${extValue}`
    method = 'PATCH'
    const resolvedBody = resolveValue(config.body, enrichedCtx)
    bodyStr = JSON.stringify(resolvedBody)
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
    throw new Error(`Salesforce API error (${res.status}): ${responseText}`)
  }

  return { output: { status: res.status, body: parsedBody } }
}
