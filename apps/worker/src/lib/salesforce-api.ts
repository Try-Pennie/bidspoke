/**
 * The Salesforce REST API's request, URL and error classification rules, in one
 * place (#2335, PR 3 of phase 5 of #1689).
 *
 * Moved unchanged out of the Salesforce node (`engine/nodes/salesforce.ts`), so
 * the ops connection path judges a Salesforce answer by exactly the rules the
 * money path does rather than a copy of them (L263, L370). Pure: no fetch, no
 * token, no bulkhead, no logging. The token (`getSalesforceToken`), its KV cache
 * and the bulkhead stay in the node.
 */
import { containsHtmlDocument } from './html-error-summary'

/** The REST API version every Salesforce data call is made on. */
export const SALESFORCE_API_VERSION = 'v60.0'

/** The instance url as configured, less one trailing slash. */
export function salesforceInstanceUrl(raw: string): string {
  return raw.replace(/\/$/, '')
}

/** A data API url: `path` is below `/services/data/v60.0` and starts with a slash. */
export function salesforceDataUrl(instanceUrl: string, path: string): string {
  return `${instanceUrl}/services/data/${SALESFORCE_API_VERSION}${path}`
}

/** An SObject's url, which a create posts to. */
export function salesforceSobjectUrl(instanceUrl: string, object: string): string {
  return salesforceDataUrl(instanceUrl, `/sobjects/${object}`)
}

/** One record's url, which an update patches. The id goes in as it is. */
export function salesforceRecordUrl(instanceUrl: string, object: string, recordId: string): string {
  return `${salesforceSobjectUrl(instanceUrl, object)}/${recordId}`
}

/** The url an upsert patches: the record found by an external id field's value, which goes in as it is. */
export function salesforceUpsertUrl(instanceUrl: string, object: string, externalIdField: string, externalIdValue: string): string {
  return `${salesforceSobjectUrl(instanceUrl, object)}/${externalIdField}/${externalIdValue}`
}

/** A SOQL query's url, the query encoded. */
export function salesforceQueryUrl(instanceUrl: string, soql: string): string {
  return salesforceDataUrl(instanceUrl, `/query?q=${encodeURIComponent(soql)}`)
}

/** An Apex REST path with exactly one leading slash; an empty path is the slash alone. */
export function salesforceApexPath(raw: string): string {
  return raw.replace(/^\/?/, '/')
}

/** An Apex REST url, from a path `salesforceApexPath` has normalised. */
export function salesforceApexUrl(instanceUrl: string, apexPath: string): string {
  return `${instanceUrl}${apexPath}`
}

/** A query's next page: nextRecordsUrl is a path (/services/data/vXX.0/query/01g...-2000), not absolute. */
export function salesforceNextPageUrl(instanceUrl: string, nextRecordsUrl: string): string {
  return nextRecordsUrl.startsWith('http') ? nextRecordsUrl : `${instanceUrl}${nextRecordsUrl}`
}

/** The headers of a data API call. A new object each time, since a caller swaps the token on it. */
export function salesforceRequestHeaders(token: string, traceId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'X-Trace-Id': traceId,
  }
}

/**
 * An answer's body: null when empty (Salesforce returns 204 No Content for a
 * successful update), the parsed JSON, or the text itself when it is not JSON.
 */
export function parseSalesforceResponse(responseText: string): unknown {
  let parsedBody: unknown = null
  if (responseText) {
    try {
      parsedBody = JSON.parse(responseText)
    } catch {
      parsedBody = responseText
    }
  }
  return parsedBody
}

/**
 * Whether Salesforce refused the token rather than the request: a cached token
 * it has revoked or expired answers 401 INVALID_SESSION_ID (#1741). Refused
 * before anything ran, so the request may be sent once more with a fresh login.
 */
export function isSalesforceSessionRejected(status: number): boolean {
  return status === 401
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

export function extractSalesforceErrorCode(body: unknown): string | null {
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
export function extractSalesforceErrorFields(body: unknown): string[] {
  const entries = Array.isArray(body) ? (body as unknown[]) : null
  const first = entries && entries.length > 0 ? entries[0] : body
  if (!first || typeof first !== 'object') return []
  const fields = (first as { fields?: unknown }).fields
  if (!Array.isArray(fields)) return []
  return fields.filter((f): f is string => typeof f === 'string' && f !== '')
}

export function extractSalesforceErrorMessage(body: unknown): string | null {
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

/** A configured Salesforce error: its errorCode, and optionally text its message must contain. */
export interface SalesforceErrorRule {
  code: string
  message_contains?: string
}

/**
 * The first rule a failed answer's body matches: by errorCode AND, when the
 * rule names one, a message substring (trimmed; blank means no substring). The
 * node's `expected_errors` and `transient_errors` are both matched by this.
 */
export function findSalesforceErrorRule<R extends SalesforceErrorRule>(rules: readonly R[], body: unknown): R | undefined {
  const errorCode = extractSalesforceErrorCode(body)
  const message = extractSalesforceErrorMessage(body)
  return rules.find((e) => {
    if (!errorCode || e.code !== errorCode) return false
    const needle = e.message_contains?.trim()
    if (!needle) return true
    return (message ?? '').includes(needle)
  })
}
