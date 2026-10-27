/**
 * A Lead follows its customer's newest Submission: `Lead.Submission_Object_ID__c`
 * names it. So when a customer comes back, every earlier Submission's Lead now
 * names the newer visit and carries what that visit wrote, and no write to an
 * earlier Submission can change it. The lead status check counts such a sale as
 * a returning customer rather than backlog (#1525), and the invalid state canary
 * watch counts such a post as having followed a newer Submission rather than as
 * a Lead mismatch (#2396). One rule, here, so the two cannot drift.
 */

/**
 * Whether a Lead's `Submission_Object_ID__c` value names a Submission other than
 * `submissionId`. Compared on the 15 character id, because Salesforce gives an
 * id in either its 15 or its 18 character form. A Lead naming nothing names no
 * other Submission: nothing shows it moved on.
 */
export function leadNamesAnotherSubmission(named: unknown, submissionId: string): boolean {
  return typeof named === 'string' && named !== '' && named.slice(0, 15) !== submissionId.slice(0, 15)
}

/**
 * Whether `named` names `submissionId` itself, on the same 15 character rule. A
 * Lead naming nothing names no Submission. The invalid state canary watch reads
 * a Lead naming its own Submission as one whose Engine ids came from that
 * Submission's first completion (#2485).
 */
export function leadNamesSubmission(named: unknown, submissionId: string): boolean {
  return typeof named === 'string' && named !== '' && named.slice(0, 15) === submissionId.slice(0, 15)
}

/** A Salesforce datetime, `2026-10-23T19:58:24.000+0000`, as milliseconds; null when it is not one. */
function salesforceInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isNaN(ms) ? null : ms
}

/**
 * Whether a Lead's exchange time (`Lead.External_Timestamp__c`) is later than
 * the sale's own (`Submission__c.External_Timestamp__c`): a later exchange
 * re-stamped the Lead, so the customer came back, even where that visit left
 * `Submission_Object_ID__c` naming the sale (2026-10-23, Sub-002781149). A Lead
 * synced from the sale carries the sale's own time (45,777 of 45,781 Tripoint
 * sales measured 2026-10-27), and every real miss on record has a Lead stamped
 * EARLIER than the sale. A time missing or unreadable on either side shows
 * nothing, so it is false and the sale stays counted as waiting. Only the lead
 * status check asks this: the invalid state canary watch asks which Submission a
 * post followed, which the pointer alone answers (L342).
 */
export function leadStampedAfterSale(saleStamp: unknown, leadStamp: unknown): boolean {
  const sale = salesforceInstant(saleStamp)
  const lead = salesforceInstant(leadStamp)
  return sale !== null && lead !== null && lead > sale
}
