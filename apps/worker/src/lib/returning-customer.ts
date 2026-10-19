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
