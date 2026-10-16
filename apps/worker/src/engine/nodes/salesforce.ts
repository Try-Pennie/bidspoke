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
 *           external_id_value?, soql?, omit_fields?, rename_fields?,
 *           skip_when_empty? }
 * Output: { status, body }, or { skipped: true, skip_reason } for a skipped write.
 * A credit inquiry post skipped on a replay or a resume because its file already
 * landed (#2176) also carries lead_id, recovered_from and marker_since, and is the
 * one skip that calls Salesforce, for that check.
 */

import type { NodeDefinition, ExecutionContext, StepExecutionResult, ResolvedStepInput, StepLogEntry } from '../../types'
import type { Env } from '../../index'
import { resolveValue, warnDroppedBodyFields } from '../context'
import { coerceString } from '../../lib/coerce'
import { linkAbort } from '../retry'
import { classifyHttpErrorWithBody } from '../error-classifier'
import { shadowSalesforceStub } from '../shadow'
import { shadowOf } from '../run-reality'
import { BulkheadClient, acquireSlots, salesforceBulkheads, type AcquireWaitOptions, type HeldSlots } from '../../lib/bulkhead-client'
import { buildSandboxEnv } from '../../lib/sandbox-env'
import { hasUsablePhone } from '../../lib/contact-fields'
import { containsHtmlDocument, summarizeHtmlErrorBody } from '../../lib/html-error-summary'
import { attachBlockSighting, noteBlockSighting, sightingFromResponse } from '../block-sightings'
import { salesforceConfigProblem } from '@bidspoke/workflow-definition'
import { stampWriteMarker } from '../write-marker'
import { CREDIT_INQUIRY_APEX_PATH, INQUIRY_MARKER_MARGIN_MS, inquiryPostOf, isCreditInquiryPost, lookupInquiryMarker, type InquiryMarkerLookup, type InquiryPost, type SalesforceRead } from '../inquiry-post'
import type { RecoveryOrigin } from '../recovery-origin'
import { formatErr } from '../../lib/format-error'

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
  // The Pipedream relay's write options (#2170, phase 1 of #1680). Shape checked by
  // salesforceConfigProblem, the rule save validation uses too.
  omit_fields?: string[]                    // create / update / upsert: body keys never sent (the relay sent only its 28).
  rename_fields?: Record<string, string>    // create / update / upsert: body key → the field it is sent as. Before injected_fields.
  skip_when_empty?: boolean                 // update: skip, with a recorded reason, when there is nothing to write or no record id.
                                            // apex POST: skip when the body resolves to null or nothing (#2181).
}

/** Why a write was skipped rather than sent (#2170), recorded on the step's output. */
export type SalesforceSkipReason = 'nothing_to_write' | 'no_record_id' | 'already_landed'

// Token cache TTL slightly under SF default of 3600s to avoid races
const TOKEN_TTL_S = 3500

/** The one KV key an organization's Salesforce token is cached under, read here and cleared on a 401 by every caller. */
export const salesforceTokenCacheKey = (orgId: string): string => `sf-token-${orgId}`

/** How long a token fetch may take before it gives up (#1389): under the 15 s a call itself gets. */
export const SALESFORCE_TOKEN_TIMEOUT_MS = 10_000

/**
 * A token for the org's Salesforce, cached.
 *
 * Bounded like every other outbound call (#1389): its own deadline, and the
 * step's signal when a step is waiting on it, so a hung token endpoint cannot
 * hold a lead. A failure is judged by the shared HTML page rule (#694, #756): an
 * HTML page means the request died at an edge, so it is retryable; any other
 * refusal of the credentials is final.
 */
export async function getSalesforceToken(
  env: Env,
  orgId: string,
  instanceUrl: string,
  clientId: string,
  clientSecret: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const cacheKey = salesforceTokenCacheKey(orgId)
  const cached = await env.WORKFLOW_CACHE.get(cacheKey)
  if (cached) return cached

  const timeoutMs = opts.timeoutMs ?? SALESFORCE_TOKEN_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  linkAbort(controller, opts.signal)
  // The deadline covers the body as well as the headers: a body that never
  // finishes holds the lead just as long.
  let res: Response
  let text: string
  try {
    res = await fetch(`${instanceUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: controller.signal,
    })
    text = await res.text()
  } catch (e) {
    // Unmarked, so the step classifier reads it as transient and retries.
    if (controller.signal.aborted) {
      throw new Error(
        opts.signal?.aborted
          ? 'Salesforce token fetch stopped: the step ran out of time'
          : `Salesforce token fetch timed out after ${timeoutMs} ms`,
      )
    }
    throw e
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    // No execution context here, so a block page rides on the error (#1265). A token
    // endpoint is exactly the kind of host a firewall blocks first.
    const err = attachBlockSighting(
      new Error(summarizeHtmlErrorBody(`Salesforce token fetch failed (${res.status}): ${text}`)),
      sightingFromResponse(`${instanceUrl}/services/oauth2/token`, res.status, text, res.headers, 'salesforce:token'),
    ) as Error & { status?: number; permanent?: boolean }
    err.status = res.status
    if (classifyHttpErrorWithBody(res.status, text) === 'permanent') err.permanent = true
    else if (containsHtmlDocument(text)) {
      console.log(`[salesforce] event=html_error_page_transient status=${res.status} operation=token target=${instanceUrl}`)
    }
    throw err
  }

  let token: unknown
  try {
    token = (JSON.parse(text) as { access_token?: unknown }).access_token
  } catch {
    throw new Error(`Salesforce token response was not JSON (${res.status}): ${text.slice(0, 200)}`)
  }
  if (typeof token !== 'string' || token === '') throw new Error(`Salesforce token response carried no access_token (${res.status})`)
  await env.WORKFLOW_CACHE.put(cacheKey, token, { expirationTtl: TOKEN_TTL_S })
  return token
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

  // The write options are judged by the rule save validation uses (#2170), so a
  // definition that reached the engine without passing save fails by name here.
  const optionProblem = salesforceConfigProblem(node.config)
  if (optionProblem) throw permanentError(`Salesforce step misconfigured: ${optionProblem}`)

  const operation = config.operation ?? 'create'
  const object = config.object ?? ''

  const template = {
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
    omit_fields: config.omit_fields,
    rename_fields: config.rename_fields,
    skip_when_empty: config.skip_when_empty,
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
  let skipReason: SalesforceSkipReason | undefined
  // The credit inquiry post as its body reads (#2172), set only for that post.
  let inquiryPost: Extract<InquiryPost, { kind: 'inquiries' }> | undefined
  // Warnings from shaping the body (a rename that replaced a key the body held).
  const shapeLogs: StepLogEntry[] = []

  const baseUrl = `${instanceUrl}/services/data/v60.0/sobjects/${object}`

  if (operation === 'create') {
    url = baseUrl
    method = 'POST'
    resolvedBodyForInput = applyInjectedFields(resolveRecordBody(config, enrichedCtx, template, shapeLogs), config, enrichedCtx)
    bodyStr = JSON.stringify(resolvedBodyForInput)
  } else if (operation === 'update') {
    resolvedRecordId = coerceString(resolveValue(config.record_id ?? '', enrichedCtx))
    if (!resolvedRecordId && !config.skip_when_empty) throw new Error('Salesforce update requires record_id')
    url = `${baseUrl}/${resolvedRecordId}`
    method = 'PATCH'
    const recordBody = resolveRecordBody(config, enrichedCtx, template, shapeLogs)
    // The relay's filter (#2170): nothing to write, or no record to write it to,
    // is a skip, not a send. Judged before injected_fields, which only stamp a
    // write that is happening anyway.
    if (config.skip_when_empty) {
      if (hasNothingToWrite(recordBody)) skipReason = 'nothing_to_write'
      else if (!resolvedRecordId) skipReason = 'no_record_id'
    }
    // A post-answer update carries its own write marker for the read-back
    // (#2023); the walk sets it for that step only, so nothing else is stamped.
    resolvedBodyForInput = skipReason ? recordBody : stampWriteMarker(applyInjectedFields(recordBody, config, enrichedCtx), object, ctx.writeMarker)
    bodyStr = JSON.stringify(resolvedBodyForInput)
  } else if (operation === 'upsert') {
    const extField = config.external_id_field ?? ''
    resolvedExternalIdValue = coerceString(resolveValue(config.external_id_value ?? '', enrichedCtx))
    if (!extField || !resolvedExternalIdValue) throw new Error('Salesforce upsert requires external_id_field and external_id_value')
    url = `${baseUrl}/${extField}/${resolvedExternalIdValue}`
    method = 'PATCH'
    resolvedBodyForInput = applyInjectedFields(resolveRecordBody(config, enrichedCtx, template, shapeLogs), config, enrichedCtx)
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
      // A body that resolves to nothing is nothing to send (#2181): the inquiry
      // body node returns null when a lead has no inquiries to post.
      if (config.skip_when_empty && (resolvedBodyForInput === null || resolvedBodyForInput === undefined)) skipReason = 'nothing_to_write'
      // A credit inquiry post that can write nothing is never sent (#2172, #2169):
      // an empty list is answered 200 and writes nothing, and a missing one is
      // answered 500 before any write. A body the endpoint cannot read at all
      // fails here by name, before any call, rather than as Salesforce's 500.
      if (!skipReason && isCreditInquiryPost(config as unknown as Record<string, unknown>)) {
        const post = inquiryPostOf(resolvedBodyForInput)
        if (post.kind === 'malformed') throw permanentError(`Salesforce credit inquiry post not sent: ${post.reason}. It needs { submissionId, inquiriesJson }, with inquiriesJson the JSON text of { inquiries: [...] }`)
        if (post.kind === 'empty' || post.kind === 'missing_list') skipReason = 'nothing_to_write'
        else inquiryPost = post
      }
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
  const warnLogs: StepLogEntry[] = [
    ...shapeLogs,
    ...(resolvedBodyForInput !== undefined
      ? warnDroppedBodyFields(resolvedBodyForInput, {
          nodeNamespace: node.namespace,
          nodeLabel: node.label,
          traceId: ctx.trigger.trace_id,
        })
      : []),
  ]

  // Built after URL/method so we can include the actual outbound URL the
  // request went to (helpful for upsert / update which embed the record id).
  const resolvedInput: ResolvedStepInput = {
    template,
    resolved: {
      operation,
      object,
      method,
      url,
      body: resolvedBodyForInput,
      record_id: resolvedRecordId,
      external_id_value: resolvedExternalIdValue,
      soql: resolvedSoql,
      ...(skipReason ? { skip_reason: skipReason } : {}),
    },
  }

  // A skipped write makes no Salesforce call at all, not even for a token, and
  // completes the step with its reason, as the relay's filter ended its run
  // (#2170). The output carries `skipped` and `skip_reason`, the keys a skipped
  // partner bid records, so one shape means skipped across node types.
  if (skipReason) {
    console.log(`[salesforce] event=salesforce_write_skipped reason=${skipReason} target=${object || (config.apex_path ?? '')} trace=${ctx.trigger.trace_id}`)
    return {
      output: { skipped: true, skip_reason: skipReason },
      resolvedInput,
      logs: [
        ...warnLogs,
        { level: 'info', message: SKIP_MESSAGES[skipReason], ts: new Date().toISOString() },
      ],
    }
  }

  const tokenStart = Date.now()
  const token = await getSalesforceToken(env, ctx.trigger.org_id, instanceUrl, clientId, clientSecret, { signal })
  const tokenMs = Date.now() - tokenStart

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'X-Trace-Id': ctx.trigger.trace_id,
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
  //
  // A call after the run's answer also takes the post-answer share (#2170), told
  // so by the walk's own fact, and waits at most 3 s so a shed write fails inside
  // the 12 s window. The wait runs on the run's clock, so a test drives it.
  const { gates: bulkheads, waitMs } = salesforceBulkheads(env, ctx.afterAnswer === true)
  const clock = ctx.retryTiming?.clock
  const targetLabel = object || (config.apex_path ?? '')

  const callOpts: SalesforceCallOptions = {
    url,
    method,
    headers,
    bulkheads,
    waitMs,
    ...(clock ? { waitClock: { clock: () => clock.now(), sleep: (ms: number) => clock.sleep(ms) } } : {}),
    signal,
    resolvedInput,
    traceId: ctx.trigger.trace_id,
    operation,
    targetLabel,
    tokenMs,
  }

  // Reported before it goes out, so a write still out after 2 s can be recorded
  // by the walk (#2022). Updates only: no post-answer create or upsert is live.
  const noteUpdate = (body: unknown) => {
    if (operation === 'update' && resolvedRecordId && body && typeof body === 'object' && !Array.isArray(body)) {
      ctx.noteSalesforceRequest?.({ object, record_id: resolvedRecordId, operation: 'update', body: body as Record<string, unknown> })
    }
  }
  noteUpdate(resolvedBodyForInput)
  // A credit inquiry post on a replay or a resume checks first and sends only if
  // its file is missing (#2176). Before the intent record: a post not sent holds none.
  if (inquiryPost && ctx.recovery) {
    const read = async (path: string): Promise<SalesforceRead> => {
      const get: SalesforceCallOptions = { ...callOpts, url: `${instanceUrl}/services/data/v60.0${path}`, method: 'GET', operation: 'query', targetLabel: path.split('?')[0] }
      const attempt = async (): Promise<SalesforceRead> => {
        try {
          const { res, responseText } = await performSalesforceCall(undefined, get)
          return { kind: 'answer', status: res.status, text: responseText }
        } catch (e) {
          return { kind: 'no_answer', error: formatErr(e) }
        }
      }
      const first = await attempt()
      if (first.kind !== 'answer' || first.status !== 401) return first
      // A revoked cached token (#1741): refused before anything ran, so read once
      // more with a fresh login, which the post then goes out with too. A fresh
      // login that fails throws, so the step says the login failed rather than
      // that Salesforce did not answer the read.
      await env.WORKFLOW_CACHE.delete(salesforceTokenCacheKey(ctx.trigger.org_id))
      headers.Authorization = `Bearer ${await getSalesforceToken(env, ctx.trigger.org_id, instanceUrl, clientId, clientSecret, { signal })}`
      return attempt()
    }
    const landed = await checkRecoveredInquiryPost(ctx, ctx.recovery, node.namespace, inquiryPost, read, resolvedInput, warnLogs)
    if (landed) return landed
  }
  // A credit inquiry post is recorded BEFORE it goes out, and this waits for the
  // record, so an isolate cancelled mid call still leaves it (#2172, D5). Its
  // record names the Submission the body is for.
  if (inquiryPost) {
    await ctx.recordSalesforceRequest?.({
      object: 'Submission__c',
      record_id: inquiryPost.submissionId,
      operation: 'apex',
      apex_path: CREDIT_INQUIRY_APEX_PATH,
      body: resolvedBodyForInput as Record<string, unknown>,
    })
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
    headers.Authorization = `Bearer ${await getSalesforceToken(env, ctx.trigger.org_id, instanceUrl, clientId, clientSecret, { signal })}`
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
    const answer: SalesforceAnswer = { status: res.status, text: responseText }
    const err = new Error(summarizeHtmlErrorBody(`Salesforce API error (${res.status}): ${responseText}`)) as Error & { permanent?: boolean; status?: number; mayHaveLanded?: boolean; resolvedInput?: ResolvedStepInput; logs?: StepLogEntry[] } & AnsweredFailure
    err.resolvedInput = resolvedInput
    // The answer's status, typed, so a caller judges the failure without reading the message (#2022).
    err.status = res.status
    err.salesforceAnswer = answer
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
      answer,
      noteBody: noteUpdate,
      // The original error still throws, but the resend may have landed, so it
      // must not read as a clean refusal to the at-risk watch.
      onRetryMayHaveLanded: () => { err.mayHaveLanded = true },
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
      bulkheads,
      waitMs,
      waitClock: callOpts.waitClock,
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
  /** The bulkheads to take a slot of, in order (`salesforceBulkheads`); none, no limit. */
  bulkheads: BulkheadClient[]
  waitMs: number
  /** The clock the slot wait runs on; real time when absent. */
  waitClock?: Pick<AcquireWaitOptions, 'clock' | 'sleep'>
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
 * Whether an error is the bulkhead refusing a Salesforce call before anything
 * was sent (ADR 0005). Read off a mark the call path sets, never the wording.
 * The replay and the drain give the attempt back on it (#468): nothing left, so
 * nothing can have landed, and the row is held rather than spent.
 */
export function isSalesforceBulkheadShed(e: unknown): boolean {
  return e instanceof Error && (e as Error & { bulkheadShed?: unknown }).bulkheadShed === true
}

/**
 * The bulkhead slots for one Salesforce call (ADR 0005, #2170). A key whose
 * Durable Object errors is passed over, every key alike, and said by name, so a
 * fail-open is counted from its own line rather than read off a waited line.
 */
async function takeSalesforceSlots(opts: {
  bulkheads: BulkheadClient[]
  waitMs: number
  waitClock?: Pick<AcquireWaitOptions, 'clock' | 'sleep'>
  signal: AbortSignal | undefined
  traceId: string
}): Promise<HeldSlots> {
  const slots = await acquireSlots(opts.bulkheads, opts.waitMs, { ...opts.waitClock, signal: opts.signal })
  for (const { key, error } of slots.failedOpen) {
    console.log(`[salesforce] event=salesforce_bulkhead_failed_open key=${key} error=${JSON.stringify(error)} trace=${opts.traceId}`)
  }
  return slots
}

/**
 * Salesforce's own answer to a write that failed: its status and its raw text,
 * the page itself where the message only summarises one. A failure carries it
 * only where Salesforce answered the WRITE, never a failed login, whose status
 * is the token endpoint's. The held write capture (#2054) judges it by
 * `salesforceRejectedTheWrite`, as the replay tool (#471) judges its own answer.
 */
export interface SalesforceAnswer {
  status: number
  text: string
}

interface AnsweredFailure {
  salesforceAnswer?: SalesforceAnswer
}

/** The answer a failure carries, or null when Salesforce gave the write none. */
export function salesforceAnswerOf(err: unknown): SalesforceAnswer | null {
  if (!err || typeof err !== 'object') return null
  const a = (err as AnsweredFailure).salesforceAnswer
  return a && typeof a.status === 'number' && typeof a.text === 'string' ? { status: a.status, text: a.text } : null
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
  const now = opts.waitClock?.clock ?? Date.now
  const acquireStart = now()
  const slots = await takeSalesforceSlots(opts)
  const waitedMs = now() - acquireStart
  if (!slots.allowed && slots.refusedBy) {
    const { key, inflight, limit } = slots.refusedBy
    // Distinctive message so an unhandled shed flows through the existing failure
    // + failure-rate Slack alerts without new alert infra.
    console.log(`[salesforce] event=salesforce_bulkhead_shed key=${key} inflight=${inflight} limit=${limit} waited_ms=${waitedMs} trace=${opts.traceId}`)
    const shedErr = new Error(
      `Salesforce bulkhead: at capacity (${key}, ${inflight}/${limit} inflight, waited ${waitedMs}ms)`,
    ) as Error & { resolvedInput?: ResolvedStepInput; bulkheadShed?: true }
    // Not marked permanent/saturated on purpose: classifyStepError defaults an
    // unmarked error to transient, so withRetry retries the shed (see comment above).
    // After the answer it is therefore an unknown outcome, so the at-risk record stays.
    shedErr.resolvedInput = opts.resolvedInput
    // Nothing was sent: the replay and the drain read this (isSalesforceBulkheadShed).
    shedErr.bulkheadShed = true
    throw shedErr
  }
  if (waitedMs > 1000 && slots.granted) {
    // Slot obtained but only after real waiting: saturation is close. Visible in
    // logs so a creeping-toward-capacity trend can be spotted before sheds start.
    const { key, inflight, limit } = slots.granted
    console.log(`[salesforce] event=salesforce_bulkhead_waited key=${key} waited_ms=${waitedMs} inflight=${inflight} limit=${limit} trace=${opts.traceId}`)
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
    // Release the slots whether the call succeeded, failed, or timed out.
    await slots.release()
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
  /** Salesforce's answer to the write, which the no contact rejection still carries (#2054). */
  answer: SalesforceAnswer
  /** Reports the body the retry will send instead (#2022). */
  noteBody: (body: unknown) => void
  /** Called when the retry got a transient answer, so it may have landed (#2022). */
  onRetryMayHaveLanded: () => void
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
    ) as Error & { permanent?: boolean; resolvedInput?: ResolvedStepInput; logs?: StepLogEntry[] } & AnsweredFailure
    err.permanent = true
    err.resolvedInput = resolvedInput
    err.salesforceAnswer = args.answer
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
  args.noteBody(blanked)
  const retry = await performSalesforceCall(JSON.stringify(blanked), { ...callOpts, resolvedInput: retryInput })
  if (!retry.res.ok) {
    // The retry failed too. Say nothing new: the caller throws the ORIGINAL
    // error, so diagnostics never get worse than before this recovery existed.
    console.log(`[salesforce] event=salesforce_field_blanked_retry_failed status=${retry.res.status} trace=${callOpts.traceId}`)
    if (salesforceFailureIsTransient(retry.res.status, retry.responseText)) args.onRetryMayHaveLanded()
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
    bulkheads: BulkheadClient[]
    waitMs: number
    waitClock?: Pick<AcquireWaitOptions, 'clock' | 'sleep'>
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
    bulkheads: BulkheadClient[]
    waitMs: number
    waitClock?: Pick<AcquireWaitOptions, 'clock' | 'sleep'>
    resolvedInput: ResolvedStepInput
  },
): Promise<unknown> {
  // nextRecordsUrl is a path (/services/data/vXX.0/query/01g...-2000), not absolute.
  const url = nextRecordsUrl.startsWith('http') ? nextRecordsUrl : `${opts.instanceUrl}${nextRecordsUrl}`

  const slots = await takeSalesforceSlots(opts)
  if (!slots.allowed && slots.refusedBy) {
    const { key, inflight, limit } = slots.refusedBy
    // Retryable (transient), NOT permanent, same rationale as the main shed
    // above: a shed request never reached SF, so retrying re-enters this gate
    // without adding SF load. Leaving it unmarked lets classifyStepError default
    // it to transient so withRetry rides out a brief slowdown.
    throw Object.assign(
      new Error(`Salesforce bulkhead: at capacity while paging a query (${key}, ${inflight}/${limit} inflight)`),
      { resolvedInput: opts.resolvedInput, bulkheadShed: true as const },
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
    await slots.release()
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

const SKIP_MESSAGES: Record<SalesforceSkipReason, string> = {
  nothing_to_write: 'Skipped the Salesforce write: the body had nothing to write, so no request was sent.',
  no_record_id: 'Skipped the Salesforce write: the record id was empty, so there was no record to write to and no request was sent.',
  already_landed: 'Skipped the credit inquiry post: this run recovers an earlier one, and that run\'s Inquiries file is already on the Lead, so no request was sent.',
}

/**
 * A credit inquiry post on a recovery run checks first and sends only if
 * missing (#2176, Dan, 2026-10-15). A replay or a resume runs every node again
 * from the entry, and a second post that lands attaches a second Inquiries file,
 * so before it posts it looks for the original's file on the Lead, through the
 * read-back's own lookup (lookupInquiryMarker), since the root run of the
 * lineage began (engine/recovery-origin.ts says why that start). First it asks
 * whether the read-back still holds a post of any run of the lineage (Dan,
 * 2026-10-16), and sends nothing while it does.
 *
 * Returns the skipped result when the file is there, nothing when it is not (the
 * post goes out as on any run, intent record first), and throws when the check
 * cannot be answered: fail closed, because a post not sent is said on the step
 * and can be run again, and a second file cannot be taken back. Not a refusal of
 * every recovery run, as buyer_click_send's is (#1542): a post that never landed
 * is sent.
 */
async function checkRecoveredInquiryPost(
  ctx: ExecutionContext,
  recovery: NonNullable<ExecutionContext['recovery']>,
  stepNamespace: string,
  post: Extract<InquiryPost, { kind: 'inquiries' }>,
  read: (path: string) => Promise<SalesforceRead>,
  resolvedInput: ResolvedStepInput,
  logs: StepLogEntry[],
): Promise<StepExecutionResult | undefined> {
  const notSent = (why: string, permanent = false) => {
    const message = `Salesforce credit inquiry post not sent: this is a ${recovery} of an earlier execution, and ${why}`
    console.warn(`[salesforce] event=inquiry_recovery_check_failed recovery=${recovery} trace=${ctx.trigger.trace_id} ${message}`)
    const err = permanent ? permanentError(message, resolvedInput) : Object.assign(new Error(message), { resolvedInput })
    if (logs.length > 0) Object.assign(err, { logs })
    return err
  }
  const unknown = (cause: string) =>
    notSent(`whether its Inquiries file already landed is unknown (${cause}). It is not sent, because a second post attaches a second file; run it again once that can be read.`)
  if (!ctx.recoveryOrigin) throw unknown('the run does not say which execution its lineage began with')
  let origin: RecoveryOrigin
  try {
    origin = await ctx.recoveryOrigin()
  } catch (e) {
    throw unknown(`where its lineage began could not be read: ${formatErr(e)}`)
  }
  // While the read-back still holds a post of the lineage it is that post's one
  // sender (Dan, 2026-10-16): a post sent beside its resend, or beside the original
  // still out, could land a second file. Asked of every run of the chain, by the
  // read-back's own classifier, before anything is read from Salesforce.
  if (!ctx.readBackHolds) throw unknown('the run has no way to ask whether the read-back still holds an earlier post')
  for (const executionId of origin.lineage) {
    let held: boolean
    try {
      held = await ctx.readBackHolds(executionId, stepNamespace)
    } catch (e) {
      throw unknown(`whether the read-back still holds execution ${executionId}'s post could not be read: ${formatErr(e)}`)
    }
    if (held) {
      throw unknown(`the original post is still being settled by the read-back (execution ${executionId}), which reads its file and resends it at most once; a replay after it settles checks again`)
    }
  }
  let looked: InquiryMarkerLookup
  try {
    looked = await lookupInquiryMarker(read, post.submissionId, origin.startedAtMs)
  } catch (e) {
    // The reader answers every read it made; what throws is a fresh login that failed.
    throw unknown(`the check could not be made: ${formatErr(e)}`)
  }
  if (looked.kind === 'unread') {
    throw unknown(looked.read.kind === 'no_answer' ? `no answer reading the ${looked.what}: ${looked.read.error}` : `Salesforce answered ${looked.read.status} reading the ${looked.what}`)
  }
  if (looked.kind === 'unreadable') throw unknown(`reading the ${looked.what} did not answer with what was asked`)
  if (looked.kind === 'no_lead') throw notSent('the Submission has no Lead, so Salesforce refuses the post and writes nothing.', true)
  if (looked.kind === 'absent') {
    console.log(`[salesforce] event=inquiry_recovery_check result=absent recovery=${recovery} recovered_from=${origin.executionId} lead=${looked.leadId} trace=${ctx.trigger.trace_id}`)
    return undefined
  }
  const since = new Date(origin.startedAtMs - INQUIRY_MARKER_MARGIN_MS).toISOString()
  console.log(`[salesforce] event=salesforce_write_skipped reason=already_landed recovery=${recovery} recovered_from=${origin.executionId} lead=${looked.leadId} trace=${ctx.trigger.trace_id}`)
  return {
    output: { skipped: true, skip_reason: 'already_landed' satisfies SalesforceSkipReason, lead_id: looked.leadId, recovered_from: origin.executionId, marker_since: since },
    resolvedInput: { ...resolvedInput, resolved: { ...(resolvedInput.resolved as Record<string, unknown>), skip_reason: 'already_landed' } },
    logs: [...logs, { level: 'info', message: `${SKIP_MESSAGES.already_landed} It found Lead ${looked.leadId}'s file created since ${since}, when execution ${origin.executionId} began, less ${INQUIRY_MARKER_MARGIN_MS / 1000} s.`, ts: new Date().toISOString() }],
  }
}

function permanentError(message: string, resolvedInput?: ResolvedStepInput): Error {
  return Object.assign(new Error(message), { permanent: true, ...(resolvedInput ? { resolvedInput } : {}) })
}

const isPlainRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** How a parsed text body that is not an object is named in the refusal. */
function jsonKind(v: unknown): string {
  if (Array.isArray(v)) return 'an array'
  if (typeof v === 'string') return 'a string'
  if (typeof v === 'number') return 'a number'
  return 'a true or false'
}

/**
 * The record body a create, update or upsert writes, before injected_fields.
 *
 * A string body is rendered by the engine's own template resolution, exactly as
 * the webhook node renders a text body, then parsed as JSON (#2170). So inside
 * quotes a missing reference is `""`, a null is the string `"null"` and a number
 * is a string, which is byte for byte what the Pipedream relay received. A
 * single reference that resolves to an object is used as it is, as before.
 * Rendered text that is not JSON, or JSON that is not an object, fails by name
 * and permanently: sending it would write something nobody configured.
 *
 * Then omit_fields drops keys and rename_fields moves keys to the field they are
 * sent as, in that order, so a rename never resurrects an omitted key. A rename
 * onto a key the body already holds (one it does not itself rename) sends the
 * renamed value, as the relay wrote its renamed fields whatever else the body
 * carried, and a warning naming the replaced field goes on the step through
 * `logs`, so the replaced value is never lost in silence.
 */
function resolveRecordBody(
  config: SalesforceConfig,
  ctx: ExecutionContext,
  template: Record<string, unknown>,
  logs: StepLogEntry[],
): unknown {
  let body = resolveValue(config.body, ctx)
  if (typeof config.body === 'string' && typeof body === 'string') {
    const rendered = body
    const failed = (message: string) =>
      permanentError(message, { template, resolved: { operation: config.operation ?? 'create', object: config.object, body: rendered } })
    try {
      body = JSON.parse(rendered)
    } catch (e) {
      throw failed(`Salesforce body text is not valid JSON once its references are filled in: ${e instanceof Error ? e.message : 'unparseable'}`)
    }
    if (body !== null && !isPlainRecord(body)) {
      throw failed(`Salesforce body text rendered to JSON that is not an object (${jsonKind(body)}), so there is no record to write`)
    }
  }

  if (!isPlainRecord(body) || (!config.omit_fields && !config.rename_fields)) return body
  const shaped: Record<string, unknown> = { ...body }
  for (const field of config.omit_fields ?? []) delete shaped[field]
  const renames = Object.entries(config.rename_fields ?? {})
  // Own keys only: `in` would also find inherited names like toString or constructor.
  const moved = renames.filter(([from]) => Object.hasOwn(shaped, from)).map(([from, to]) => [to, shaped[from]] as const)
  for (const [from] of renames) delete shaped[from]
  for (const [to, value] of moved) {
    if (Object.hasOwn(shaped, to)) {
      const from = renames.find(([, target]) => target === to)?.[0] ?? to
      logs.push({
        level: 'warn',
        message: `rename_fields wrote ${from} onto ${to}, replacing the value the body already held for ${to}.`,
        ts: new Date().toISOString(),
      })
    }
    shaped[to] = value
  }
  return shaped
}

/** Nothing would reach Salesforce: no body, or an object whose every key would be dropped in sending. */
function hasNothingToWrite(body: unknown): boolean {
  if (body === null || body === undefined) return true
  return isPlainRecord(body) && Object.values(body).every((v) => v === undefined)
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
