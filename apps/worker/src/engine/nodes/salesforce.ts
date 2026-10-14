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
import { shadowSalesforceStub } from '../shadow'
import { shadowOf } from '../run-reality'
import { BulkheadClient, salesforceBulkheadLimit, salesforceBulkheadWaitMs, type AcquireResult } from '../../lib/bulkhead-client'
import { buildSandboxEnv } from '../../lib/sandbox-env'
import { hasUsablePhone } from '../../lib/contact-fields'
import { containsHtmlDocument, summarizeHtmlErrorBody } from '../../lib/html-error-summary'
import { attachBlockSighting, noteBlockSighting, sightingFromResponse } from '../block-sightings'

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

/** The one KV key an organization's Salesforce token is cached under, read here and cleared on a 401 by every caller. */
export const salesforceTokenCacheKey = (orgId: string): string => `sf-token-${orgId}`

export async function getSalesforceToken(env: Env, orgId: string, instanceUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const cacheKey = salesforceTokenCacheKey(orgId)
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
    // No execution context here, so a block page rides on the error (#1265). A token
    // endpoint is exactly the kind of host a firewall blocks first.
    throw attachBlockSighting(
      new Error(`Salesforce token fetch failed (${res.status}): ${text}`),
      sightingFromResponse(`${instanceUrl}/services/oauth2/token`, res.status, text, res.headers, 'salesforce:token'),
    )
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
  if (shadowOf(ctx).outboundStubbed) return shadowSalesforceStub()

  // Merge CF secrets so {{env.*}} templates resolve. Filtered through the sandbox
  // blocklist (#474) so platform master secrets (SUPABASE_SECRET_KEY,
  // SECRET_ENCRYPTION_KEY, SSN_HASH_PEPPER, ...) never resolve in a template, the
  // same blocklist code nodes enforce. SALESFORCE_* creds are not blocked.
  // The run's own values (ctx.env, a workflow's laid over the org's) win over a
  // Worker secret of the same name, exactly as in a code node, through the one
  // shared merge (#1681). They used to lose here, so a workflow's own value never
  // reached this node.
  const enrichedCtx: ExecutionContext = { ...ctx, env: buildSandboxEnv(env, ctx.env) }

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

  // Nothing rewrites the body on the way out. A malformed lead email is DROPPED,
  // never repaired (#742): the value the lead actually sent is what Salesforce
  // judges, and blanking happens only in recoverFromRejectedField, where
  // Salesforce has NAMED the offending field. That is the only place we know a
  // field is an email at all. A value like Referrer__c "some@thing" is
  // address-shaped and invalid too, so acting on shape alone before the call
  // would destroy real data in a field we merely guessed about.

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

  // Salesforce bulkhead (ADR 0005 / #312): a self-imposed inflight cap on SF calls.
  // SF only limits requests running 20s+ (max 25 concurrent); sub-second calls are
  // unlimited, so this cap chiefly protects a struggling SF during a slowdown, when
  // slow calls cross the 20s line and start counting against that real governor.
  // At capacity, wait for a freed slot:
  // observed bursts clear in seconds, and a waiting request adds zero Salesforce
  // load (it was refused at our own gate, it never reached SF). Only if the wait
  // budget expires does the lead shed. The shed is a RETRYABLE (transient) error,
  // NOT permanent: because a shed request never touched SF, withRetry re-entering
  // this gate on a later attempt still adds zero SF load and lets a lead ride out
  // a ~1-min slowdown across attempts (bounded by the per-attempt step timeout)
  // instead of being dropped after one wait. Do NOT mark it saturated / permanent,
  // which would lump it with REQUEST_LIMIT_EXCEEDED (whose retry DOES hit SF and
  // must not retry); see isSaturationError in error-classifier.ts. Fail OPEN if the
  // limiter itself errors, so a bulkhead-DO outage cannot block all SF traffic.
  const bulkhead = env.SALESFORCE_BULKHEAD
    ? new BulkheadClient(env, 'salesforce', salesforceBulkheadLimit(env))
    : null
  const waitMs = salesforceBulkheadWaitMs(env)
  const targetLabel = object || (config.apex_path ?? '')

  const callOpts: SalesforceCallOptions = {
    url,
    method,
    headers,
    bulkhead,
    waitMs,
    signal,
    resolvedInput,
    traceId: ctx.trigger.trace_id,
    operation,
    targetLabel,
    tokenMs,
  }

  let { res, responseText, parsedBody } = await performSalesforceCall(bodyStr, callOpts)

  // A cached token Salesforce has revoked answers 401 INVALID_SESSION_ID. Evicting
  // it and failing lost every lead in flight while the next lead succeeded on a
  // fresh login (#1741), so clear it and send this same request once more with a
  // fresh token. A 401 means Salesforce refused before running anything, so the
  // retry cannot write twice. A second 401 is a real credential fault and fails.
  if (res.status === 401) {
    await env.WORKFLOW_CACHE.delete(salesforceTokenCacheKey(ctx.trigger.org_id))
    console.log(`[salesforce] event=session_rejected_retry operation=${operation} target=${targetLabel} trace=${ctx.trigger.trace_id}`)
    headers.Authorization = `Bearer ${await getSalesforceToken(env, ctx.trigger.org_id, instanceUrl, clientId, clientSecret)}`
    ;({ res, responseText, parsedBody } = await performSalesforceCall(bodyStr, callOpts))
  }

  if (!res.ok) {
    // Still refused after the fresh token: evict again so the next lead does not reuse it.
    if (res.status === 401) {
      await env.WORKFLOW_CACHE.delete(salesforceTokenCacheKey(ctx.trigger.org_id))
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
    const err = new Error(summarizeHtmlErrorBody(`Salesforce API error (${res.status}): ${responseText}`)) as Error & { permanent?: boolean; resolvedInput?: ResolvedStepInput; logs?: StepLogEntry[] }
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
    // An HTML document instead of an API response means the request died at the
    // edge and was never processed as a business call, whatever status came with
    // it (#694). Salesforce Edge reports a connection hiccup as HTTP 400 with a
    // branded error page, and the status rule below read that 400 as a business
    // rejection: permanent, retries_used=0, lead dropped to a blip one retry
    // would have absorbed. If such a page ever does wrap a genuinely permanent
    // fault, the cost is the retries before it fails anyway, not a wrong answer.
    // The log line makes the frequency measurable rather than assumed.
    const isEdgeErrorPage = containsHtmlDocument(responseText)
    if (isEdgeErrorPage) {
      console.log(`[salesforce] event=html_error_page_transient status=${res.status} operation=${operation} target=${targetLabel} trace=${ctx.trigger.trace_id}`)
    }
    // A firewall block page on the instance is noted for the engine to report (#1265).
    noteBlockSighting(ctx, sightingFromResponse(instanceUrl, res.status, responseText, res.headers, node.namespace))
    const isTransient = salesforceFailureIsTransient(res.status, responseText) || matchesTransient
    if (!isTransient) err.permanent = true

    // Last chance before the lead is lost (#723). A field-level rejection on a
    // cosmetically broken email must not cost us a lead we can still phone.
    // Throws its own explicit error when nothing reachable would survive.
    const recovered = await recoverFromRejectedField({
      parsedBody,
      operation,
      body: resolvedBodyForInput,
      callOpts,
      warnLogs,
      resolvedInput,
    })
    if (recovered) return recovered

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

export interface SalesforceCallOptions {
  url: string
  method: string
  headers: Record<string, string>
  bulkhead: BulkheadClient | null
  waitMs: number
  signal: AbortSignal | undefined
  resolvedInput: ResolvedStepInput
  traceId: string
  operation: SalesforceOperation
  targetLabel: string
  tokenMs: number
}

/**
 * Whether a failed Salesforce answer is worth sending again: a rate limit, a
 * server error, or an edge error page (the request died before Salesforce ran
 * it, whatever status came with it, #694). Everything else is a business
 * rejection. The node adds its own per node `transient_errors` on top; the
 * replay tool (#471) judges a held write by this same rule.
 */
export function salesforceFailureIsTransient(status: number, responseText: string): boolean {
  return status === 429 || status >= 500 || containsHtmlDocument(responseText)
}

/**
 * Whether Salesforce rejected the write ITSELF: a failed answer that is neither
 * worth sending again nor a login or permission refusal (401, 403), which is a
 * fault on our side that fixing the credentials clears. A different question from
 * the retry rule above, so it is its own function rather than a clause beside it:
 * the replay tool (#471) closes a held write only on this.
 */
export function salesforceRejectedTheWrite(status: number, responseText: string): boolean {
  return status >= 400 && status !== 401 && status !== 403 && !salesforceFailureIsTransient(status, responseText)
}

/**
 * One Salesforce call: bulkhead slot, own timeout, response read and parsed.
 *
 * Extracted so the malformed-field recovery (#723) reruns the request through
 * exactly this path. A retry that skipped the bulkhead would sneak past the
 * inflight cap (ADR 0005) precisely when Salesforce is already struggling.
 */
export async function performSalesforceCall(
  bodyStr: string | undefined,
  opts: SalesforceCallOptions,
): Promise<{ res: Response; responseText: string; parsedBody: unknown }> {
  const acquireStart = Date.now()
  const lease = opts.bulkhead
    ? await opts.bulkhead.acquireWithWait(opts.waitMs, { signal: opts.signal }).catch(() => ({ allowed: true } as AcquireResult))
    : ({ allowed: true } as AcquireResult)
  const waitedMs = Date.now() - acquireStart
  if (!lease.allowed) {
    // Distinctive message so an unhandled shed flows through the existing failure
    // + failure-rate Slack alerts without new alert infra.
    console.log(`[salesforce] event=salesforce_bulkhead_shed inflight=${lease.inflight} limit=${lease.limit} waited_ms=${waitedMs} trace=${opts.traceId}`)
    const shedErr = new Error(
      `Salesforce bulkhead: at capacity (${lease.inflight}/${lease.limit} inflight, waited ${waitedMs}ms)`,
    ) as Error & { resolvedInput?: ResolvedStepInput }
    // Not marked permanent/saturated on purpose: classifyStepError defaults an
    // unmarked error to transient, so withRetry retries the shed (see comment above).
    shedErr.resolvedInput = opts.resolvedInput
    throw shedErr
  }
  if (waitedMs > 1000) {
    // Slot obtained but only after real waiting: saturation is close. Visible in
    // logs so a creeping-toward-capacity trend can be spotted before sheds start.
    console.log(`[salesforce] event=salesforce_bulkhead_waited waited_ms=${waitedMs} inflight=${lease.inflight} limit=${lease.limit} trace=${opts.traceId}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  linkAbort(controller, opts.signal)  // also cancel on the step-level timeout (#66)

  const fetchStart = Date.now()
  let res: Response
  try {
    res = await fetch(opts.url, {
      method: opts.method,
      headers: opts.headers,
      ...(bodyStr !== undefined ? { body: bodyStr } : {}),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
    // Release the slot whether the call succeeded, failed, or timed out.
    if (opts.bulkhead && lease.token) await opts.bulkhead.release(lease.token).catch(() => {})
  }
  const fetchMs = Date.now() - fetchStart

  // Salesforce returns 204 No Content for successful updates, so the body is empty
  const responseText = await res.text()
  console.log(`[salesforce] ${opts.operation} ${opts.targetLabel} token ${opts.tokenMs}ms, fetch ${fetchMs}ms, status ${res.status}, trace=${opts.traceId}`)
  if (res.status >= 500) {
    // 5xx (esp. a 520 Cloudflare-edge timeout): capture the cf-ray and server
    // headers + a body snippet so a recurrence is diagnosable. cf-ray identifies
    // the Cloudflare colo/request (and confirms a CF-edge response), server tells
    // us whether Cloudflare or Salesforce served it (#331). String detail (not a
    // 2nd console arg) so CF observability indexes it.
    const cfRay = res.headers.get('cf-ray') ?? 'none'
    const server = res.headers.get('server') ?? 'none'
    const bodySnippet = responseText.slice(0, 200).replace(/\s+/g, ' ').trim()
    console.log(`[salesforce] ${opts.operation} ${opts.targetLabel} 5xx detail cf-ray=${cfRay}, server=${server}, body=${bodySnippet}, trace=${opts.traceId}`)
  }

  let parsedBody: unknown = null
  if (responseText) {
    try {
      parsedBody = JSON.parse(responseText)
    } catch {
      parsedBody = responseText
    }
  }
  return { res, responseText, parsedBody }
}

/**
 * Salesforce error codes that mean "this one field's VALUE is malformed", where
 * dropping that field is strictly better than losing the record.
 *
 * Kept deliberately narrow. A code that means something else (a missing required
 * field, a failed validation rule) must not land here: blanking the field
 * Salesforce named would turn a clear error into a confusing one.
 */
const RECOVERABLE_FIELD_ERRORS = new Set(['INVALID_EMAIL_ADDRESS'])

/** Operations we may safely repeat. Apex is excluded: its side effects may already have fired. */
const RETRYABLE_OPERATIONS = new Set<SalesforceOperation>(['create', 'update', 'upsert'])

/**
 * Blank a field Salesforce rejected as malformed and retry the write once (#723).
 *
 * Returns the successful result, or null when recovery does not apply and the
 * caller should throw the original error. Throws its own explicit error in one
 * case only: when blanking would leave a record with no way to reach the person,
 * which is a lead we genuinely cannot use and deserves to say so rather than
 * surfacing a Salesforce 400 that reads like an outage.
 */
async function recoverFromRejectedField(args: {
  parsedBody: unknown
  operation: SalesforceOperation
  body: unknown
  callOpts: SalesforceCallOptions
  warnLogs: StepLogEntry[]
  resolvedInput: ResolvedStepInput
}): Promise<StepExecutionResult | null> {
  const { parsedBody, operation, body, callOpts, warnLogs, resolvedInput } = args

  if (!RETRYABLE_OPERATIONS.has(operation)) return null
  const errorCode = extractSalesforceErrorCode(parsedBody)
  if (!errorCode || !RECOVERABLE_FIELD_ERRORS.has(errorCode)) return null
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null

  // Salesforce names the offending fields, so we never have to guess which ones
  // to drop, and this works for any object or field naming convention.
  const named = extractSalesforceErrorFields(parsedBody)
  const record = body as Record<string, unknown>
  const droppable = named.filter((f) => {
    const current = record[f]
    return typeof current === 'string' && current !== ''
  })
  if (droppable.length === 0) return null

  const blanked: Record<string, unknown> = { ...record }
  const dropped = droppable.map((f) => `${f}="${String(record[f])}"`).join(', ')
  for (const f of droppable) blanked[f] = ''

  // Point 4 of #723: a phone number is what makes a lead sellable. With the
  // email gone and no phone left, there is nothing to reach the person by, so
  // there is no point spending a second Salesforce call on it.
  if (!hasUsablePhone(blanked)) {
    console.log(`[salesforce] event=salesforce_lead_unreachable code=${errorCode} trace=${callOpts.traceId}`)
    const err = new Error(
      `Lead rejected: no usable contact method. Salesforce rejected ${dropped} (${errorCode}) and the record has no phone number with at least 10 digits, so there is no way to reach this person.`,
    ) as Error & { permanent?: boolean; resolvedInput?: ResolvedStepInput; logs?: StepLogEntry[] }
    err.permanent = true
    err.resolvedInput = resolvedInput
    if (warnLogs.length > 0) err.logs = warnLogs
    throw err
  }

  console.log(
    `[salesforce] event=salesforce_field_blanked_retry code=${errorCode} fields=${droppable.join(',')} trace=${callOpts.traceId}`,
  )
  const logs: StepLogEntry[] = [
    ...warnLogs,
    {
      level: 'warn',
      message: `Salesforce rejected ${dropped} as invalid (${errorCode}). Dropped it and retried, so the record was created without it. Repairing the value was not possible without guessing a different address.`,
      ts: new Date().toISOString(),
    },
  ]

  // Show the body Salesforce actually accepted, so the Results panel does not
  // claim we sent an address we deliberately dropped. `resolved` is typed
  // unknown, but executeSalesforceNode always builds it as a record.
  const retryInput: ResolvedStepInput = {
    template: resolvedInput.template,
    resolved: { ...(resolvedInput.resolved as Record<string, unknown>), body: blanked },
  }
  const retry = await performSalesforceCall(JSON.stringify(blanked), { ...callOpts, resolvedInput: retryInput })
  if (!retry.res.ok) {
    // The retry failed too. Say nothing new: the caller throws the ORIGINAL
    // error, so diagnostics never get worse than before this recovery existed.
    console.log(`[salesforce] event=salesforce_field_blanked_retry_failed status=${retry.res.status} trace=${callOpts.traceId}`)
    return null
  }

  // `_dropped_fields` makes the drop countable outside this one execution's log
  // (#744). The run SUCCEEDS after this recovery, so there is no failed execution
  // and no alert to hang a rate off; the warning above lives only in
  // execution_steps, which is purged on a short window. This marker is what
  // email_drop_counts_by_source aggregates per source, so a partner that starts
  // sending damaged addresses in bulk surfaces as a rate instead of staying
  // invisible (LESSONS L77).
  return {
    output: { status: retry.res.status, body: retry.parsedBody, _dropped_fields: droppable },
    resolvedInput: retryInput,
    logs,
  }
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
    // Retryable (transient), NOT permanent, same rationale as the main shed
    // above: a shed request never reached SF, so retrying re-enters this gate
    // without adding SF load. Leaving it unmarked lets classifyStepError default
    // it to transient so withRetry rides out a brief slowdown.
    throw Object.assign(
      new Error(`Salesforce bulkhead: at capacity while paging a query (${lease.inflight}/${lease.limit} inflight)`),
      { resolvedInput: opts.resolvedInput },
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
    const err = new Error(summarizeHtmlErrorBody(`Salesforce API error (${res.status}) while paging a query: ${text}`)) as Error & {
      permanent?: boolean
      resolvedInput?: ResolvedStepInput
    }
    err.resolvedInput = opts.resolvedInput
    // Same edge-page rule as the main call path (#694): an HTML document means
    // the page request never reached the API, so it is retryable at any status.
    const isEdgeErrorPage = containsHtmlDocument(text)
    if (isEdgeErrorPage) {
      console.log(`[salesforce] event=html_error_page_transient status=${res.status} operation=query_page trace=${opts.traceId}`)
    }
    if (!salesforceFailureIsTransient(res.status, text)) err.permanent = true
    throw attachBlockSighting(err, sightingFromResponse(opts.instanceUrl, res.status, text, res.headers, 'salesforce:query_page'))
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

/** The field API names Salesforce blamed, e.g. ["Email__c"]. */
function extractSalesforceErrorFields(body: unknown): string[] {
  const entries = Array.isArray(body) ? (body as unknown[]) : null
  const first = entries && entries.length > 0 ? entries[0] : body
  if (!first || typeof first !== 'object') return []
  const fields = (first as { fields?: unknown }).fields
  if (!Array.isArray(fields)) return []
  return fields.filter((f): f is string => typeof f === 'string' && f !== '')
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
