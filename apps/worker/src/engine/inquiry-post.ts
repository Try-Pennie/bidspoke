/**
 * The credit inquiry post: what it is, and what its body can write (#2172, Dan's
 * D5 on #1680, 2026-10-15: never resend an inquiry post blind).
 *
 * `POST /services/apexrest/credit-inquiries` is InquiryParserRest in the Pennie
 * org. Read from its class body (Tooling API, 2026-10-15) and measured in #2169:
 *  - it finds the Submission's `Lead__c` (404 when there is no Submission or no
 *    Lead), parses `inquiriesJSON`, and only when the list is NON-EMPTY deletes
 *    the Lead's Inquiry__c rows, inserts the new ones, updates its four counts,
 *    and last attaches a NEW file, `Inquiries_<leadId>`, linked to the Lead. So a
 *    second call that carries inquiries attaches a second file: it is not safe to
 *    repeat, and the engine never retries it, whatever the step's config says;
 *  - an empty list writes nothing and answers 200;
 *  - a missing (or null) list throws inside the class, which answers 500 before
 *    any write. 2,562 of 21,848 live posts in 7 days had no list. A post like that
 *    can never write anything, so it is never sent, nor resent, and its 500 is
 *    never read as "may have landed";
 *  - its catch does not roll back, so a 500 from a failure after the rows are
 *    written leaves rows and counts without the file: an answer of 500 to a post
 *    that carries inquiries is unknown, not a refusal.
 *
 * The marker every successful post carrying inquiries leaves is that file, linked
 * to the Lead, created at or after the call (150 of 150 in #2169). The read-back
 * (lib/salesforce-read-back.ts) judges a held post by it.
 */
import { isSalesforceRecordId } from '../lib/salesforce-names'

export const CREDIT_INQUIRY_APEX_PATH = '/services/apexrest/credit-inquiries'

/** The engine's step default, kept for every step that is not a credit inquiry post. */
const DEFAULT_STEP_RETRIES = 2

/**
 * Salesforce keeps CreatedDate in whole seconds on its own clock. A file created
 * within this before the post began is still read as this post's: the side that
 * never resends a post that may have landed.
 */
export const INQUIRY_MARKER_MARGIN_MS = 2_000

const normalPath = (path: unknown): string =>
  typeof path === 'string' ? `/${path.trim().replace(/^\/+/, '').replace(/\/+$/, '')}` : ''

/** Whether a Salesforce step's config is the credit inquiry post. */
export function isCreditInquiryPost(config: Record<string, unknown> | null | undefined): boolean {
  if (!config || config.operation !== 'apex') return false
  if (config.apex_method === 'GET') return false
  return normalPath(config.apex_path) === CREDIT_INQUIRY_APEX_PATH
}

/**
 * How many times the engine retries a step. A credit inquiry post is never
 * retried by the engine, whatever its config says (#1680 plan point 3): the
 * read-back is the only thing that sends one again, and only after reading
 * Salesforce. Both of the engine's step loops read this, so neither can resend one.
 */
export function stepRetries(node: { type: string; config: Record<string, unknown> }): number {
  if (node.type === 'salesforce' && isCreditInquiryPost(node.config)) return 0
  return (node.config.retries as number) ?? DEFAULT_STEP_RETRIES
}

export type InquiryPost =
  /** Carries inquiries: it writes, and leaves the marker when it lands. */
  | { kind: 'inquiries'; submissionId: string; count: number }
  /** An empty list: answered 200, writes nothing, leaves no marker. Landed by definition. */
  | { kind: 'empty'; submissionId: string }
  /** No list: answered 500 before any write. Nothing to send or resend. */
  | { kind: 'missing_list'; submissionId: string }
  /** Not a body the endpoint can read at all. */
  | { kind: 'malformed'; reason: string }

/** A key of a JSON body read the way Apex reads it into a class: by name, whatever its case. */
function field(body: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : body[key]
}

/** What one credit inquiry post body can write. */
export function inquiryPostOf(body: unknown): InquiryPost {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'malformed', reason: 'the post has no body object' }
  const b = body as Record<string, unknown>
  const submissionId = field(b, 'submissionId')
  if (typeof submissionId !== 'string' || !isSalesforceRecordId(submissionId)) {
    return { kind: 'malformed', reason: 'the post names no Submission record id' }
  }
  const text = field(b, 'inquiriesJson')
  if (typeof text !== 'string' || text.trim() === '') return { kind: 'malformed', reason: 'the post carries no inquiriesJson text' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'malformed', reason: 'its inquiriesJson is not JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'malformed', reason: 'its inquiriesJson is not an object' }
  const list = field(parsed as Record<string, unknown>, 'inquiries')
  if (list === undefined || list === null) return { kind: 'missing_list', submissionId }
  if (!Array.isArray(list)) return { kind: 'malformed', reason: 'its inquiries are not a list' }
  return list.length === 0 ? { kind: 'empty', submissionId } : { kind: 'inquiries', submissionId, count: list.length }
}

/** A SOQL datetime literal, to the second. */
const soqlTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * The query for the post's marker: the `Inquiries_<leadId>` file linked to the
 * Lead and created since the post began. Proved on the org, read only, on
 * 2026-10-15: one row for a Lead's file from that day, none with a later window.
 */
export function inquiryMarkerQuery(leadId: string, sinceMs: number): string {
  if (!isSalesforceRecordId(leadId)) throw new Error('the Lead id is not a record id, so it is not put in a query')
  return (
    `SELECT Id FROM ContentDocumentLink WHERE LinkedEntityId = '${leadId}' AND ContentDocument.Title = 'Inquiries_${leadId}'` +
    ` AND ContentDocument.CreatedDate >= ${soqlTime(sinceMs - INQUIRY_MARKER_MARGIN_MS)}`
  )
}
