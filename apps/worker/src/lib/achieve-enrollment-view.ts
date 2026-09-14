/**
 * Geoff's Equifax figures from Salesforce, stored BESIDE our own rather than instead of them.
 *
 * Ours, in achieve-credit-metrics.ts, describe the consumer's credit profile, which is what
 * Achieve underwrite against: their reason code says "ratio of balance to limit on bank
 * revolving or other rev accts". Salesforce's count a DIFFERENT SET of accounts, which is
 * measured below rather than inferred. WHY they differ is not established: the exclusion
 * fields on the same object (credit union, student loan, cross collateral, excluded creditor)
 * are empty on every submission at this stage, so they cannot be the explanation, even though
 * their names suggest it. Treat the difference as real and unexplained rather than as
 * enrollment exclusions, which is what an earlier version of this comment claimed.
 *
 * Measured 2026-09-14 across the 12 leads sent to Achieve that day, the two disagreed on 9.
 * On the starkest, the credit report held three open revolving accounts totalling 6,370 of
 * 12,650 in one case and 6,091 of 7,500 in another, where Salesforce held 0 of 1,400, which is
 * exactly one of the three accounts. So Salesforce counts a different SET of accounts, not a
 * different total. Replacing ours with these would import Pennie's enrollment rules into a
 * dataset built to predict somebody else's underwriting, while looking more authoritative for
 * carrying Salesforce's name.
 *
 * Read at EXPORT time rather than at send time. The values live durably in Salesforce keyed by
 * a submission id every row already carries, nothing needs them in real time, and reading them
 * here keeps Salesforce off the live lead path entirely.
 */

/** A Salesforce id: 15 or 18 characters of the id alphabet, and nothing else. */
const SALESFORCE_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/

/**
 * The fields read into the stored view. This list IS the contract with the column, so a test
 * asserts the query asks for every one of them: a field added to one and not the other would
 * otherwise be silently absent from the data.
 *
 * DELIBERATELY EXCLUDED, measured across 8,209 submissions created in two days on 2026-09-14,
 * each populated on ZERO of them: EquifaxDebt__c, EquifaxEnrollableBalance__c,
 * EquifaxExcludedCreditorBalance__c, EquifaxCreditUnionBalance__c,
 * EquifaxStudentLoanExclusionBalance__c, EquifaxCrossCollExclusionBal__c,
 * EquifaxAutoDeficiencyBalance__c, EquifaxJointEligibleBalance__c,
 * EquifaxIneligibleDueToBalance__c and EligibleCollectionTotalBalance__c. They appear to fill
 * later in the enrollment lifecycle, for leads that get that far, and a lead sent to Achieve
 * has not. Storing them would have made the column 10 parts null out of 16, where null already
 * means "the record could not be read" and would have stopped meaning anything.
 *
 * The six kept are populated on roughly 6,000 to 6,800 of those 8,209.
 */
export const SUBMISSION_VIEW_FIELDS = [
  'RevolvingTotalBalance__c',
  'RevolvingCreditLimit__c',
  'RevolvingUtilization__c',
  'RevolvingHighBalance__c',
  'CollectionTotalBalance__c',
  'InstallmentTotalBalance__c',
] as const

export type SubmissionView = Record<string, unknown> & { Id: string }

/**
 * Ids are REFUSED rather than escaped. A Salesforce id has a known shape, so anything else is a
 * defect upstream rather than input to sanitise, and quoting it into a WHERE clause is how a
 * stray value becomes a query that means something different.
 */
export function buildSubmissionViewSoql(ids: string[]): string {
  for (const id of ids) {
    if (!SALESFORCE_ID.test(id)) {
      throw new Error(`achieve enrollment view: ${JSON.stringify(id)} is not a Salesforce id`)
    }
  }
  const list = ids.map((id) => `'${id}'`).join(',')
  return `SELECT Id, ${SUBMISSION_VIEW_FIELDS.join(', ')} FROM Submission__c WHERE Id IN (${list})`
}

/**
 * The view for each submission Salesforce returned, keyed by id.
 *
 * A submission missing from the answer is ABSENT from the map rather than present and empty, so
 * a row whose record could not be read stays distinguishable from one whose record held nothing.
 */
export async function readSubmissionView(
  ids: string[],
  query: (soql: string) => Promise<SubmissionView[]>
): Promise<Map<string, SubmissionView>> {
  if (ids.length === 0) return new Map()
  const records = await query(buildSubmissionViewSoql(ids))
  const byId = new Map<string, SubmissionView>()
  for (const record of records) {
    if (record && typeof record.Id === 'string') byId.set(record.Id, record)
  }
  return byId
}
