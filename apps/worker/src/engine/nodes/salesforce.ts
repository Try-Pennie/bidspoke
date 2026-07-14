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

import type { NodeDefinition, ExecutionContext, StepExecutionResult, ResolvedStepInput, StepLogEntry } from '../../types'
import type { Env } from '../../index'
import { resolveValue, warnDroppedBodyFields } from '../context'
import { coerceString } from '../../lib/coerce'
import { parseJson } from '../../lib/json'
import { linkAbort } from '../retry'
import { isShadowDryRun, shadowSalesforceStub } from '../shadow'
import { BulkheadClient, salesforceBulkheadLimit, salesforceBulkheadWaitMs, type AcquireResult } from '../../lib/bulkhead-client'
import { sandboxEnvBindings } from '../../lib/sandbox-env'

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
  apex_method?: 'GET' | 'POST'  // apex: HTTP method. Defaults to POST. GET sends no body.
  expected_errors?: ExpectedError[]  // SF rejections treated as business rejections, not failures.
                                     // Matched by errorCode AND optional message substring.
                                     // Step logs as completed and the workflow exits here.
  transient_errors?: { code: string; message_contains?: string }[]  // SF errors to retry despite a 4xx status.
                                     // Matched by errorCode AND optional message substring (same matcher as
                                     // expected_errors). A match marks the error transient so the engine's
                                     // retry/backoff applies. Pre-populated in the UI with REQUEST_LIMIT_EXCEEDED
                                     // + "Concurrent" (ConcurrentPerOrgLongTxn limits clear within seconds).
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

  const data = await parseJson<{ access_token: string }>(res)
  await env.WORKFLOW_CACHE.put(cacheKey, data.access_token, { expirationTtl: TOKEN_TTL_S })
  return data.access_token
}

export async function executeSalesforceNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env,
  signal?: AbortSignal
): Promise<StepExecutionResult> {
  const config = node.config as unknown as SalesforceConfig

  // Shadow dry-run: don't touch Salesforce (no token fetch, no write).
  if (isShadowDryRun(ctx)) return shadowSalesforceStub()

  // Merge CF secrets so {{env.*}} templates resolve. Filtered through the sandbox
  // blocklist (#474) so platform master secrets (SUPABASE_SECRET_KEY,
  // SECRET_ENCRYPTION_KEY, SSN_HASH_PEPPER, ...) never resolve in a template —
  // same blocklist code nodes enforce. SALESFORCE_* creds are not blocked.
  const enrichedCtx: ExecutionContext = { ...ctx, env: { ...ctx.env, ...sandboxEnvBindings(env) } }

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
  // Parsed (not stringified) body used for the Results-panel input shape.
  // Captured alongside bodyStr so the panel can show a JSON tree rather than
  // a wall of escaped string.
  let resolvedBodyForInput: unknown = undefined
  let resolvedRecordId: string | undefined
  let resolvedExternalIdValue: string | undefined
  let resolvedSoql: string | undefined

  const baseUrl = `${instanceUrl}/services/data/v60.0/sobjects/${object}`

  if (operation === 'create') {
    url = baseUrl
    method = 'POST'
    const resolvedBody = resolveValue(config.body, enrichedCtx)
    resolvedBodyForInput = applyInjectedFields(resolvedBody, config, enrichedCtx)
    bodyStr = JSON.stringify(resolvedBodyForInput)
  } else if (operation === 'update') {
    resolvedRecordId = coerceString(resolveValue(config.record_id ?? '', enrichedCtx))
    if (!resolvedRecordId) throw new Error('Salesforce update requires record_id')
    url = `${baseUrl}/${resolvedRecordId}`
    method = 'PATCH'
    const resolvedBody = resolveValue(config.body, enrichedCtx)
    resolvedBodyForInput = applyInjectedFields(resolvedBody, config, enrichedCtx)
    bodyStr = JSON.stringify(resolvedBodyForInput)
  } else if (operation === 'upsert') {
    const extField = config.external_id_field ?? ''
    resolvedExternalIdValue = coerceString(resolveValue(config.external_id_value ?? '', enrichedCtx))
    if (!extField || !resolvedExternalIdValue) throw new Error('Salesforce upsert requires external_id_field and external_id_value')
    url = `${baseUrl}/${extField}/${resolvedExternalIdValue}`
    method = 'PATCH'
    const resolvedBody = resolveValue(config.body, enrichedCtx)
    resolvedBodyForInput = applyInjectedFields(resolvedBody, config, enrichedCtx)
    bodyStr = JSON.stringify(resolvedBodyForInput)
  } else if (operation === 'query') {
    resolvedSoql = coerceString(resolveValue(config.soql ?? '', enrichedCtx))
    if (!resolvedSoql) throw new Error('Salesforce query requires soql')
    url = `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(resolvedSoql)}`
    method = 'GET'
  } else if (operation === 'apex') {
    const apexPath = (config.apex_path ?? '').replace(/^\/?/, '/')
    if (!apexPath || apexPath === '/') throw new Error('Salesforce apex requires apex_path')
    url = `${instanceUrl}${apexPath}`
    method = config.apex_method === 'GET' ? 'GET' : 'POST'
    if (method === 'POST') {
      resolvedBodyForInput = resolveValue(config.body, enrichedCtx)
      bodyStr = JSON.stringify(resolvedBodyForInput)
    }
  } else {
    throw new Error(`Unknown Salesforce operation: ${operation}`)
  }

  // Warn if any body field resolved to undefined (would be silently dropped on
  // serialization). Relevant to create/update/upsert/apex; query/GET has no body.
  const warnLogs: StepLogEntry[] =
    resolvedBodyForInput !== undefined
      ? warnDroppedBodyFields(resolvedBodyForInput, {
          nodeNamespace: node.namespace,
          nodeLabel: node.label,
          traceId: ctx.trigger.trace_id,
        })
      : []

  // Built after URL/method so we can include the actual outbound URL the
  // request went to (helpful for upsert / update which embed the record id).
  const resolvedInput: ResolvedStepInput = {
    template: {
      operation,
      object: config.object,
      body: config.body,
      record_id: config.record_id,
      external_id_field: config.external_id_field,
      external_id_value: config.external_id_value,
      soql: config.soql,
      apex_path: config.apex_path,
      apex_method: config.apex_method,
      injected_fields: config.injected_fields,
    },
    resolved: {
      operation,
      object,
      method,
      url,
      body: resolvedBodyForInput,
      record_id: resolvedRecordId,
      external_id_value: resolvedExternalIdValue,
      soql: resolvedSoql,
    },
  }

  // Salesforce bulkhead (ADR 0005 / #312): bound inflight SF calls below the org's
  // ~25-slot concurrency governor. At capacity, wait briefly for a freed slot —
  // observed bursts clear in seconds, and a waiting request adds zero Salesforce
  // load (it was refused at our own gate, it never reached SF). Only if the wait
  // budget expires does the lead shed with a permanent error (routes to the
  // step's on_error/fallback, no SF retry) — that now genuinely means sustained
  // saturation. Fail OPEN if the limiter itself errors — a bulkhead-DO outage
  // must not block all SF traffic.
  const bulkhead = env.SALESFORCE_BULKHEAD
    ? new BulkheadClient(env, 'salesforce', salesforceBulkheadLimit(env))
    : null
  const waitMs = salesforceBulkheadWaitMs(env)
  const acquireStart = Date.now()
  const lease = bulkhead
    ? await bulkhead.acquireWithWait(waitMs, { signal }).catch(() => ({ allowed: true } as AcquireResult))
    : ({ allowed: true } as AcquireResult)
  const waitedMs = Date.now() - acquireStart
  if (!lease.allowed) {
    // Distinctive message so an unhandled shed flows through the existing failure
    // + failure-rate Slack alerts without new alert infra.
    console.log(`[salesforce] event=salesforce_bulkhead_shed inflight=${lease.inflight} limit=${lease.limit} waited_ms=${waitedMs} trace=${ctx.trigger.trace_id}`)
    const shedErr = new Error(
      `Salesforce bulkhead: at capacity (${lease.inflight}/${lease.limit} inflight, waited ${waitedMs}ms)`,
    ) as Error & { permanent?: boolean; resolvedInput?: ResolvedStepInput }
    shedErr.permanent = true
    shedErr.resolvedInput = resolvedInput
    throw shedErr
  }
  if (waitedMs > 1000) {
    // Slot obtained but only after real waiting — saturation is close. Visible in
    // logs so a creeping-toward-capacity trend can be spotted before sheds start.
    console.log(`[salesforce] event=salesforce_bulkhead_waited waited_ms=${waitedMs} inflight=${lease.inflight} limit=${lease.limit} trace=${ctx.trigger.trace_id}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  linkAbort(controller, signal)  // also cancel on the step-level timeout (#66)

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
    // Release the slot whether the call succeeded, failed, or timed out.
    if (bulkhead && lease.token) await bulkhead.release(lease.token).catch(() => {})
  }
  const fetchMs = Date.now() - fetchStart

  // Salesforce returns 204 No Content for successful updates — body is empty
  const responseText = await res.text()
  const targetLabel = object || (config.apex_path ?? '')
  console.log(`[salesforce] ${operation} ${targetLabel} — token ${tokenMs}ms, fetch ${fetchMs}ms, status ${res.status}, trace=${ctx.trigger.trace_id}`)
  if (res.status >= 500) {
    // 5xx (esp. a 520 Cloudflare-edge timeout) — capture the cf-ray and server
    // headers + a body snippet so a recurrence is diagnosable: cf-ray identifies
    // the Cloudflare colo/request (and confirms a CF-edge response), server tells
    // us whether Cloudflare or Salesforce served it (#331). String detail (not a
    // 2nd console arg) so CF observability indexes it.
    const cfRay = res.headers.get('cf-ray') ?? 'none'
    const server = res.headers.get('server') ?? 'none'
    const bodySnippet = responseText.slice(0, 200).replace(/\s+/g, ' ').trim()
    console.log(`[salesforce] ${operation} ${targetLabel} 5xx detail — cf-ray=${cfRay}, server=${server}, body=${bodySnippet}, trace=${ctx.trigger.trace_id}`)
  }
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
            resolvedInput,
          }
        }
        return { output, earlyExit: true, resolvedInput }
      }
    }

    // Tag transient vs permanent so the engine's retry logic can skip non-retryable
    // SF errors. Mirrors Pipedream's makeRequestWithRetry classification:
    // 429 + 5xx are retried, everything else (400/401/403/404/422/etc) is permanent.
    // Per-node `transient_errors` opts specific errorCodes back in (e.g. SF
    // concurrency limits return 403 REQUEST_LIMIT_EXCEEDED but clear in seconds).
    const err = new Error(`Salesforce API error (${res.status}): ${responseText}`) as Error & { permanent?: boolean; resolvedInput?: ResolvedStepInput; logs?: StepLogEntry[] }
    err.resolvedInput = resolvedInput
    if (warnLogs.length > 0) err.logs = warnLogs
    const transientErrors = config.transient_errors ?? []
    let matchesTransient = false
    if (transientErrors.length > 0) {
      const errorCode = extractSalesforceErrorCode(parsedBody)
      const message = extractSalesforceErrorMessage(parsedBody) ?? ''
      matchesTransient = transientErrors.some((e) => {
        if (!errorCode || e.code !== errorCode) return false
        const needle = e.message_contains?.trim()
        if (!needle) return true
        return message.includes(needle)
      })
    }
    const isTransient = res.status === 429 || res.status >= 500 || matchesTransient
    if (!isTransient) err.permanent = true
    throw err
  }

  // Salesforce returns at most ~2000 records per page and signals more with
  // done:false + nextRecordsUrl (#509). We used to hand back page 1 as if it were
  // the whole result set, so a record sitting on page 2 read as "not found" and a
  // count read low, with nothing in the output to say so. Follow the pages.
  if (operation === 'query') {
    const paged = await followQueryPages(parsedBody, {
      instanceUrl,
      headers,
      signal,
      traceId: ctx.trigger.trace_id,
      bulkhead,
      waitMs,
      resolvedInput,
    })
    parsedBody = paged.body
    if (paged.warn) warnLogs.push(paged.warn)
  }

  return { output: { status: res.status, body: parsedBody }, resolvedInput, ...(warnLogs.length > 0 ? { logs: warnLogs } : {}) }
}

/**
 * Most pages we will walk for a single query, INCLUDING the first. At Salesforce's
 * ~2000 records per page that is ~20k records, far above anything a workflow step
 * should be pulling inline, and it bounds a pathological query (or a server that
 * keeps claiming there is more) instead of looping until the step times out.
 */
export const SF_QUERY_PAGE_CAP = 10

interface SfQueryBody {
  done?: boolean
  nextRecordsUrl?: string
  records?: unknown[]
  totalSize?: number
  truncated?: boolean
}

function isPagedQueryBody(body: unknown): body is SfQueryBody {
  if (typeof body !== 'object' || body === null) return false
  const b = body as SfQueryBody
  return b.done === false && typeof b.nextRecordsUrl === 'string' && Array.isArray(b.records)
}

/**
 * Walk nextRecordsUrl until Salesforce says done, or until the page cap.
 *
 * Two things this must never do. It must not return a partial set that looks
 * complete: hitting the cap leaves `done:false` and adds `truncated:true` plus a
 * warn entry on the step, so the partiality is visible in the UI and not just in a
 * console line nobody reads. And it must not sneak around the bulkhead (ADR 0005):
 * every page is another Salesforce call, so every page takes a slot, exactly like
 * the first one did.
 */
async function followQueryPages(
  first: unknown,
  opts: {
    instanceUrl: string
    headers: Record<string, string>
    signal: AbortSignal | undefined
    traceId: string
    bulkhead: BulkheadClient | null
    waitMs: number
    resolvedInput: ResolvedStepInput
  },
): Promise<{ body: unknown; warn?: StepLogEntry }> {
  if (!isPagedQueryBody(first)) return { body: first }

  const records: unknown[] = [...(first.records ?? [])]
  let page = first
  let pages = 1

  while (page.done === false && page.nextRecordsUrl) {
    if (pages >= SF_QUERY_PAGE_CAP) {
      console.log(
        `[salesforce] event=salesforce_query_truncated pages=${pages} records=${records.length} total=${page.totalSize ?? 'unknown'} trace=${opts.traceId}`,
      )
      return {
        body: { ...page, records, done: false, truncated: true },
        warn: {
          level: 'warn',
          message: `Salesforce query truncated: stopped after ${pages} pages (${records.length} of ${page.totalSize ?? 'unknown'} records). Narrow the SOQL: this result set is INCOMPLETE.`,
          ts: new Date().toISOString(),
        },
      }
    }

    const next: unknown = await fetchQueryPage(page.nextRecordsUrl, opts)
    if (!isQueryBody(next)) {
      throw Object.assign(new Error('Salesforce query page returned an unexpected body'), {
        permanent: true,
        resolvedInput: opts.resolvedInput,
      })
    }
    records.push(...(next.records ?? []))
    page = next
    pages++
  }

  return { body: { ...page, records, done: true } }
}

function isQueryBody(body: unknown): body is SfQueryBody {
  return typeof body === 'object' && body !== null
}

/** One follow-up page: bulkhead slot, own timeout, loud on a non-2xx. */
async function fetchQueryPage(
  nextRecordsUrl: string,
  opts: {
    instanceUrl: string
    headers: Record<string, string>
    signal: AbortSignal | undefined
    traceId: string
    bulkhead: BulkheadClient | null
    waitMs: number
    resolvedInput: ResolvedStepInput
  },
): Promise<unknown> {
  // nextRecordsUrl is a path (/services/data/vXX.0/query/01g...-2000), not absolute.
  const url = nextRecordsUrl.startsWith('http') ? nextRecordsUrl : `${opts.instanceUrl}${nextRecordsUrl}`

  const lease = opts.bulkhead
    ? await opts.bulkhead
        .acquireWithWait(opts.waitMs, { signal: opts.signal })
        .catch(() => ({ allowed: true } as AcquireResult))
    : ({ allowed: true } as AcquireResult)
  if (!lease.allowed) {
    throw Object.assign(
      new Error(`Salesforce bulkhead: at capacity while paging a query (${lease.inflight}/${lease.limit} inflight)`),
      { permanent: true, resolvedInput: opts.resolvedInput },
    )
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  linkAbort(controller, opts.signal)

  let res: Response
  try {
    res = await fetch(url, { method: 'GET', headers: opts.headers, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    if (opts.bulkhead && lease.token) await opts.bulkhead.release(lease.token).catch(() => {})
  }

  const text = await res.text()
  if (!res.ok) {
    // A failed page means we do not know the full result set. Returning what we
    // have would be the exact silent-truncation bug this function exists to kill.
    const err = new Error(`Salesforce API error (${res.status}) while paging a query: ${text}`) as Error & {
      permanent?: boolean
      resolvedInput?: ResolvedStepInput
    }
    err.resolvedInput = opts.resolvedInput
    if (!(res.status === 429 || res.status >= 500)) err.permanent = true
    throw err
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
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
